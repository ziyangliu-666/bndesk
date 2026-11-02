//! A Binance account read live: the user streams and the REST passes that fill in what they miss, each reported to the
//! account as `Event`s. No key of its own: balances and futures through the master's sub-account endpoints.
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::accounts::{AccountRef, Dividend, Event, FutDay, Transfer, TransfersRef};
use crate::connector::RestError;
use crate::feeds::FeedRef;
use crate::fills::FillRec;
use crate::params;
use crate::protocol::{Role, Side, Venue};
use crate::sign::query;

use super::events::{OPEN_STATES, apply_fut_snapshot, apply_spot_snapshot, on_fut_event, on_spot_event};
use super::json::{f, f_or0, first, get, id_str, s, side_of, to_f, to_i, truthy};
use super::public::order_limits;
use super::rest::{CLOCK, Params, Rest, RestGet};
use super::ws::{USDM_PRIVATE, WS_API, WsConn, WsHandle, run_ws, ws_api_call};

/// What an account's REST passes remember between runs.
pub struct Passes {
    pub acct: AccountRef,
    /// each spot symbol's fills are swept from when its last sweep that succeeded started (ms)
    trades_upto: RefCell<HashMap<String, i64>>,
    fee_turn: Cell<usize>,
    /// ms, by `Venue::index()`: each market's next per-symbol commission lookup
    fee_next: Cell<[i64; Venue::COUNT]>,
}

impl Passes {
    pub fn new(acct: AccountRef) -> Self {
        Passes { acct, trades_upto: RefCell::default(), fee_turn: Cell::new(0), fee_next: Cell::new([0; Venue::COUNT]) }
    }

    /// The next commission lookup of every market is due.
    pub fn commissions_due(&self) {
        self.fee_next.set([0; Venue::COUNT]);
    }

    pub fn next_commission(&self, venue: Venue) -> i64 {
        self.fee_next.get()[venue.index()]
    }
}

/// Python `f"{type(e).__name__}: {e}"[:200]`.
fn err_text(e: &anyhow::Error) -> String {
    let s = if e.downcast_ref::<RestError>().is_some() { format!("RestError: {e}") } else { format!("{e:#}") };
    s.chars().take(200).collect()
}

#[derive(Clone, Copy, Debug)]
enum Job {
    SpotAccount,
    RateLimits,
    OpenOrders,
    Commissions,
    FutAccount,
    FutToday,
    SpotTrades,
    Dividends,
    MasterSpot,
    MasterFut,
}

async fn run_job(job: Job, p: &Passes, rest: &Rest) -> Result<()> {
    let acct = &p.acct;
    match job {
        Job::SpotAccount => spot_account(acct, rest).await,
        Job::RateLimits => rate_limits(acct, rest).await,
        Job::OpenOrders => open_orders(acct, rest).await,
        Job::Commissions => commissions(p, rest).await,
        Job::FutAccount => fut_account(acct, rest).await,
        Job::FutToday => fut_today(acct, rest).await,
        Job::SpotTrades => spot_trades(p, rest).await,
        Job::Dividends => dividends(acct, rest).await,
        Job::MasterSpot => master_spot(acct, rest).await,
        Job::MasterFut => master_fut(acct, rest).await,
    }
}

async fn poll(p: Rc<Passes>, rest: Rest, job: Job, every: f64, delay: f64) {
    let acct = p.acct.clone();
    tokio::time::sleep(Duration::from_secs_f64(delay)).await;
    loop {
        let r = run_job(job, &p, &rest).await;
        let feed = acct.borrow().rest_feed.clone();
        match r {
            Ok(()) => feed.borrow_mut().set_up(true, Some("")),
            Err(e) => {
                feed.borrow_mut().set_up(false, Some(&err_text(&e)));
                if matches!(job, Job::SpotTrades | Job::FutToday | Job::Dividends) {
                    // the passes that fill in the day's records: a failure leaves the day short
                    tracing::warn!("{} {job:?}: {e:#}", acct.borrow().id);
                }
                // a failed pass is tried again within a minute, not after its full period
                tokio::time::sleep(Duration::from_secs_f64(every.min(60.0))).await;
                continue;
            }
        }
        tokio::time::sleep(Duration::from_secs_f64(every)).await;
    }
}

