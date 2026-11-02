//! Hyperliquid's account JSON (reads and socket messages) into `accounts::Event`s. A number comes as a string, or as a
//! number where its docs' types say so; these shapes are from its published API docs, not checked against an account.
use anyhow::{Result, anyhow};
use serde_json::Value;

use crate::accounts::{Account, Event, Transfer};
use crate::fills::FillRec;
use crate::protocol::{Side, Venue};

use super::names::Names;
use super::{PERP, SPOT};

pub(super) fn num(v: &Value, k: &str) -> Result<f64> {
    match v.get(k).ok_or_else(|| anyhow!("no {k}"))? {
        Value::String(s) => s.trim().parse().map_err(|_| anyhow!("{k}: not a number: {s:?}")),
        Value::Number(n) => n.as_f64().ok_or_else(|| anyhow!("{k}: {n}")),
        o => Err(anyhow!("{k}: not a number: {o}")),
    }
}

pub(super) fn int(v: &Value, k: &str) -> Result<i64> {
    v.get(k).and_then(Value::as_i64).ok_or_else(|| anyhow!("no {k}"))
}

pub(super) fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v.get(k).and_then(Value::as_str).ok_or_else(|| anyhow!("no {k}"))
}

fn side(s: &str) -> Side {
    if s == "B" { Side::Buy } else { Side::Sell }
}

/// One perp margin account: `clearinghouseState` as of `t0`. Positions there have no time of their own. A unified or
/// portfolio margin account keeps its whole balance on the spot side: `unified` says so, and then the wallet here is 0,
/// or it would count twice.
pub fn perp_state(names: &Names, r: &Value, t0: i64, unified: bool) -> Result<Event> {
    let mut upnl = 0.0;
    let mut positions = vec![];
    for row in r.get("assetPositions").and_then(Value::as_array).into_iter().flatten() {
        let p = row.get("position").ok_or_else(|| anyhow!("no position"))?;
        let amt = num(p, "szi")?;
        upnl += num(p, "unrealizedPnl")?;
        if amt != 0.0
            && let Some((symbol, PERP)) = names.symbol(text(p, "coin")?)
        {
            positions.push((symbol.to_string(), amt, num(p, "entryPx")?, t0));
        }
    }
    let total = num(r.get("marginSummary").ok_or_else(|| anyhow!("no marginSummary"))?, "accountValue")?;
    let wallet = if unified { 0.0 } else { total - upnl };
    Ok(Event::PerpSnapshot { t0, wallet, settle: None, upnl, available: num(r, "withdrawable")?, positions })
}

/// `spotClearinghouseState`: every balance, with no update time.
pub fn spot_state(r: &Value) -> Result<Event> {
    let mut rows = vec![];
    for b in r.get("balances").and_then(Value::as_array).into_iter().flatten() {
        let (total, hold) = (num(b, "total")?, num(b, "hold")?);
        rows.push((text(b, "coin")?.to_string(), total - hold, hold));
    }
    Ok(Event::BalancesRead { rows })
}

/// A fill and, on a perp, its trade id. None: on something the desk does not read (a builder's perp, an outcome token).
pub fn fill_of(names: &Names, account: &str, x: &Value) -> Result<Option<(FillRec, Option<i64>)>> {
    let Some((symbol, venue)) = names.symbol(text(x, "coin")?) else { return Ok(None) };
    let (ts, tid) = (int(x, "time")?, int(x, "tid")?);
    // a trade id is the exchange's hash of its two orders: its docs make it unique with the time and the coin
    let mut f = FillRec::new(format!("{account}:{venue}:{symbol}:{ts}:{tid}"), ts, account, symbol, venue, side(text(x, "side")?), num(x, "px")?, num(x, "sz")?);
    f.fee = num(x, "fee")?;   // a negative fee is a maker rebate, in Π with the fill
    f.fee_asset = text(x, "feeToken")?.trim().to_string();
    f.maker = !x.get("crossed").and_then(Value::as_bool).unwrap_or(false);
    Ok(Some((f, (venue == PERP).then_some(tid))))
}

/// An order row of `frontendOpenOrders` or `orderUpdates` -> (market, symbol, id, side, price, left, created). A trigger
/// order is not on the book yet.
#[allow(clippy::type_complexity)]
fn order_of(names: &Names, o: &Value) -> Result<Option<(Venue, String, String, Side, f64, f64, Option<i64>)>> {
    if o.get("isTrigger").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(None);
    }
    let Some((symbol, venue)) = names.symbol(text(o, "coin")?) else { return Ok(None) };
    let id = o.get("oid").ok_or_else(|| anyhow!("no oid"))?.to_string();
    Ok(Some((venue, symbol.to_string(), id, side(text(o, "side")?), num(o, "limitPx")?, num(o, "sz")?, o.get("timestamp").and_then(Value::as_i64))))
}

