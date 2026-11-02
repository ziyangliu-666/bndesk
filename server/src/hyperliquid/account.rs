//! A Hyperliquid account read live: the address's socket, and the reads that fill in what it misses. No key anywhere:
//! the exchange gives any address's account to anyone who asks, and nothing here could do more than ask.
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::accounts::{AccountRef, Event, FutDay, TransfersRef};
use crate::fills::FillRec;
use crate::protocol::Side;
use crate::ws::{WsConn, run_ws};

use super::events::{fees, fill_of, num, on_user_message, open_orders, perp_state, spot_state, text, transfer_of};
use super::klines::{candle_read, parse_candles};
use super::names::NamesRef;
use super::public::{keep_pinging, subscribe};
use super::rest::{CLOCK, Info, Reads};
use super::PERP;

/// A perp's fills as `FutDay` keeps them.
type Trades = BTreeMap<i64, (i64, f64, f64, f64)>;

/// A page of a time-ranged read holds at least this many rows when more follow.
const PAGE: usize = 500;

/// What an address's passes remember between runs.
pub struct Passes {
    pub acct: AccountRef,
    pub user: String,
    pub names: NamesRef,
    /// A unified or portfolio margin account, once read: its balance is all on the spot side.
    unified: Rc<Cell<Option<bool>>>,
    /// each sweep of the day's fills starts from when the last one that succeeded started, less a margin
    swept: Cell<i64>,
    skipped: RefCell<HashSet<String>>,
}

impl Passes {
    pub fn new(acct: AccountRef, user: &str, names: NamesRef) -> Self {
        Passes { acct, user: user.into(), names, unified: Rc::default(), swept: Cell::new(0), skipped: RefCell::default() }
    }
}

/// Every row of a time-ranged read from `start` on: the next page starts at the last row's time, as its docs say, and
/// repeats what shares it.
pub async fn read_pages(read: &impl Reads, kind: &str, user: &str, start: i64, end: Option<i64>) -> Result<Vec<Value>> {
    let mut out: Vec<Value> = vec![];
    let mut from = start;
    let mut seen = HashSet::new();
    loop {
        let mut q = json!({"type": kind, "user": user, "startTime": from});
        if let Some(e) = end {
            q["endTime"] = json!(e);
        }
        let r = read.read(q).await?;
        let rows = r.as_array().ok_or_else(|| anyhow!("{kind}: not a list"))?;
        let last = rows.last().and_then(|x| x.get("time")).and_then(Value::as_i64);
        let fresh = rows.iter().filter(|x| seen.insert(x.to_string())).cloned().collect::<Vec<_>>();
        let n = fresh.len();
        out.extend(fresh);
        match last {
            Some(t) if rows.len() >= PAGE && n > 0 && t >= from => from = t,
            _ => return Ok(out),
        }
    }
}

/// Whether the account's balance is all on the spot side: read once a pass until known, then with the fees.
async fn read_abstraction(p: &Passes, read: &impl Reads) -> Result<bool> {
    let r = read.read(json!({"type": "userAbstraction", "user": p.user})).await?;
    let unified = matches!(r.as_str(), Some("unifiedAccount" | "portfolioMargin"));
    p.unified.set(Some(unified));
    Ok(unified)
}

pub async fn perp_pass(p: &Passes, read: &impl Reads) -> Result<()> {
    let unified = match p.unified.get() {
        Some(u) => u,
        None => read_abstraction(p, read).await?,
    };
    let t0 = CLOCK.now();
    let r = read.read(json!({"type": "clearinghouseState", "user": p.user})).await?;
    let ev = perp_state(&p.names.read().expect("names"), &r, r.get("time").and_then(Value::as_i64).unwrap_or(t0), unified)?;
    p.acct.borrow_mut().apply(ev);
    Ok(())
}

pub async fn spot_pass(p: &Passes, read: &impl Reads) -> Result<()> {
    let r = read.read(json!({"type": "spotClearinghouseState", "user": p.user})).await?;
    p.acct.borrow_mut().apply(spot_state(&r)?);
    Ok(())
}

pub async fn orders_pass(p: &Passes, read: &impl Reads) -> Result<()> {
    let r = read.read(json!({"type": "frontendOpenOrders", "user": p.user})).await?;
    let evs = open_orders(&p.names.read().expect("names"), &r)?;
    let mut a = p.acct.borrow_mut();
    for ev in evs {
        a.apply(ev);
    }
    Ok(())
}

pub async fn fees_pass(p: &Passes, read: &impl Reads) -> Result<()> {
    read_abstraction(p, read).await?;
    let r = read.read(json!({"type": "userFees", "user": p.user})).await?;
    let evs = fees(&r, CLOCK.now())?;
    let mut a = p.acct.borrow_mut();
    for ev in evs {
        a.apply(ev);
    }
    Ok(())
}