/// The account's own key: user streams and REST polls, as `spawn_local` tasks (abort to stop).
/// `rest` carries the account's credentials and its `rest_feed`.
pub fn start(acct: &AccountRef, rest: Rest) -> Vec<JoinHandle<()>> {
    let (has_creds, futures) = {
        let a = acct.borrow();
        (a.creds.is_some(), a.cfg.futures())
    };
    if !has_creds {
        return vec![];
    }
    let passes = Rc::new(Passes::new(acct.clone()));
    let p = |job, every, delay| tokio::task::spawn_local(poll(passes.clone(), rest.clone(), job, every, delay));
    let mut tasks = vec![
        tokio::task::spawn_local(spot_user(acct.clone())),
        p(Job::SpotAccount, 15.0, 0.0),
        p(Job::RateLimits, 15.0, 0.0),
        p(Job::OpenOrders, 60.0, 0.0),
        p(Job::Commissions, 60.0, 5.0),
        p(Job::SpotTrades, 600.0, 20.0),
        p(Job::Dividends, 300.0, 30.0),
    ];
    if futures {
        tasks.push(tokio::task::spawn_local(fut_user(acct.clone(), rest.clone())));
        tasks.push(p(Job::FutAccount, 10.0, 0.0));
        tasks.push(p(Job::FutToday, 60.0, 8.0));
    }
    tasks
}

/// Today's spot fills from REST, for those the user stream did not deliver (the monitor down or the
/// stream dropping): each tracked or traded symbol from where its last sweep reached, less 15 min. The
/// fill ids are the stream's, so a fill already seen is not added twice. Each symbol keeps its own progress: a
/// request that fails is tried again twice, then the sweep goes on to the next symbol and the error is
/// returned at the end (the poll retries within a minute), so one bad answer never holds back the rest.
pub async fn spot_trades(p: &Passes, rest: &impl RestGet) -> Result<()> {
    let acct = &p.acct;
    let (ds, syms, id, on_fill) = {
        let a = acct.borrow();
        if a.day_start == 0 {
            return Ok(());
        }
        let mut syms: Vec<String> = a.spot_symbols.clone();
        syms.extend(a.traded.iter().filter_map(|k| k.strip_prefix("spot:")).map(String::from));
        syms.sort();
        syms.dedup();
        (a.day_start, syms, a.id.clone(), a.on_fill.clone())
    };
    let mut failed: Vec<String> = vec![];
    let mut first_err = None;
    for sym in syms {
        let from = {
            let a = acct.borrow();
            if a.day_start != ds {
                return Ok(());   // the day rolled while sweeping
            }
            match p.trades_upto.borrow().get(&sym) {
                Some(&u) if u > ds => (u - 15 * 60_000).max(ds),
                _ => ds,
            }
        };
        let started = CLOCK.now();
        let mut start = from;
        let mut tries = 0;
        let ok = loop {
            let q: Params = params!["symbol" => sym, "startTime" => start, "limit" => 1000];
            let r = match rest.get_json("/api/v3/myTrades", &q, 20, true).await {
                Ok(r) => r,
                Err(e) => {
                    tries += 1;
                    let refused = e.downcast_ref::<RestError>().is_some_and(|re| (400..500).contains(&re.status));
                    if refused || tries >= 3 {
                        first_err.get_or_insert(e);
                        break false;
                    }
                    tokio::time::sleep(Duration::from_secs(2 * tries)).await;
                    continue;
                }
            };
            let rows = r.as_array().ok_or_else(|| anyhow!("myTrades: not a list"))?;
            for x in rows {
                let ts = to_i(get(x, "time")?)?;
                if ts < ds {
                    continue;
                }
                let side = if truthy(get(x, "isBuyer")?) { Side::Buy } else { Side::Sell };
                let mut fr = FillRec::new(format!("{id}:spot:{sym}:{}", id_str(get(x, "id")?)), ts, id.clone(), &sym,
                                          Venue::SPOT, side, f(x, "price")?, f(x, "qty")?);
                fr.fee = f_or0(x, "commission")?;
                fr.fee_asset = first(x, &["commissionAsset"]).and_then(Value::as_str).unwrap_or("").to_string();
                fr.maker = truthy(get(x, "isMaker")?);
                on_fill(fr);
            }
            match rows.last() {
                Some(last) if rows.len() >= 1000 => start = to_i(get(last, "time")?)? + 1,
                _ => break true,
            }
        };
        if acct.borrow().day_start != ds {
            return Ok(());
        }
        if ok {
            p.trades_upto.borrow_mut().insert(sym, started);
        } else {
            failed.push(sym);
        }
    }
    match first_err {
        Some(e) => Err(e.context(format!("myTrades of {} not swept: {}", failed.len(), failed.join(", ")))),
        None => Ok(()),
    }
}

fn distribution(x: &Value) -> Result<(String, Dividend)> {
    let info = first(x, &["enInfo"]).and_then(Value::as_str).unwrap_or("").to_string();
    Ok((id_str(get(x, "id")?), Dividend {
        ts: to_i(get(x, "divTime")?)?,
        asset: s(x, "asset")?.to_string(),
        amount: f(x, "amount")?,
        rebate: is_rebate(&info),
        info,
    }))
}

/// A market-maker rebate ("Spot MM Rebate-Spot 26-10-15 07:00") among the distributions, by its description.
pub fn is_rebate(info: &str) -> bool {
    info.contains("MM Rebate")
}

