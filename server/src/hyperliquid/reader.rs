//! An account read once, for `desk repair-day`.
use futures_util::FutureExt;
use serde_json::{Value, json};

use crate::connector::{AccountReader, Balances, PerpTrade, Reply};
use crate::protocol::Side;

use super::account::read_pages;
use super::events::{fill_of, num, text};
use super::names::NamesRef;
use super::rest::{Info, Reads};
use super::PERP;

pub struct Reader {
    pub read: Info,
    pub user: String,
    pub names: NamesRef,
}

impl AccountReader for Reader {
    fn balances(&self) -> Reply<'_, Balances> {
        async move {
            let r = self.read.read(json!({"type": "spotClearinghouseState", "user": self.user})).await?;
            let mut rows = vec![];
            for b in r.get("balances").and_then(Value::as_array).into_iter().flatten() {
                rows.push((text(b, "coin")?.to_string(), num(b, "total")?));
            }
            Ok(Balances { updated: None, rows })
        }
        .boxed_local()
    }

    fn perp_positions(&self) -> Reply<'_, Vec<(String, f64)>> {
        async move {
            let r = self.read.read(json!({"type": "clearinghouseState", "user": self.user})).await?;
            let names = self.names.read().expect("names");
            let mut out = vec![];
            for row in r.get("assetPositions").and_then(Value::as_array).into_iter().flatten() {
                let p = row.get("position").ok_or_else(|| anyhow::anyhow!("no position"))?;
                if let Some((symbol, PERP)) = names.symbol(text(p, "coin")?) {
                    out.push((symbol.to_string(), num(p, "szi")?));
                }
            }
            Ok(out)
        }
        .boxed_local()
    }

    fn perp_trades<'a>(&'a self, symbol: &'a str, from: i64) -> Reply<'a, Vec<PerpTrade>> {
        async move {
            let mut out = vec![];
            for x in read_pages(&self.read, "userFillsByTime", &self.user, from, None).await? {
                let names = self.names.read().expect("names");
                let Some((f, Some(_))) = fill_of(&names, "", &x)? else { continue };
                if f.symbol == symbol {
                    out.push(PerpTrade { ts: f.ts, sq: if f.side == Side::Buy { f.qty } else { -f.qty }, price: f.price, fee: f.fee, fee_asset: f.fee_asset });
                }
            }
            Ok(out)
        }
        .boxed_local()
    }

    fn perp_funding<'a>(&'a self, symbol: &'a str, from: i64, to: i64) -> Reply<'a, Vec<(i64, f64)>> {
        async move {
            let mut out = vec![];
            for x in read_pages(&self.read, "userFunding", &self.user, from, Some(to)).await? {
                let d = x.get("delta").ok_or_else(|| anyhow::anyhow!("no delta"))?;
                let names = self.names.read().expect("names");
                if d.get("type").and_then(Value::as_str) == Some("funding") && names.symbol(text(d, "coin")?) == Some((symbol, PERP)) {
                    out.push((super::events::int(&x, "time")?, num(d, "usdc")?));
                }
            }
            Ok(out)
        }
        .boxed_local()
    }
}