/// Today's fills and funding, and each perp's price at the day start. Fills come back for every symbol at once, and the
/// funding says its coin. It answers for an address's last 10000 fills, so a busy day is read from the stream and the
/// previous sweep, not from here alone.
pub async fn day_pass(p: &Passes, read: &impl Reads) -> Result<()> {
    let (ds, mut syms, aid, on_fill) = {
        let mut a = p.acct.borrow_mut();
        let ds = a.day_start;
        if ds == 0 {
            return Ok(());
        }
        a.apply(Event::PerpDayStart { ds });
        let mut syms: HashSet<String> = a.positions.iter().filter(|(_, (amt, _))| *amt != 0.0).map(|(s, _)| s.clone()).collect();
        syms.extend(a.traded.iter().filter_map(|k| k.strip_prefix("hl:")).map(String::from));
        syms.extend(a.fut_day.keys().cloned());
        syms.extend(a.perp_symbols.iter().cloned());
        (ds, syms, a.id.clone(), a.on_fill.clone())
    };
    let started = CLOCK.now();
    let from = if p.swept.get() > ds { (p.swept.get() - 15 * 60_000).max(ds) } else { ds };
    let rest_t = CLOCK.now();
    let mut funding: HashMap<String, f64> = HashMap::new();
    for x in read_pages(read, "userFunding", &p.user, ds, None).await? {
        let d = x.get("delta").ok_or_else(|| anyhow!("no delta"))?;
        if d.get("type").and_then(Value::as_str) == Some("funding")
            && let Some((symbol, PERP)) = p.names.read().expect("names").symbol(text(d, "coin")?)
        {
            *funding.entry(symbol.to_string()).or_insert(0.0) += num(d, "usdc")?;
        }
    }
    let mut trades: HashMap<String, Trades> = HashMap::new();
    let mut swept: Vec<FillRec> = vec![];
    for x in read_pages(read, "userFillsByTime", &p.user, from, None).await? {
        let Some((f, perp)) = fill_of(&p.names.read().expect("names"), &aid, &x)? else { continue };
        if f.ts < ds {
            continue;
        }
        if let Some(tid) = perp {
            let sq = if f.side == Side::Buy { f.qty } else { -f.qty };
            let m = p.acct.borrow().market.clone();
            let fee = m.map_or(f.fee, |m| m.borrow_mut().settled(&f.fee_asset, f.fee));
            trades.entry(f.symbol.clone()).or_default().insert(tid, (f.ts, sq, f.price, fee));
        }
        swept.push(f);
    }
    syms.extend(funding.keys().cloned());
    syms.extend(trades.keys().cloned());
    let mut all: Vec<String> = syms.into_iter().collect();
    all.sort();
    for sym in all {
        let mut d = p.acct.borrow().fut_day.get(&sym).cloned().unwrap_or_else(|| FutDay::new(ds));
        d.trades = trades.remove(&sym).unwrap_or_default();
        d.funding = funding.get(&sym).copied().unwrap_or(0.0);
        d.rest_t = rest_t;
        if d.m0.is_none() {
            // it keeps no mark candles: the minute's first trade
            let coin = p.names.read().expect("names").coin(&sym, PERP).map(String::from);
            if let Some(coin) = coin {
                let k = parse_candles(&read.read(candle_read(&coin, "1m", ds, ds)).await?);
                d.m0 = k.first().filter(|k| k.0 == ds).map(|k| k.1);
            }
        }
        p.acct.borrow_mut().apply(Event::PerpDay { symbol: sym, day: d });
    }
    for f in swept {
        on_fill(f);
    }
    p.swept.set(started);
    Ok(())
}

/// Today's money in and out, from the address's ledger. Reading it is what lets the day open: `Transfers::ready`.
pub async fn ledger_pass(p: &Passes, transfers: &TransfersRef, read: &impl Reads) -> Result<()> {
    let ds = p.acct.borrow().day_start;
    if ds == 0 {
        return Ok(());
    }
    let rows = read_pages(read, "userNonFundingLedgerUpdates", &p.user, ds, None).await?;
    let mut t = transfers.borrow_mut();
    for x in &rows {
        add_transfer(p, &mut t, x)?;
    }
    t.pending.remove(&p.user);
    Ok(())
}

fn add_transfer(p: &Passes, t: &mut crate::accounts::Transfers, x: &Value) -> Result<()> {
    match transfer_of(x, &p.user)? {
        Some((id, rec)) => t.add(&id, rec),
        None => {
            let kind = x.get("delta").and_then(|d| d.get("type")).and_then(Value::as_str).unwrap_or("").to_string();
            if p.skipped.borrow_mut().insert(kind.clone()) {
                tracing::info!("{}: ledger rows of kind {kind:?} stay in P&L", p.acct.borrow().id);
            }
        }
    }
    Ok(())
}

type Pass = fn(Rc<Passes>, Info) -> futures_util::future::LocalBoxFuture<'static, Result<()>>;