/// Today's asset distributions (the hourly market-maker rebate among them), the whole day each time: a day
/// holds a row an hour per kind, so one request of weight 10 every few minutes; the first one backfills.
pub async fn dividends(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let ds = acct.borrow().day_start;
    if ds == 0 {
        return Ok(());   // the desk has not set the day yet
    }
    let q: Params = params!["startTime" => ds, "endTime" => CLOCK.now(), "limit" => 500];
    let r = rest.get_json("/sapi/v1/asset/assetDividend", &q, 10, true).await?;
    let mut a = acct.borrow_mut();
    if a.day_start != ds {
        return Ok(());   // the day rolled while asking
    }
    for x in r.get("rows").and_then(Value::as_array).into_iter().flatten() {
        let (id, row) = distribution(x)?;
        a.apply(Event::Distribution { id, row });
    }
    Ok(())
}

/// The distributions credited in [from, to), for a past day.
pub async fn distributions(rest: &impl RestGet, from: i64, to: i64) -> Result<Vec<(String, Dividend)>> {
    let q: Params = params!["startTime" => from, "endTime" => to - 1, "limit" => 500];
    let r = rest.get_json("/sapi/v1/asset/assetDividend", &q, 10, true).await?;
    r.get("rows").and_then(Value::as_array).into_iter().flatten().map(distribution).collect()
}

/// No key of its own: `master_rest` carries the master's credentials and this account's `rest_feed`.
pub fn start_via_master(acct: &AccountRef, master_rest: Rest, delay: f64) -> Vec<JoinHandle<()>> {
    let p = Rc::new(Passes::new(acct.clone()));
    vec![
        tokio::task::spawn_local(poll(p.clone(), master_rest.clone(), Job::MasterSpot, 30.0, delay)),
        tokio::task::spawn_local(poll(p, master_rest, Job::MasterFut, 30.0, delay + 2.0)),
    ]
}

pub async fn master_spot(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let email = acct.borrow().email.clone();
    let r = rest.get_json("/sapi/v3/sub-account/assets", &params!["email" => email], 60, true).await?;
    let mut rows = vec![];
    for b in get(&r, "balances")?.as_array().ok_or_else(|| anyhow!("balances: not a list"))? {
        rows.push((s(b, "asset")?.to_string(), f(b, "free")?, f(b, "locked")?));
    }
    acct.borrow_mut().apply(Event::BalancesRead { rows });
    Ok(())
}

pub async fn master_fut(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let email = acct.borrow().email.clone();
    let q: Params = params!["email" => email, "futuresType" => 1];
    let r = rest.get_json("/sapi/v2/sub-account/futures/account", &q, 10, true).await?;
    let a = get(&r, "futureAccountResp")?;
    let wallet = f(a, "totalWalletBalance")?;
    let upnl = f(a, "totalUnrealizedProfit")?;
    let avail = match a.get("maxWithdrawAmount").or_else(|| a.get("availableBalance")) {
        Some(v) => to_f(v)?,
        None => 0.0,
    };
    acct.borrow_mut().apply(Event::PerpTotalsRead { wallet, upnl, available: avail });
    let r = rest.get_json("/sapi/v2/sub-account/futures/positionRisk", &q, 10, true).await?;
    let mut rows = vec![];
    if let Some(ps) = r.get("futurePositionRiskVOS").and_then(Value::as_array) {
        for p in ps {
            let amt = f(p, "positionAmount")?;
            if amt != 0.0 {
                rows.push((s(p, "symbol")?.to_string(), amt, f(p, "entryPrice")?));
            }
        }
    }
    acct.borrow_mut().apply(Event::PerpPositionsRead { rows });
    Ok(())
}

pub async fn spot_account(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let r = rest.get_json("/api/v3/account", &params!["omitZeroBalances" => "true"], 20, true).await?;
    let mut a = acct.borrow_mut();
    apply_spot_snapshot(&mut a, &r)?;
    if let Some(c) = first(&r, &["commissionRates"]) {
        a.apply(Event::Fee { venue: Venue::SPOT, symbol: "*".into(), maker: f(c, "maker")?, taker: f(c, "taker")?, now: CLOCK.now() });
    }
    Ok(())
}

pub async fn fut_account(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let t0 = CLOCK.now();
    let r = rest.get_json("/fapi/v3/account", &[], 5, true).await?;
    apply_fut_snapshot(&mut acct.borrow_mut(), &r, t0)
}

