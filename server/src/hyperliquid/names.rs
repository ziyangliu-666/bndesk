//! Names. The desk's symbols are `[A-Z0-9]` and stored for good; the exchange's are not, and differ by market: a perp is
//! its coin (`BTC`, `kPEPE`), a spot pair `@107` or `PURR/USDC`. Here is the only place one becomes the other, so the rest
//! of the desk sees `BTC`, `KPEPE` and `HYPEUSDC`, on `hl` and `hlspot`.
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use serde_json::Value;

use crate::market::{Info, SymbolInfo};
use crate::protocol::Venue;

use super::{PERP, SPOT};

/// An order under this is refused: the exchange's minimum, on every market.
const MIN_NOTIONAL: f64 = 10.0;

#[derive(Debug, Default)]
pub struct Names {
    /// coin -> (desk symbol, market)
    by_coin: HashMap<String, (String, Venue)>,
    /// (market, desk symbol) -> coin
    by_symbol: HashMap<(Venue, String), String>,
    /// coins with a book: a subscription to any other closes the connection
    live: std::collections::HashSet<String>,
}

pub type NamesRef = Arc<RwLock<Names>>;

impl Names {
    pub fn symbol(&self, coin: &str) -> Option<(&str, Venue)> {
        self.by_coin.get(coin).map(|(s, v)| (s.as_str(), *v))
    }

    pub fn coin(&self, symbol: &str, venue: Venue) -> Option<&str> {
        self.by_symbol.get(&(venue, symbol.to_string())).map(String::as_str)
    }

    /// The coin, if it can be subscribed to.
    pub fn live_coin(&self, symbol: &str, venue: Venue) -> Option<&str> {
        self.coin(symbol, venue).filter(|c| self.live.contains(*c))
    }

    fn add(&mut self, coin: &str, symbol: String, venue: Venue, live: bool) {
        self.by_coin.insert(coin.to_string(), (symbol.clone(), venue));
        self.by_symbol.insert((venue, symbol), coin.to_string());
        if live {
            self.live.insert(coin.to_string());
        }
    }

    /// `metaAndAssetCtxs` and `spotMetaAndAssetCtxs` -> what each market lists. Perps delisted stay named, for fills kept.
    /// Builder-deployed perps (`xyz:NVDA`) are in neither, and outcome tokens (`#1`) have no pair: the desk does not read them.
    pub fn read(&mut self, perps: &Value, spots: &Value) -> Info {
        let mut perp = HashMap::new();
        for u in perps.get(0).and_then(|m| m.get("universe")).and_then(Value::as_array).into_iter().flatten() {
            let Some(coin) = u.get("name").and_then(Value::as_str) else { continue };
            let symbol = coin.to_uppercase();
            perp.insert(symbol.clone(), SymbolInfo::new(&symbol, "USDC", MIN_NOTIONAL));
            self.add(coin, symbol, PERP, !u.get("isDelisted").and_then(Value::as_bool).unwrap_or(false));
        }
        let meta = spots.get(0);
        let tokens: HashMap<i64, &str> = meta
            .and_then(|m| m.get("tokens"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|t| Some((t.get("index")?.as_i64()?, t.get("name")?.as_str()?)))
            .collect();
        let mut spot = HashMap::new();
        for u in meta.and_then(|m| m.get("universe")).and_then(Value::as_array).into_iter().flatten() {
            let (Some(coin), Some(pair)) = (u.get("name").and_then(Value::as_str), u.get("tokens").and_then(Value::as_array)) else { continue };
            let [Some(base), Some(quote)] = [0, 1].map(|i| pair.get(i).and_then(Value::as_i64).and_then(|t| tokens.get(&t))) else { continue };
            let symbol = format!("{base}{quote}").to_uppercase();
            if symbol.bytes().all(|b| b.is_ascii_alphanumeric()) && !spot.contains_key(&symbol) {
                spot.insert(symbol.clone(), SymbolInfo::new(&base.to_uppercase(), &quote.to_uppercase(), MIN_NOTIONAL));
                self.add(coin, symbol, SPOT, true);
            }
        }
        Info::from([(PERP, perp), (SPOT, spot)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_desk_never_sees_the_exchanges_spelling() {
        // shapes as the exchange answered them on 2026-11-02
        let perps = json!([{"universe": [
            {"szDecimals": 5, "name": "BTC", "maxLeverage": 40, "marginTableId": 56},
            {"szDecimals": 0, "name": "kPEPE", "maxLeverage": 10},
            {"szDecimals": 1, "name": "OLD", "maxLeverage": 3, "isDelisted": true},
        ], "collateralToken": 0}, []]);
        let spots = json!([{"universe": [
            {"tokens": [1, 0], "name": "PURR/USDC", "index": 0, "isCanonical": true},
            {"tokens": [150, 0], "name": "@107", "index": 107, "isCanonical": false},
            {"tokens": [150, 7], "name": "@207", "index": 207, "isCanonical": false},
        ], "tokens": [
            {"name": "USDC", "index": 0}, {"name": "PURR", "index": 1}, {"name": "HYPE", "index": 150}, {"name": "USDT0", "index": 7},
        ]}, []]);
        let mut n = Names::default();
        let info = n.read(&perps, &spots);
        assert_eq!(info[&PERP]["KPEPE"], SymbolInfo::new("KPEPE", "USDC", 10.0));
        assert_eq!(info[&SPOT]["HYPEUSDC"], SymbolInfo::new("HYPE", "USDC", 10.0));
        assert_eq!(info[&SPOT]["HYPEUSDT0"].quote, "USDT0");
        assert_eq!(n.symbol("kPEPE"), Some(("KPEPE", PERP)));
        assert_eq!(n.symbol("@107"), Some(("HYPEUSDC", SPOT)));
        assert_eq!(n.symbol("PURR/USDC"), Some(("PURRUSDC", SPOT)));
        assert_eq!(n.coin("KPEPE", PERP), Some("kPEPE"));
        assert_eq!(n.coin("HYPEUSDC", SPOT), Some("@107"));
        assert_eq!(n.symbol("xyz:NVDA"), None);
        assert_eq!(n.symbol("#114910"), None);
        // delisted: named, for the fills kept, and not to be subscribed to
        assert_eq!((n.coin("OLD", PERP), n.live_coin("OLD", PERP), n.live_coin("BTC", PERP)), (Some("OLD"), None, Some("BTC")));
        assert_eq!(n.live_coin("NOPE", PERP), None);
    }
}
