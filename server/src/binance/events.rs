//! Binance's account JSON (REST snapshots, user-stream events) read into `accounts::Event`s.
use anyhow::{Result, anyhow};
use serde_json::Value;

use crate::accounts::{Account, Event, Move};
use crate::clock::now_ms;
use crate::fills::FillRec;
use crate::protocol::Venue;

use super::json::{f, f_or0, first, get, id_str, int_or, s, side_of, to_f, to_i, truthy};

/// Order states that leave an order resting.
pub(super) const OPEN_STATES: [&str; 2] = ["NEW", "PARTIALLY_FILLED"];

fn fill_of(a: &Account, venue: Venue, sym: &str, trade: &Value, side: &Value, x: &Value) -> Result<FillRec> {
    let mut fr = FillRec::new(format!("{}:{venue}:{sym}:{}", a.id, id_str(trade)), to_i(get(x, "T")?)?, a.id.clone(), sym, venue,
                              side_of(side.as_str().ok_or_else(|| anyhow!("S: not a string"))?), f(x, "L")?, f(x, "l")?);
    fr.fee = f_or0(x, "n")?;
    fr.fee_asset = first(x, &["N"]).and_then(Value::as_str).unwrap_or("").to_string();
    Ok(fr)
}

/// REST /api/v3/account: every balance as of its updateTime.
pub fn apply_spot_snapshot(a: &mut Account, r: &Value) -> Result<()> {
    let u = int_or(r, &["updateTime"], 0)?;
    let mut rows = std::collections::HashMap::new();
    for b in get(r, "balances")?.as_array().ok_or_else(|| anyhow!("balances: not a list"))? {
        rows.insert(s(b, "asset")?.to_string(), (f(b, "free")?, f(b, "locked")?));
    }
    a.apply(Event::BalanceSnapshot { u, rows });
    Ok(())
}

/// A spot user-stream event.
pub fn on_spot_event(a: &mut Account, e: &Value) -> Result<()> {
    match e.get("e").and_then(Value::as_str) {
        Some("outboundAccountPosition") => {
            // absolute free / locked of the assets that changed, as of u
            let u = int_or(e, &["u", "E"], 0)?;
            let mut rows = vec![];
            for b in get(e, "B")?.as_array().ok_or_else(|| anyhow!("B: not a list"))? {
                rows.push((s(b, "a")?.to_string(), f(b, "f")?, f(b, "l")?));
            }
            a.apply(Event::Balances { u, rows });
        }
        Some("balanceUpdate") => {
            // a transfer in or out, seconds before the transfer history shows it
            let t = int_or(e, &["T", "E"], 0)?;
            let t = if t != 0 { t } else { now_ms() };
            a.apply(Event::Move(Move::new(t, s(e, "a")?, f(e, "d")?)));
        }
        Some("executionReport") => {
            let x = s(e, "x")?;
            if x == "NEW" {
                let t = int_or(e, &["E"], 0)?;
                a.apply(Event::OrderPlaced { t: if t != 0 { t } else { now_ms() } });
            }
            let sym = s(e, "s")?;
            let created = first(e, &["O"]).map(to_i).transpose()?;
            a.apply(Event::Order {
                venue: Venue::SPOT,
                symbol: sym.to_string(),
                id: id_str(get(e, "i")?),
                side: side_of(s(e, "S")?),
                price: f(e, "p")?,
                left: f(e, "q")? - f(e, "z")?,
                open: OPEN_STATES.contains(&s(e, "X")?),
                created,
            });
            if x == "TRADE" {
                let mut fill = fill_of(a, Venue::SPOT, sym, get(e, "t")?, get(e, "S")?, e)?;
                fill.maker = truthy(get(e, "m")?);
                a.apply(Event::Fill { fill: Box::new(fill), perp_trade: None });
            }
        }
        _ => {}
    }
    Ok(())
}