/// Today's futures fills, funding and each symbol's mark at the day start, from REST: complete
/// across monitor restarts, unlike the user stream.
pub async fn fut_today(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let (ds, syms, market, aid, on_fill) = {
        let mut a = acct.borrow_mut();
        let ds = a.day_start;
        if ds == 0 {
            return Ok(());
        }
        a.apply(Event::PerpDayStart { ds });
        let mut syms: HashSet<String> =
            a.positions.iter().filter(|(_, (amt, _))| *amt != 0.0).map(|(s, _)| s.clone()).collect();
        syms.extend(a.traded.iter().filter_map(|k| k.strip_prefix("usdm:")).map(String::from));
        syms.extend(a.fut_day.keys().cloned());
        syms.extend(a.perp_symbols.iter().cloned());
        (ds, syms, a.market.clone(), a.id.clone(), a.on_fill.clone())
    };
    if syms.is_empty() {
        return Ok(());
    }
    let mut funding: HashMap<String, f64> = HashMap::new();
    let rest_t = CLOCK.now();
    let mut t = ds;
    loop {
        let q: Params = params!["incomeType" => "FUNDING_FEE", "startTime" => t, "limit" => 1000];
        let r = rest.get_json("/fapi/v1/income", &q, 30, true).await?;
        let rows = r.as_array().ok_or_else(|| anyhow!("income: not a list"))?;
        for x in rows {
            *funding.entry(s(x, "symbol")?.to_string()).or_insert(0.0) += f(x, "income")?;
        }
        match rows.last() {
            Some(last) if rows.len() >= 1000 => t = to_i(get(last, "time")?)? + 1,
            _ => break,
        }
    }
    let mut all: Vec<String> = syms.into_iter().chain(funding.keys().cloned()).collect::<HashSet<_>>().into_iter().collect();
    all.sort();
    for sym in all {
        let mut d = acct.borrow().fut_day.get(&sym).cloned().unwrap_or_else(|| FutDay::new(ds));
        let mut trades = BTreeMap::new();
        let mut swept: Vec<FillRec> = vec![];
        let mut frm: Option<i64> = None;
        loop {
            let mut q: Params = params!["symbol" => sym, "limit" => 1000];
            match frm {
                Some(id) => q.push(("fromId".into(), id.to_string())),
                None => q.push(("startTime".into(), ds.to_string())),
            }
            let r = rest.get_json("/fapi/v1/userTrades", &q, 5, true).await?;
            let rows = r.as_array().ok_or_else(|| anyhow!("userTrades: not a list"))?;
            for x in rows {
                let ts = to_i(get(x, "time")?)?;
                if ts < ds {
                    continue;
                }
                let qty = f(x, "qty")?;
                let mut fee = f(x, "commission")?;
                let asset = s(x, "commissionAsset")?;
                if let Some(m) = &market {
                    fee = m.borrow_mut().settled(asset, fee);
                }
                let tid = to_i(get(x, "id")?)?;
                let side = if s(x, "side")? == "BUY" { Side::Buy } else { Side::Sell };
                trades.insert(tid, (ts, if side == Side::Buy { qty } else { -qty }, f(x, "price")?, fee));
                // the fill itself, as the stream would have given it (same id: one the stream gave is not added again)
                let mut fr = FillRec::new(format!("{aid}:usdm:{sym}:{tid}"), ts, aid.clone(), &sym, Venue::USDM, side,
                                          f(x, "price")?, qty);
                fr.fee = f(x, "commission")?;
                fr.fee_asset = asset.to_string();
                fr.maker = x.get("maker").is_some_and(truthy);
                swept.push(fr);
            }
            match rows.last() {
                Some(last) if rows.len() >= 1000 => frm = Some(to_i(get(last, "id")?)? + 1),
                _ => break,
            }
        }
        d.trades = trades;
        d.funding = funding.get(&sym).copied().unwrap_or(0.0);
        d.rest_t = rest_t;
        if d.m0.is_none() {
            let q: Params = params!["symbol" => sym, "interval" => "1m", "startTime" => ds, "limit" => 1];
            let k = rest.get_json("/fapi/v1/markPriceKlines", &q, 1, false).await?;
            if let Some(k0) = k.as_array().and_then(|k| k.first())
                && to_i(&k0[0])? == ds
            {
                d.m0 = Some(to_f(&k0[1])?);
            }
        }
        for fr in swept {
            on_fill(fr);
        }
        acct.borrow_mut().apply(Event::PerpDay { symbol: sym, day: d });
    }
    Ok(())
}