/// A pass on its period; one that failed is tried again within a minute.
async fn poll(p: Rc<Passes>, read: Info, pass: Pass, every: f64, delay: f64) {
    let feed = p.acct.borrow().rest_feed.clone();
    tokio::time::sleep(Duration::from_secs_f64(delay)).await;
    loop {
        let r = pass(p.clone(), read.clone()).await;
        let wait = match r {
            Ok(()) => {
                feed.borrow_mut().set_up(true, Some(""));
                every
            }
            Err(e) => {
                let d: String = format!("{e:#}").chars().take(200).collect();
                feed.borrow_mut().set_up(false, Some(&d));
                tracing::warn!("{}: {e:#}", p.acct.borrow().id);
                every.min(60.0)
            }
        };
        tokio::time::sleep(Duration::from_secs_f64(wait)).await;
    }
}

/// What an address's socket carries.
pub const USER_FEEDS: [&str; 6] = ["userFills", "orderUpdates", "userFundings", "userNonFundingLedgerUpdates", "clearinghouseState", "spotState"];

async fn user_stream(p: Rc<Passes>, transfers: TransfersRef, url: String) {
    let feed = p.acct.borrow().feeds[0].clone();
    let user = p.user.clone();
    let on_open = async move |ws: &mut WsConn| -> Result<()> {
        for kind in USER_FEEDS {
            ws.send_text(subscribe(kind, "user", &user)?).await?;
        }
        keep_pinging(ws.handle());
        Ok(())
    };
    let f2 = feed.clone();
    let on_msg = move |raw: &str| {
        let Ok(m) = serde_json::from_str::<Value>(raw) else { return };
        match m.get("channel").and_then(Value::as_str) {
            Some("error") => f2.borrow_mut().error = m.get("data").map_or_else(String::new, Value::to_string).chars().take(200).collect(),
            Some("userNonFundingLedgerUpdates") => {
                let mut t = transfers.borrow_mut();
                let rows = m.get("data").and_then(|d| d.get("nonFundingLedgerUpdates")).and_then(Value::as_array);
                // its first message is a snapshot of the address's whole ledger: today's is what the desk keeps
                let ds = p.acct.borrow().day_start;
                for x in rows.into_iter().flatten().filter(|x| ds != 0 && x.get("time").and_then(Value::as_i64).is_some_and(|ts| ts >= ds)) {
                    if let Err(e) = add_transfer(&p, &mut t, x) {
                        tracing::warn!("hyperliquid ledger message: {e:#}");
                    }
                }
            }
            _ => {
                let unified = p.unified.get().unwrap_or(false);
                let names = p.names.read().expect("names");
                if let Err(e) = on_user_message(&mut p.acct.borrow_mut(), &names, &m, CLOCK.now(), unified) {
                    tracing::warn!("hyperliquid user message: {e:#}");
                }
            }
        }
    };
    run_ws(move || url.clone(), feed, on_msg, on_open, None).await;
}

/// Everything read of one account, on one socket and six passes.
pub fn start(acct: &AccountRef, user: &str, names: &NamesRef, read: Info, transfers: &TransfersRef, ws_url: &str, delay: f64) -> Vec<JoinHandle<()>> {
    let p = Rc::new(Passes::new(acct.clone(), user, names.clone()));
    {
        // the exchange's transfer records name it by this
        let mut a = acct.borrow_mut();
        a.email = user.to_string();
        // one socket carries both markets
        a.feeds.truncate(1);
        let id = a.id.clone();
        if let Some(f) = a.feeds.first() {
            f.borrow_mut().name = format!("{id} user");
        }
    }
    transfers.borrow_mut().pending.insert(user.to_string());
    let task = |pass: Pass, every, offset: f64| tokio::task::spawn_local(poll(p.clone(), read.clone(), pass, every, delay + offset));
    let t2 = transfers.clone();
    let p2 = p.clone();
    let r2 = read.clone();
    let ledger = tokio::task::spawn_local(async move {
        let feed = p2.acct.borrow().rest_feed.clone();
        loop {
            let wait = match ledger_pass(&p2, &t2, &r2).await {
                Ok(()) if p2.acct.borrow().day_start != 0 => 60,
                Ok(()) => 1,
                Err(e) => {
                    let d: String = format!("{e:#}").chars().take(200).collect();
                    feed.borrow_mut().set_up(false, Some(&d));
                    30
                }
            };
            tokio::time::sleep(Duration::from_secs(wait)).await;
        }
    });
    vec![
        tokio::task::spawn_local(user_stream(p.clone(), transfers.clone(), ws_url.to_string())),
        ledger,
        task(|p, r| Box::pin(async move { perp_pass(&p, &r).await }), 10.0, 0.0),
        task(|p, r| Box::pin(async move { spot_pass(&p, &r).await }), 10.0, 0.5),
        task(|p, r| Box::pin(async move { orders_pass(&p, &r).await }), 60.0, 1.0),
        task(|p, r| Box::pin(async move { fees_pass(&p, &r).await }), 300.0, 5.0),
        task(|p, r| Box::pin(async move { day_pass(&p, &r).await }), 60.0, 8.0),
    ]
}