/// A USD-M user-stream event.
pub fn on_fut_event(a: &mut Account, e: &Value) -> Result<()> {
    match e.get("e").and_then(Value::as_str) {
        Some("ORDER_TRADE_UPDATE") => {
            let o = get(e, "o")?;
            let sym = s(o, "s")?;
            let created = first(e, &["T"]).map(to_i).transpose()?;
            let venue = a.perp;
            a.apply(Event::Order {
                venue,
                symbol: sym.to_string(),
                id: id_str(get(o, "i")?),
                side: side_of(s(o, "S")?),
                price: f(o, "p")?,
                left: f(o, "q")? - f(o, "z")?,
                open: OPEN_STATES.contains(&s(o, "X")?),
                created,
            });
            if s(o, "x")? == "TRADE" {
                let mut fill = fill_of(a, venue, sym, get(o, "t")?, get(o, "S")?, o)?;
                fill.maker = o.get("m").is_some_and(truthy);
                a.apply(Event::Fill { fill: Box::new(fill), perp_trade: Some(to_i(get(o, "t")?)?) });
            }
        }
        Some("ACCOUNT_UPDATE") => {
            let d = get(e, "a")?;
            let u = int_or(e, &["T", "E"], 0)?;
            let empty = vec![];
            let bs = d.get("B").and_then(Value::as_array).unwrap_or(&empty);
            let reason = d.get("m").and_then(Value::as_str);
            let funding = if reason == Some("FUNDING_FEE") {
                Some(bs.iter()
                    .filter(|b| matches!(b.get("a").and_then(Value::as_str), Some("USDT" | "USDC")))
                    .map(|b| f_or0(b, "bc"))
                    .sum::<Result<f64>>()?)
            } else {
                None
            };
            let mut moves = vec![];
            if !matches!(reason, Some("ORDER" | "FUNDING_FEE")) {
                // transfers: "bc" is the wallet change apart from P&L
                for b in bs {
                    let bc = f_or0(b, "bc")?;
                    if bc != 0.0 {
                        moves.push((s(b, "a")?.to_string(), bc));
                    }
                }
            }
            let mut settle = None;
            for b in bs {
                if b.get("a").and_then(Value::as_str) == Some("USDT") {
                    settle = Some(f(b, "wb")?);
                }
            }
            let mut positions = vec![];
            for p in d.get("P").and_then(Value::as_array).unwrap_or(&empty) {
                if matches!(p.get("ps").and_then(Value::as_str).unwrap_or("BOTH"), "BOTH" | "LONG" | "SHORT") {
                    positions.push((s(p, "s")?.to_string(), f(p, "pa")?, f(p, "ep")?));
                }
            }
            a.apply(Event::PerpUpdate { u, funding, moves, settle, positions });
        }
        _ => {}
    }
    Ok(())
}

/// REST /fapi/v3/account, requested at t0 (server clock).
pub fn apply_fut_snapshot(a: &mut Account, r: &Value, t0: i64) -> Result<()> {
    let empty = vec![];
    let usdt = r
        .get("assets")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .find(|x| x.get("asset").and_then(Value::as_str) == Some("USDT"));
    let settle = match usdt {
        Some(usdt) => Some((f(usdt, "walletBalance")?, int_or(usdt, &["updateTime"], 0)?)),
        None => None,
    };
    let mut positions = vec![];
    for p in r.get("positions").and_then(Value::as_array).unwrap_or(&empty) {
        let amt = f(p, "positionAmt")?;
        if amt != 0.0 {
            let upnl = match p.get("unrealizedProfit").or_else(|| p.get("unRealizedProfit")) {
                Some(v) => to_f(v)?,
                None => 0.0,
            };
            let notional = f(p, "notional")?;
            positions.push((s(p, "symbol")?.to_string(), amt, (notional - upnl) / amt, int_or(p, &["updateTime"], 0)?));
        }
    }
    a.apply(Event::PerpSnapshot {
        t0,
        wallet: f(r, "totalWalletBalance")?,
        settle,
        upnl: f(r, "totalUnrealizedProfit")?,
        available: f(r, "availableBalance")?,
        positions,
    });
    Ok(())
}