/// `frontendOpenOrders`: one read, both markets.
pub fn open_orders(names: &Names, r: &Value) -> Result<[Event; 2]> {
    let (mut perp, mut spot) = (vec![], vec![]);
    for o in r.as_array().into_iter().flatten() {
        if let Some((venue, symbol, id, s, price, left, created)) = order_of(names, o)? {
            let row = (symbol, id, s, price, left, true, created);
            if venue == PERP { perp.push(row) } else { spot.push(row) }
        }
    }
    Ok([Event::OpenOrders { venue: PERP, rows: perp }, Event::OpenOrders { venue: SPOT, rows: spot }])
}

/// `userFees`: what the account pays on each market now.
pub fn fees(r: &Value, now: i64) -> Result<[Event; 2]> {
    let fee = |venue, maker: &str, taker: &str| -> Result<Event> {
        Ok(Event::Fee { venue, symbol: "*".into(), maker: num(r, maker)?, taker: num(r, taker)?, now })
    };
    Ok([fee(PERP, "userAddRate", "userCrossRate")?, fee(SPOT, "userSpotAddRate", "userSpotCrossRate")?])
}

/// One message of an account's socket. Its fills' first message repeats what is already known, flagged a snapshot:
/// the desk keeps a fill once, and leaves one from before the day to the day's sweep.
pub fn on_user_message(a: &mut Account, names: &Names, m: &Value, t0: i64, unified: bool) -> Result<()> {
    let data = m.get("data").unwrap_or(&Value::Null);
    let snapshot = data.get("isSnapshot").and_then(Value::as_bool).unwrap_or(false);
    match m.get("channel").and_then(Value::as_str).unwrap_or("") {
        "userFills" => {
            for x in data.get("fills").and_then(Value::as_array).into_iter().flatten() {
                if let Some((fill, perp_trade)) = fill_of(names, &a.id, x)?
                    && a.day_start != 0
                    && fill.ts >= a.day_start
                {
                    a.apply(Event::Fill { fill: Box::new(fill), perp_trade });
                }
            }
        }
        "orderUpdates" => {
            for u in data.as_array().into_iter().flatten() {
                let o = u.get("order").ok_or_else(|| anyhow!("no order"))?;
                if let Some((venue, symbol, id, s, price, left, created)) = order_of(names, o)? {
                    let open = u.get("status").and_then(Value::as_str) == Some("open");
                    a.apply(Event::Order { venue, symbol, id, side: s, price, left, open, created });
                }
            }
        }
        "userFundings" if !snapshot => {
            for x in data.get("fundings").and_then(Value::as_array).into_iter().flatten() {
                if let Some((symbol, PERP)) = names.symbol(text(x, "coin")?) {
                    a.apply(Event::Funding { t: int(x, "time")?, symbol: symbol.to_string(), amount: num(x, "usdc")? });
                }
            }
        }
        "clearinghouseState" => {
            let s = data.get("clearinghouseState").ok_or_else(|| anyhow!("no clearinghouseState"))?;
            a.apply(perp_state(names, s, t0, unified)?);
        }
        "spotState" => {
            let s = data.get("spotState").ok_or_else(|| anyhow!("no spotState"))?;
            a.apply(spot_state(s)?);
        }
        _ => {}
    }
    Ok(())
}

/// A ledger row as a transfer, for the account at address `me`: (id, record). Both sides of a transfer between two of
/// the desk's accounts read the same row, so its id makes it one record, and it nets. None: not money moved in or out,
/// so it stays in P&L, where the rest of Other is (a liquidation, a reward, a leader's commission), or a kind its docs
/// do not list.
pub fn transfer_of(x: &Value, me: &str) -> Result<Option<(String, Transfer)>> {
    let d = x.get("delta").ok_or_else(|| anyhow!("no delta"))?;
    let kind = text(d, "type")?;
    let party = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or("").to_lowercase();
    let usdc = || num(d, "usdc");
    let (frm, to, asset, amount) = match kind {
        "deposit" => (String::new(), me.to_string(), "USDC".to_string(), usdc()?),
        "withdraw" => (me.to_string(), String::new(), "USDC".to_string(), usdc()?),
        "internalTransfer" | "subAccountTransfer" => (party("user"), party("destination"), "USDC".to_string(), usdc()?),
        "spotTransfer" | "send" => (party("user"), party("destination"), text(d, "token")?.to_string(), num(d, "amount")?),
        // between its own two sides, both of which the desk reads: no money moved
        "accountClassTransfer" => (me.to_string(), me.to_string(), "USDC".to_string(), usdc()?),
        "vaultCreate" | "vaultDeposit" => (me.to_string(), party("vault"), "USDC".to_string(), usdc()?),
        "vaultDistribution" => (party("vault"), me.to_string(), "USDC".to_string(), usdc()?),
        "vaultWithdraw" => (party("vault"), me.to_string(), "USDC".to_string(), num(d, "netWithdrawnUsd")?),
        _ => return Ok(None),
    };
    let ts = int(x, "time")?;
    let id = format!("{ts}:{}:{kind}:{asset}:{amount}", text(x, "hash")?);
    Ok(Some((id, Transfer { ts, frm, to, asset, amount, usd: None })))
}