pub async fn rate_limits(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    if acct.borrow().no_order_counts {
        return Ok(());
    }
    let rows = match rest.get_json("/api/v3/rateLimit/order", &[], 40, true).await {
        Ok(r) => r,
        Err(e) if e.downcast_ref::<RestError>().is_some() => {
            if !e.to_string().contains("-2015") {
                return Err(e);
            }
            let id = acct.borrow().id.clone();
            tracing::warn!("{id}: /api/v3/rateLimit/order refused (-2015, a read-only key): order counts from the user stream instead");
            // this endpoint wants a trading key; read-only keys get -2015
            let (per_10s, per_day) = order_limits();
            acct.borrow_mut().apply(Event::CountOrdersHere { per_10s, per_day });
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let (mut per_10s, mut per_day) = (None, None);
    for r in rows.as_array().ok_or_else(|| anyhow!("rateLimit/order: not a list"))? {
        if s(r, "rateLimitType")? != "ORDERS" {
            continue;
        }
        let count = match r.get("count") {
            Some(v) => to_i(v)?,
            None => 0,
        };
        match s(r, "interval")? {
            "SECOND" => per_10s = Some((count, to_i(get(r, "limit")?)?)),
            "DAY" => per_day = Some((count, to_i(get(r, "limit")?)?)),
            _ => {}
        }
    }
    acct.borrow_mut().apply(Event::OrderCounts { per_10s, per_day });
    Ok(())
}

pub async fn open_orders(acct: &AccountRef, rest: &impl RestGet) -> Result<()> {
    let orders = rest.get_json("/api/v3/openOrders", &[], 80, true).await?;
    let mut rows = vec![];
    for o in orders.as_array().ok_or_else(|| anyhow!("openOrders: not a list"))? {
        let created = first(o, &["time"]).map(to_i).transpose()?;
        rows.push((s(o, "symbol")?.to_string(), id_str(get(o, "orderId")?), side_of(s(o, "side")?), f(o, "price")?,
                   f(o, "origQty")? - f(o, "executedQty")?, OPEN_STATES.contains(&s(o, "status")?), created));
    }
    acct.borrow_mut().apply(Event::OpenOrders { venue: Venue::SPOT, rows });
    Ok(())
}

/// One symbol per venue per lookup (hourly), rotating: the spot endpoint costs 20 weight a symbol.
/// Until a venue has a symbol to ask about, its account-wide default rate stands in; so polled each
/// minute, and a venue's hour counts from its first lookup.
pub async fn commissions(p: &Passes, rest: &impl RestGet) -> Result<()> {
    let acct = &p.acct;
    let now = CLOCK.now();
    let (spot, usdm, turn) = {
        let a = acct.borrow();
        let (si, ui) = (Venue::SPOT.index(), Venue::USDM.index());
        let fee_next = p.fee_next.get();
        let mut spot: Vec<String> = if now >= fee_next[si] {
            a.traded.iter().filter_map(|k| k.strip_prefix("spot:")).map(String::from).collect()
        } else {
            vec![]
        };
        spot.sort();
        let mut usdm: Vec<String> = if !a.cfg.futures() || now < fee_next[ui] {
            vec![]
        } else {
            let mut set: HashSet<String> =
                a.positions.iter().filter(|(_, (amt, _))| *amt != 0.0).map(|(p, _)| p.clone()).collect();
            set.extend(a.traded.iter().filter_map(|k| k.strip_prefix("usdm:")).map(String::from));
            set.into_iter().collect()
        };
        usdm.sort();
        if spot.is_empty() && usdm.is_empty() {
            return Ok(());
        }
        let turn = p.fee_turn.get();
        p.fee_turn.set(turn + 1);
        if !spot.is_empty() {
            let mut n = fee_next;
            n[si] = now + 3_600_000;
            p.fee_next.set(n);
        }
        (spot, usdm, turn)
    };
    if !spot.is_empty() {
        let sym = &spot[turn % spot.len()];
        let r = rest.get_json("/api/v3/account/commission", &params!["symbol" => sym], 20, true).await?;
        let parts: Vec<&Value> = ["standardCommission", "specialCommission", "taxCommission"]
            .iter()
            .map(|k| first(&r, &[k]).unwrap_or(&Value::Null))
            .collect();
        let sum = |k: &str| -> Result<f64> {
            parts.iter().map(|p| p.get(k).map_or(Ok(0.0), to_f)).sum()
        };
        let (maker, taker) = (sum("maker")?, sum("taker")?);
        acct.borrow_mut().apply(Event::Fee { venue: Venue::SPOT, symbol: sym.clone(), maker, taker, now });
    }
    if !usdm.is_empty() {
        let mut n = p.fee_next.get();
        n[Venue::USDM.index()] = now + 3_600_000;
        p.fee_next.set(n);
        let sym = &usdm[turn % usdm.len()];
        let r = rest.get_json("/fapi/v1/commissionRate", &params!["symbol" => sym], 20, true).await?;
        let (maker, taker) = (f(&r, "makerCommissionRate")?, f(&r, "takerCommissionRate")?);
        acct.borrow_mut().apply(Event::Fee { venue: Venue::USDM, symbol: sym.clone(), maker, taker, now });
    }
    Ok(())
}

#[derive(Serialize)]
struct LogonParams<'a> {
    #[serde(rename = "apiKey")]
    api_key: &'a str,
    timestamp: i64,
    signature: String,
}

fn status_msg(m: &Value) -> String {
    m.get("error")
        .and_then(|e| e.get("msg"))
        .or_else(|| m.get("status"))
        .map_or_else(|| "None".into(), id_str)
}

/// Spot user data over the WS API: `session.logon` (Ed25519) then subscribe, or a signed subscribe (HMAC).
async fn spot_user(acct: AccountRef) {
    let (feed, creds) = {
        let a = acct.borrow();
        (a.feeds[0].clone(), a.creds.clone().expect("spot user stream without credentials"))
    };
    let ws_ref: Rc<RefCell<Option<WsHandle>>> = Rc::default();
    let w1 = ws_ref.clone();
    let on_open = async move |ws: &mut WsConn| -> Result<()> {
        *w1.borrow_mut() = Some(ws.handle());
        let timestamp = CLOCK.now();
        let payload = query(&[("apiKey", creds.api_key.clone()), ("timestamp", timestamp.to_string())]);
        let params = LogonParams { api_key: &creds.api_key, timestamp, signature: creds.signer.sign(&payload) };
        if creds.signer.kind() == "ed25519" {
            ws_api_call(ws, "logon", "session.logon", Some(&params)).await?;
            // subscribe only once logged on
            let r = tokio::time::timeout(Duration::from_secs(10), ws.recv_text()).await.map_err(|_| anyhow!("session.logon: timeout"))??;
            let r: Value = serde_json::from_str(&r)?;
            if r.get("status").and_then(Value::as_i64) != Some(200) {
                bail!("session.logon: {}", status_msg(&r));
            }
            ws_api_call(ws, "sub", "userDataStream.subscribe", None::<()>).await?;
        } else {
            ws_api_call(ws, "sub", "userDataStream.subscribe.signature", Some(&params)).await?;
        }
        Ok(())
    };
    let f2 = feed.clone();
    let on_msg = move |raw: &str| {
        let Ok(m) = serde_json::from_str::<Value>(raw) else { return };
        let close = || {
            if let Some(ws) = ws_ref.borrow().as_ref() {
                ws.close();
            }
        };
        if let Some(e) = m.get("event").filter(|e| !e.is_null()) {
            if e.get("e").and_then(Value::as_str) == Some("eventStreamTerminated") {
                f2.borrow_mut().error = "event stream terminated".into();
                close();
            } else if let Err(err) = on_spot_event(&mut acct.borrow_mut(), e) {
                tracing::warn!("spot user event: {err:#}");
            }
        } else if m.get("status").and_then(Value::as_i64).unwrap_or(200) != 200 {
            f2.borrow_mut().error = format!("{}: {}", m.get("id").map_or_else(|| "None".into(), id_str), status_msg(&m));
            close();
        }
    };
    run_ws(|| WS_API.to_string(), feed, on_msg, on_open, None).await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListenKey {
    listen_key: String,
}

#[derive(Default)]
struct FutState {
    key: String,
    ws: Option<WsHandle>,
}

async fn new_key(rest: &Rest, feed: &FeedRef, state: &RefCell<FutState>) {
    loop {
        let r: Result<ListenKey> = rest.listen_key("POST").await;
        match r {
            Ok(k) => {
                state.borrow_mut().key = k.listen_key;
                return;
            }
            Err(e) => {
                let d: String = format!("listenKey: {e:#}").chars().take(200).collect();
                feed.borrow_mut().set_up(false, Some(&d));
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    }
}

async fn renew(rest: Rest, feed: FeedRef, state: Rc<RefCell<FutState>>) {
    new_key(&rest, &feed, &state).await;
    let ws = state.borrow().ws.clone();
    if let Some(ws) = ws {
        ws.close();
    }
}

async fn keepalive(rest: Rest, feed: FeedRef, state: Rc<RefCell<FutState>>) {
    loop {
        tokio::time::sleep(Duration::from_secs(1800)).await;
        let r: Result<Value> = rest.listen_key("PUT").await;
        if r.is_err() {
            renew(rest.clone(), feed.clone(), state.clone()).await;
        }
    }
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// USD-M user data: listenKey stream, kept alive every 30 min, renewed when it expires.
async fn fut_user(acct: AccountRef, rest: Rest) {
    let feed = acct.borrow().feeds[1].clone();
    let state: Rc<RefCell<FutState>> = Rc::default();
    new_key(&rest, &feed, &state).await;
    let _ka = AbortOnDrop(tokio::task::spawn_local(keepalive(rest.clone(), feed.clone(), state.clone())));
    let s1 = state.clone();
    let on_open = async move |ws: &mut WsConn| -> Result<()> {
        s1.borrow_mut().ws = Some(ws.handle());
        Ok(())
    };
    let (f2, s2) = (feed.clone(), state.clone());
    let on_msg = move |raw: &str| {
        let Ok(m) = serde_json::from_str::<Value>(raw) else { return };
        if m.get("e").and_then(Value::as_str) == Some("listenKeyExpired") {
            f2.borrow_mut().error = "listen key expired".into();
            tokio::task::spawn_local(renew(rest.clone(), f2.clone(), s2.clone()));
        } else if let Err(err) = on_fut_event(&mut acct.borrow_mut(), &m) {
            tracing::warn!("usdm user event: {err:#}");
        }
    };
    let s3 = state.clone();
    run_ws(move || format!("{USDM_PRIVATE}{}", s3.borrow().key), feed, on_msg, on_open, None).await;
}

pub async fn transfers_poll(t: &TransfersRef, rest: &impl RestGet, n: u64, day_start: &impl Fn() -> i64) -> Result<()> {
    if n.is_multiple_of(60) {
        let r = rest.get_json("/sapi/v1/sub-account/list", &params!["limit" => 200], 1, true).await?;
        let empty = vec![];
        let subs = r.get("subAccounts").and_then(Value::as_array).unwrap_or(&empty);
        let frozen = subs.iter().filter(|s| s.get("isFreeze").is_some_and(truthy)).count();
        t.borrow_mut().sub_info =
            format!("{} sub-accounts", subs.len()) + &if frozen > 0 { format!(", {frozen} frozen") } else { String::new() };
    }
    let start = day_start();
    let (master_email, froms) = {
        let tb = t.borrow();
        let master_email = tb.master.as_ref().map(|m| m.borrow().email.clone()).unwrap_or_default();
        let mut froms: Vec<Option<String>> = vec![None];
        for a in &tb.accounts {
            let a = a.borrow();
            if !a.email.is_empty() && a.role == Role::Sub {
                froms.push(Some(a.email.clone()));
            }
        }
        (master_email, froms)
    };
    for frm in froms {
        let mut p: Params = params!["startTime" => start, "endTime" => CLOCK.now(), "limit" => 500];
        if let Some(frm) = frm {
            p.push(("fromEmail".into(), frm));
        }
        let r = rest.get_json("/sapi/v1/sub-account/universalTransfer", &p, 1, true).await?;
        let mut tb = t.borrow_mut();
        for x in r.get("result").and_then(Value::as_array).into_iter().flatten() {
            if x.get("status").and_then(Value::as_str).unwrap_or("SUCCESS") != "SUCCESS" {
                continue;
            }
            let email = |k: &str| first(x, &[k]).and_then(Value::as_str).map_or_else(|| master_email.clone(), String::from);
            let rec = Transfer {
                ts: to_i(get(x, "createTimeStamp")?)?,
                frm: email("fromEmail"),
                to: email("toEmail"),
                asset: s(x, "asset")?.to_string(),
                amount: f(x, "amount")?,
                usd: None,
            };
            tb.add(&id_str(get(x, "tranId")?), rec);
        }
    }
    let mut tb = t.borrow_mut();
    tb.feed.borrow_mut().hit(1);
    tb.loaded = true;
    let d = format!("{} transfers today; {}", tb.records.len(), tb.sub_info);
    tb.feed.borrow_mut().set_up(true, Some(&d));
    Ok(())
}

/// Poll the transfer history every minute (the sub-account list hourly); `rest` carries the master's key.
pub async fn run_transfers(t: TransfersRef, rest: Rest, day_start: impl Fn() -> i64) {
    let ok = t.borrow().master.as_ref().is_some_and(|m| m.borrow().creds.is_some());
    if !ok {
        return;
    }
    let mut n = 0u64;
    loop {
        if let Err(e) = transfers_poll(&t, &rest, n, &day_start).await {
            let feed = t.borrow().feed.clone();
            feed.borrow_mut().set_up(false, Some(&err_text(&e)));
        }
        n += 1;
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{Account, MarketRef};
    use crate::config::AccountCfg;
    use crate::market::{Book, Info, Market, SymbolInfo};
    use approx::assert_relative_eq;
    use serde_json::json;

    fn cfg(id: &str, email: &str) -> AccountCfg {
        AccountCfg::new(id, id, email, Role::Sub)
    }

    fn acct() -> (Account, MarketRef) {
        let mut i = Info::new();
        i.insert(Venue::SPOT, HashMap::from([("XUSDT".to_string(), SymbolInfo::new("X", "USDT", 5.0))]));
        i.insert(Venue::USDM, HashMap::new());
        let mut m = Market::new(i, 120.0, 100.0);
        m.ensure("XUSDT", Venue::SPOT, None);
        m.on_book(Venue::SPOT, &Book::new("XUSDT", 100.0, 100.0, Some(1)));
        let m = Rc::new(RefCell::new(m));
        let mut c = cfg("a", "");
        c.markets.push(Venue::USDM);
        let mut a = Account::new(c, None, "");
        a.market = Some(m.clone());
        (a, m)
    }

    struct FakeRest {
        calls: RefCell<Vec<(String, String, i64)>>,
    }

    impl RestGet for FakeRest {
        async fn get_json(&self, path: &str, params: &[(String, String)], weight: i64, _signed: bool) -> Result<Value> {
            let sym = params.iter().find(|(k, _)| k == "symbol").map(|x| x.1.clone()).unwrap();
            self.calls.borrow_mut().push((path.into(), sym, weight));
            Ok(json!({"standardCommission": {"maker": "0.0001", "taker": "0.0002"}}))
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn resting_notional_and_commission_rotation() {
        let a = Account::new(cfg("a", ""), None, "").shared();
        let p = Passes::new(a.clone());
        let r = FakeRest { calls: RefCell::new(vec![]) };
        commissions(&p, &r).await.unwrap();   // no symbol seen yet: waits, the default rate stands
        assert!(p.next_commission(Venue::SPOT) == 0 && r.calls.borrow().is_empty());
        {
            let mut a = a.borrow_mut();
            a.order_update(Venue::SPOT, "XUSDT", "1", Side::Buy, 10.0, 3.0, true, None);
            a.order_update(Venue::SPOT, "XUSDT", "2", Side::Sell, 12.0, 1.0, true, None);
            a.order_update(Venue::SPOT, "YUSDT", "3", Side::Buy, 5.0, 2.0, true, None);
            a.order_update(Venue::SPOT, "YUSDT", "3", Side::Buy, 5.0, 0.0, false, None);
            assert_eq!(a.resting(&Market::new(Info::new(), 120.0, 100.0)), (30.0, 12.0));
        }
        for _ in 0..3 {
            commissions(&p, &r).await.unwrap();
            commissions(&p, &r).await.unwrap();   // within the hour: no lookup
            p.commissions_due();
        }
        let syms: Vec<String> = r.calls.borrow().iter().map(|c| c.1.clone()).collect();
        assert_eq!(syms, ["XUSDT", "YUSDT", "XUSDT"]);   // one symbol per poll, rotating
        assert!(r.calls.borrow().iter().all(|c| c.0 == "/api/v3/account/commission" && c.2 == 20));
        let rows = a.borrow().fee_rows();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].venue.is_spot() && !rows[0].changed);
        assert_relative_eq!(rows[0].maker_bps, 1.0);
        assert_relative_eq!(rows[0].taker_bps, 2.0);
    }

    struct DivRest(Value);

    impl RestGet for DivRest {
        async fn get_json(&self, path: &str, params: &[(String, String)], weight: i64, _signed: bool) -> Result<Value> {
            assert_eq!((path, weight), ("/sapi/v1/asset/assetDividend", 10));
            assert_eq!(params[0], ("startTime".to_string(), "3600000".to_string()));
            Ok(self.0.clone())
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dividends_book_the_day_rebates() {
        let (mut a, m) = acct();
        let kept: Rc<RefCell<Vec<String>>> = Rc::default();
        let k2 = kept.clone();
        a.on_dividend = Rc::new(move |_, id, _| k2.borrow_mut().push(id.to_string()));
        let a = a.shared();
        let row = |id: i64, t: i64, asset: &str, amount: &str, info: &str| {
            json!({"id": id, "tranId": id * 10, "asset": asset, "amount": amount, "divTime": t, "enInfo": info})
        };
        let r = DivRest(json!({"rows": [
            row(1, 3_700_000, "USDT", "0.25", "Spot MM Rebate-Spot 26-10-15 07:00"),
            row(2, 7_300_000, "USDT", "0.5", "Spot MM Rebate-Spot 26-10-15 08:00"),
            row(3, 7_300_000, "X", "2", "Launchpool distribution"),
        ], "total": 3}));
        dividends(&a, &r).await.unwrap();   // the desk has not set the day: nothing asked
        assert!(a.borrow().dividends.is_empty());
        a.borrow_mut().day_start = 3_600_000;
        dividends(&a, &r).await.unwrap();
        dividends(&a, &r).await.unwrap();   // the same rows again: kept once
        assert_eq!(*kept.borrow(), ["1", "2", "3"]);
        // the distribution of X is kept but is not a rebate
        assert_relative_eq!(a.borrow().rebates(&mut m.borrow_mut()), 0.75);
        a.borrow_mut().day_start = 7_000_000;
        assert_relative_eq!(a.borrow().rebates(&mut m.borrow_mut()), 0.5);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_past_day_sums_its_rebates_and_keeps_every_row() {
        let (mut a, _m) = acct();
        let kept: Rc<RefCell<Vec<String>>> = Rc::default();
        let k2 = kept.clone();
        a.on_dividend = Rc::new(move |_, id, _| k2.borrow_mut().push(id.to_string()));
        let a = a.shared();
        let r = DivRest(json!({"rows": [
            {"id": 1, "asset": "USDT", "amount": "0.25", "divTime": 3_700_000, "enInfo": "Spot MM Rebate-Spot 26-10-13 07:00"},
            {"id": 2, "asset": "X", "amount": "2", "divTime": 3_800_000, "enInfo": "Launchpool distribution"},
        ]}));
        assert_relative_eq!(crate::accounts::past_rebates(&a, &distributions(&r, 3_600_000, 3_600_000 + 86_400_000).await.unwrap()), 0.25);
        assert_eq!(*kept.borrow(), ["1", "2"]);
        assert!(a.borrow().dividends.is_empty());   // a past day's rows do not count today
    }
}
