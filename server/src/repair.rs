//! `desk repair-day`: a past day's desk rows rebuilt where the live desk could not write them (the db's disk
//! full) or wrote them from an incomplete day (the fills and marks a restart had still to sweep).
//!
//! The rows are the desk's own figures recomputed at each time t from what the db holds once the day is
//! complete, with the desk's own code: Π and its realized / floating split (`PnlBook`, closed form over the
//! fills at or before t), the reference and factor hedge on a 1 min grid (`PnlBook::book_gap`, as the live
//! backfill books a gap), market making (`metrics::mm_split` at t), the futures legs (`FutLeg`'s formula over
//! the legs' trades and funding at or before t, at the 1 min mark price) and the rebates credited by t. Prices
//! are 1 min klines (open → close of the minute, `backfill::interp_at`); M_k(D) is the day's kept one.
//!
//! The opening quantities come from the balances now, less the fills since the day's end (signed REST reads with
//! the configured keys, read-only), so the run needs the desk's keys. Day PnL is real money only where a row
//! has it: in a gap, Other (Day PnL less Π, hedge and rebates: what the split does not explain) is taken
//! linearly between the live rows on either side, and Day PnL is the split plus it; equity, inventory and the
//! futures notional are the recomputed figures plus the offset between them and the live rows, also linear.
//!
//! What is written, for the desk rows (account "*") from `--from` to `--to`: a row each minute in a gap (none
//! for 10 minutes and more), and Π, hedged, realized, floating, market making, hedge and rebates in the rows
//! there (their Day PnL, equity, inventory and futures notional are the live desk's). The hour blocks from
//! `--from`'s hour on are booked again. Per-account rows are not (only today's are drawn). One transaction,
//! a kv record `repair:day-rows:<day>` of what changed; the desk reads the rows on its next start.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use anyhow::{Context, Result, anyhow, bail};
use rusqlite::{Connection, params};
use serde_json::Value;

use crate::backfill::{interp_at, klines};
use crate::beta::Betas;
use crate::binance::rest::{CLOCK, Rest, client, governors, sync_time};
use crate::binance::sign::credentials;
use crate::config::Config;
use crate::fills::FillRec;
use crate::market::{BookTicker, Market, STABLES};
use crate::pnl::{Gap, PnlBook, PnlState};
use crate::protocol::{Side, Venue};
use crate::recompute::{DAY, day_start_of};
use crate::store::{FILL_COLS, row_fill};

const MIN: i64 = 60_000;
const HOUR: i64 = 3_600_000;
/// No desk row for this long is a gap the repair fills.
pub const GAP_MS: i64 = 600_000;

/// A desk row as the repair reads and writes it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeskRow {
    pub t: i64,
    pub equity: f64,
    pub pnl_day: f64,
    pub inventory: f64,
    pub futures: f64,
    pub trading: Option<f64>,
    pub hedged: Option<f64>,
    pub realized: Option<f64>,
    pub floating: Option<f64>,
    pub hedge: Option<f64>,
    pub mm: Option<f64>,
    pub rebates: Option<f64>,
}

impl DeskRow {
    /// Day PnL less what the split explains.
    pub fn other(&self) -> Option<f64> {
        Some(self.pnl_day - self.trading? - self.hedge? - self.rebates?)
    }
}

/// The figures recomputed at a time.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct At {
    pub trading: f64,
    pub hedged: f64,
    /// realized against today's buys (less fees), and against the opening inventory
    pub realized: f64,
    pub realized_old: f64,
    pub floating: f64,
    pub mm: f64,
    pub hedge: f64,
    pub rebates: f64,
    /// Σ Q_k M_k over the bases in Π's scope, and the legs' Σ q mark
    pub inventory: f64,
    pub futures: f64,
}

/// One futures leg's day: quantity at the day start, mark there, trades (t, s q, price, fee in USD) and funding.
#[derive(Debug, Clone, Default)]
pub struct Leg {
    pub q0: f64,
    pub m0: f64,
    pub trades: Vec<(i64, f64, f64, f64)>,
    pub funding: Vec<(i64, f64)>,
    pub marks: Vec<(i64, f64, f64)>,
}

impl Leg {
    /// (P&L, quantity) at t, as `FutLeg` has it then: q0 (mark − m0) + Σ s q (mark − p) − fees + funding.
    pub fn at(&self, t: i64) -> (f64, f64) {
        let Some(mk) = interp_at(&self.marks, t) else { return (0.0, self.q0) };
        let mut pnl = self.q0 * (mk - self.m0);
        let mut q = self.q0;
        for &(_, sq, px, fee) in self.trades.iter().take_while(|x| x.0 <= t) {
            pnl += sq * (mk - px) - fee;
            q += sq;
        }
        pnl += self.funding.iter().filter(|x| x.0 <= t).map(|x| x.1).sum::<f64>();
        (pnl, q * mk)
    }
}

/// Everything the recompute reads, so the computation itself runs on data alone (and in tests).
pub struct Inputs {
    pub ds: i64,
    pub horizon_s: i64,
    /// the day's fills (all venues), by time
    pub fills: Vec<FillRec>,
    /// Q_k at the day's end, by base
    pub q_end: HashMap<String, f64>,
    pub m0: crate::pnl::OMap<f64>,
    /// 1 min bars (open time, open, close) by instrument key
    pub bars: HashMap<String, Vec<(i64, f64, f64)>>,
    pub legs: Vec<Leg>,
    /// (t, asset, amount) of the day's market-maker rebates
    pub rebates: Vec<(i64, String, f64)>,
    /// the day's hour blocks before the rebooked ones: Σ ref_hedge
    pub h_before: f64,
}

/// The recompute: a PnlBook holding the day, the market whose prices are set to each time asked for.
pub struct Day<'a> {
    pub inp: &'a Inputs,
    pub m: Market,
    pub book: PnlBook,
    /// cumulative reference hedge at each minute boundary booked (t ms → H)
    pub h: BTreeMap<i64, f64>,
}

impl<'a> Day<'a> {
    pub fn new(inp: &'a Inputs, mut m: Market, scope: Vec<String>, beta: Box<dyn Fn(&str) -> f64>, beta_vs: Option<String>) -> Self {
        let q_end = inp.q_end.clone();
        let mut book = PnlBook::new(inp.ds, Box::new(move |b| q_end.get(b).copied().unwrap_or(0.0)), Box::new(move || scope.clone()),
                                    beta, beta_vs, None);
        book.load_fills(&mut m, inp.fills.iter());
        book.m0 = inp.m0.clone();
        book.open_scope(&mut m, inp.ds.div_euclid(1000));
        // a base held at the day start without a kept M_k(D): the bar at the day start
        let missing: Vec<(String, String)> = book
            .pos
            .iter()
            .filter(|(b, p)| !book.m0.contains_key(b) && p.q0 != 0.0)
            .map(|(b, p)| (b.to_string(), m.insts[p.inst].key.clone()))
            .collect();
        for (b, k) in missing {
            if let Some(v) = inp.bars.get(&k).and_then(|x| interp_at(x, inp.ds)) {
                book.m0.insert(b, v);
            }
        }
        Day { inp, m, book, h: BTreeMap::new() }
    }

    /// Every instrument with bars at its price at t (bid = ask = the price).
    pub fn set_prices(&mut self, t: i64) {
        for (k, bars) in &self.inp.bars {
            let Some((venue, sym)) = k.split_once(':') else { continue };
            let Ok(venue) = venue.parse::<Venue>() else { continue };
            if let Some(x) = interp_at(bars, t).filter(|x| *x > 0.0) {
                self.m.on_book(venue, &BookTicker::new(sym, x, x, Some(t)));
            }
        }
    }

    /// Books the hedge on the 1 min grid from `from` (ms, a minute) to the day's end, keeping H at each minute.
    pub fn book_hedge(&mut self, from: i64) -> HashMap<String, crate::pnl::Bars> {
        let bars: HashMap<String, crate::pnl::Bars> =
            self.inp.bars.iter().map(|(k, v)| (k.clone(), crate::pnl::Bars::new(v.iter().copied()))).collect();
        let mut h = self.inp.h_before;
        // the blocks from `from` on are booked anew
        self.book.hours.retain(|t, _| *t < from);
        let end = self.inp.ds + DAY;
        let mut t = from;
        self.h.insert(t, h);
        while t < end {
            let g = Gap::new(t / 1000, (t + MIN) / 1000);
            let plan = self.book.plan(&self.m, &g);
            let before: f64 = self.book.hours.values().map(|b| b.ref_hedge).sum();
            self.book.book_gap(&mut self.m, &g, &plan, &bars);
            let after: f64 = self.book.hours.values().map(|b| b.ref_hedge).sum();
            h += after - before;
            t += MIN;
            self.h.insert(t, h);
        }
        bars
    }

    /// H at t: linear between the minutes booked around it.
    fn h_at(&self, t: i64) -> f64 {
        let lo = self.h.range(..=t).next_back();
        let hi = self.h.range(t..).next();
        match (lo, hi) {
            (Some((&a, &x)), Some((&b, &y))) if b > a => x + (y - x) * (t - a) as f64 / (b - a) as f64,
            (Some((_, &x)), _) | (None, Some((_, &x))) => x,
            _ => self.inp.h_before,
        }
    }

    pub fn at(&mut self, t: i64) -> At {
        self.set_prices(t);
        let (pi, re, re_old, fl) = self.book.split_upto(&mut self.m, t);
        let n = self.inp.fills.partition_point(|f| f.ts <= t);
        let pos = &self.book.pos;
        let mm = crate::metrics::mm_split(&mut self.m, &self.inp.fills[..n], self.inp.horizon_s, t, |b| pos.contains_key(b)).total;
        let mut inv = 0.0;
        for (b, p) in self.book.pos.iter() {
            if let Some(px) = self.m.px(p.inst) {
                inv += self.book.q_upto(b, t) * px;
            }
        }
        let (mut hedge, mut fut) = (0.0, 0.0);
        for l in &self.inp.legs {
            let (p, n) = l.at(t);
            hedge += p;
            fut += n;
        }
        let mut reb = 0.0;
        for (ts, asset, amt) in self.inp.rebates.iter().filter(|r| r.0 <= t) {
            let px = if asset == "USDT" { Some(1.0) } else { self.inp.bars.get(&format!("spot:{asset}USDT")).and_then(|b| interp_at(b, *ts)) };
            reb += amt * px.unwrap_or(if STABLES.contains(&asset.as_str()) { 1.0 } else { 0.0 });
        }
        At { trading: pi, hedged: pi - self.h_at(t), realized: re, realized_old: re_old, floating: fl, mm, hedge, rebates: reb, inventory: inv,
             futures: fut }
    }
}

/// The rows of the day as repaired. `live`: the desk rows the day has, by time; `from` / `to`: the span to
/// repair (ms). Returns the rows to write (new and changed) and, for the report, the live rows before `from`
/// next to their recomputed figures.
/// The rows to write, and the live rows before the span next to their recomputed figures.
pub type Rebuilt = (Vec<DeskRow>, Vec<(DeskRow, At)>);

pub fn rebuild(day: &mut Day, live: &[DeskRow], from: i64, to: i64) -> Result<Rebuilt> {
    let mut out = vec![];
    let mut check = vec![];
    // the live rows before `from`, against the recompute, once every 10 minutes
    let mut next = 0;
    for r in live.iter().filter(|r| r.t < from) {
        if r.t >= next {
            check.push((r.clone(), day.at(r.t)));
            next = r.t - r.t.rem_euclid(GAP_MS) + GAP_MS;
        }
    }
    let span: Vec<&DeskRow> = live.iter().filter(|r| r.t >= from && r.t < to).collect();
    let before = live.iter().rfind(|r| r.t < from);
    // the gaps: between two rows (or `from` and the first) more than GAP_MS apart
    let mut prev = before;
    let mut edges: Vec<(&DeskRow, &DeskRow)> = vec![];
    for r in &span {
        if let Some(p) = prev
            && r.t - p.t >= GAP_MS
        {
            edges.push((p, r));
        }
        prev = Some(r);
    }
    for (a, b) in edges {
        let (ra, rb) = (day.at(a.t), day.at(b.t));
        // Other and the offsets at each side: the live row's real figures less the recompute
        let other_a = a.other().ok_or_else(|| anyhow!("row {} has no split", a.t))?;
        let other_b = b.pnl_day - rb.trading - rb.hedge - rb.rebates;
        let (eq_a, eq_b) = (a.equity - a.pnl_day, b.equity - b.pnl_day);
        let (inv_a, inv_b) = (a.inventory - ra.inventory, b.inventory - rb.inventory);
        let (fut_a, fut_b) = (a.futures - ra.futures, b.futures - rb.futures);
        let lerp = |x: f64, y: f64, t: i64| x + (y - x) * (t - a.t) as f64 / (b.t - a.t) as f64;
        let mut t = a.t - a.t.rem_euclid(MIN) + MIN;
        while t < b.t {
            let r = day.at(t);
            let pnl_day = r.trading + r.hedge + r.rebates + lerp(other_a, other_b, t);
            out.push(DeskRow {
                t,
                equity: pnl_day + lerp(eq_a, eq_b, t),
                pnl_day,
                inventory: r.inventory + lerp(inv_a, inv_b, t),
                futures: r.futures + lerp(fut_a, fut_b, t),
                trading: Some(r.trading),
                hedged: Some(r.hedged),
                realized: Some(r.realized + r.realized_old),
                floating: Some(r.floating),
                hedge: Some(r.hedge),
                mm: Some(r.mm),
                rebates: Some(r.rebates),
            });
            t += MIN;
        }
    }
    // the live rows in the span: their split recomputed, their money as it was
    for r in span {
        let x = day.at(r.t);
        out.push(DeskRow {
            trading: Some(x.trading),
            hedged: Some(x.hedged),
            realized: Some(x.realized + x.realized_old),
            floating: Some(x.floating),
            hedge: Some(x.hedge),
            mm: Some(x.mm),
            rebates: Some(x.rebates),
            ..r.clone()
        });
    }
    out.sort_by_key(|r| r.t);
    Ok((out, check))
}

// --- reading -------------------------------------------------------------------------------------------

fn desk_rows(c: &Connection, a: i64, b: i64) -> Result<Vec<DeskRow>> {
    let mut st = c.prepare(
        "SELECT t, equity, pnl_day, inventory, futures_notional, trading, hedged, realized, floating, hedge, mm, rebates \
         FROM equity WHERE account = '*' AND t >= ? AND t < ? ORDER BY t")?;
    let rows = st
        .query_map([a, b], |r| {
            Ok(DeskRow {
                t: r.get(0)?,
                equity: r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                pnl_day: r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                inventory: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                futures: r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                trading: r.get(5)?,
                hedged: r.get(6)?,
                realized: r.get(7)?,
                floating: r.get(8)?,
                hedge: r.get(9)?,
                mm: r.get(10)?,
                rebates: r.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn fills_between(c: &Connection, a: i64, b: i64) -> Result<Vec<FillRec>> {
    let mut st = c.prepare(&format!("SELECT {FILL_COLS} FROM fills WHERE ts >= ? AND ts < ? ORDER BY ts"))?;
    Ok(st.query_map([a, b], row_fill)?.collect::<Result<_, _>>()?)
}

fn num(v: &Value, k: &str) -> Result<f64> {
    let x = v.get(k).ok_or_else(|| anyhow!("no {k} in {v}"))?;
    match x {
        Value::String(s) => Ok(s.parse()?),
        Value::Number(n) => n.as_f64().ok_or_else(|| anyhow!("bad {k}")),
        _ => bail!("bad {k}: {x}"),
    }
}

fn int(v: &Value, k: &str) -> Result<i64> {
    v.get(k).and_then(Value::as_i64).ok_or_else(|| anyhow!("no {k} in {v}"))
}

/// `HH:MM` of the day starting at `ds` (24:00 the day's end).
fn hhmm(ds: i64, s: &str) -> Result<i64> {
    let (h, m) = s.split_once(':').ok_or_else(|| anyhow!("bad time {s:?}"))?;
    let (h, m): (i64, i64) = (h.parse()?, m.parse()?);
    anyhow::ensure!((0..=24).contains(&h) && (0..60).contains(&m) && h * 60 + m <= 1440, "bad time {s:?}");
    Ok(ds + h * HOUR + m * MIN)
}

/// `desk repair-day --day D --from HH:MM [--to HH:MM] [--dry-run] [--csv PATH]`.
pub async fn run(cfg: &Config, day: &str, from: &str, to: &str, dry_run: bool, csv: Option<&str>) -> Result<()> {
    let ds = day_start_of(day, cfg.day_start_min)?;
    let (from, to) = (hhmm(ds, from)?, hhmm(ds, to)?);
    let now = crate::clock::now_ms();
    anyhow::ensure!(ds + DAY <= crate::sessions::day_start(now, cfg.day_start_min), "{day} is not over yet");
    let public = Rest::new(client(), governors(), None, None);
    sync_time(&public).await.context("time sync")?;
    let t_bal = CLOCK.now();

    // the balances now and the futures legs, with each account's key
    let mut bal: HashMap<String, f64> = HashMap::new();
    let mut read_at: HashMap<String, i64> = HashMap::new();
    let mut pos: HashMap<String, f64> = HashMap::new();
    // symbol -> (trades (t, s q, price, fee, fee asset), funding (t, amount))
    type Raw = (Vec<(i64, f64, f64, f64, String)>, Vec<(i64, f64)>);
    let mut legs_raw: HashMap<String, Raw> = HashMap::new();
    let hedges = &cfg.hedge_symbols;
    for ac in &cfg.accounts {
        let creds = credentials(&ac.api_key_env, &ac.private_key_env, &ac.secret_env)
            .map_err(|e| anyhow!("account {}: {e} (the repair reads its balances)", ac.id))?;
        let rest = Rest::new(client(), governors(), Some(Rc::new(creds)), None);
        let r: Value = rest.get("/api/v3/account", &crate::params! {"omitZeroBalances" => "true"}, 20, true).await?;
        // when this account's balances stood (its fills up to then are in them); "updateTime" is Binance's
        read_at.insert(ac.id.clone(), r.get("updateTime").and_then(Value::as_i64).unwrap_or_else(|| CLOCK.now()));
        for b in r.get("balances").and_then(Value::as_array).into_iter().flatten() {
            let a = b.get("asset").and_then(Value::as_str).unwrap_or_default().to_string();
            *bal.entry(a).or_default() += num(b, "free")? + num(b, "locked")?;
        }
        if !ac.futures {
            continue;
        }
        let r: Value = rest.get("/fapi/v3/positionRisk", &[], 5, true).await?;
        for p in r.as_array().into_iter().flatten() {
            let s = p.get("symbol").and_then(Value::as_str).unwrap_or_default().to_string();
            *pos.entry(s).or_default() += num(p, "positionAmt")?;
        }
        for sym in hedges {
            let e = legs_raw.entry(sym.clone()).or_default();
            let mut frm: Option<i64> = None;
            loop {
                let mut q = crate::params! {"symbol" => sym, "limit" => 1000};
                match frm {
                    Some(id) => q.push(("fromId".into(), id.to_string())),
                    None => q.push(("startTime".into(), ds.to_string())),
                }
                let rows: Value = rest.get("/fapi/v1/userTrades", &q, 5, true).await?;
                let rows = rows.as_array().cloned().unwrap_or_default();
                for x in &rows {
                    let qty = num(x, "qty")?;
                    let sq = if x.get("side").and_then(Value::as_str) == Some("BUY") { qty } else { -qty };
                    let asset = x.get("commissionAsset").and_then(Value::as_str).unwrap_or("USDT").to_string();
                    e.0.push((int(x, "time")?, sq, num(x, "price")?, num(x, "commission")?, asset));
                }
                match rows.last() {
                    Some(l) if rows.len() >= 1000 => frm = Some(int(l, "id")? + 1),
                    _ => break,
                }
            }
            let q = crate::params! {"symbol" => sym, "incomeType" => "FUNDING_FEE", "startTime" => ds, "endTime" => ds + DAY - 1, "limit" => 1000};
            let rows: Value = rest.get("/fapi/v1/income", &q, 30, true).await?;
            for x in rows.as_array().into_iter().flatten() {
                e.1.push((int(x, "time")?, num(x, "income")?));
            }
        }
    }
    let c = crate::store::open(&cfg.db)?;
    let fills = fills_between(&c, ds, ds + DAY)?;
    // wait for the fills up to the last read to be in the db, then take each account's up to its own read
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    let last_read = read_at.values().copied().max().unwrap_or(t_bal);
    let after: Vec<FillRec> = fills_between(&c, ds + DAY, last_read + 1)?
        .into_iter()
        .filter(|f| read_at.get(&f.account).is_some_and(|&t| f.ts <= t))
        .collect();
    // Π books the flows of the desk's assets, not of its cash: a stablecoin moved between accounts (or in and out)
    // changes no position, only equity, which the rows' own offsets carry
    let stables = STABLES.iter().map(|a| format!("'{a}'")).collect::<Vec<_>>().join(",");
    let n_transfers: i64 = c.query_row(&format!("SELECT count(*) FROM transfers WHERE ts >= ? AND amount != 0 AND asset NOT IN ({stables})"),
                                       [ds], |r| r.get(0))?;
    anyhow::ensure!(n_transfers == 0, "{n_transfers} transfers of a non-stable asset since {day}: the repair does not book them");

    // the market: the configured instruments and every one filled
    let spot: Value = public.get("/api/v3/exchangeInfo", &[], 20, false).await?;
    let usdm: Value = public.get("/fapi/v1/exchangeInfo", &[], 1, false).await?;
    let mut info: crate::market::Info = HashMap::new();
    info.insert(Venue::Spot, crate::market::parse_exchange_info(&spot));
    info.insert(Venue::Usdm, crate::market::parse_exchange_info(&usdm));
    let mut m = Market::new(info, cfg.fair_halflife_s, cfg.mark_max_spread_bps);
    for mc in &cfg.markets {
        m.ensure(&mc.symbol, mc.venue, mc.reference.as_ref().map(|r| (r.symbol.as_str(), r.venue)));
    }
    for f in fills.iter().chain(&after) {
        m.ensure(&f.symbol, f.venue, None);
    }
    // Q at the day's end: the balance now less the spot fills since (a fee taken in the base asset came out of it)
    let mut q_end = bal.clone();
    for f in after.iter().filter(|f| f.venue == Venue::Spot && !f.conversion()) {
        if let Some(i) = m.get(&f.key()) {
            let s = if f.side == Side::Buy { 1.0 } else { -1.0 };
            let fee = if f.fee_asset == i.base { f.fee } else { 0.0 };
            *q_end.entry(i.base.clone()).or_default() -= s * f.qty - fee;
        }
    }

    // the day's kept M_k(D) and the hour blocks before `from`
    let state: Option<PnlState> = c
        .query_row("SELECT v FROM kv WHERE k = ?", [format!("pnlstate:{ds}")], |r| r.get::<_, String>(0))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    let from_hour = from - (from - ds).rem_euclid(HOUR);
    let h_before: f64 =
        c.query_row("SELECT coalesce(sum(ref_hedge), 0) FROM pnl_hours WHERE t >= ? AND t < ?", [ds, from_hour], |r| r.get(0))?;
    let mut rebates = vec![];
    {
        let mut st = c.prepare("SELECT ts, asset, amount, info FROM dividends WHERE ts >= ? AND ts < ?")?;
        let rows = st.query_map([ds, ds + DAY], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, f64>(2)?, r.get::<_, String>(3)?)))?;
        for r in rows {
            let (ts, a, x, info) = r?;
            if info.contains("MM Rebate") {
                rebates.push((ts, a, x));
            }
        }
    }

    // klines: each instrument in scope, its reference, the beta instrument, the fee and rebate assets
    let mut keys: Vec<String> = cfg.markets.iter().filter(|mc| mc.venue == Venue::Spot).map(|mc| format!("spot:{}", mc.symbol)).collect();
    keys.extend(fills.iter().filter(|f| f.venue == Venue::Spot && !f.conversion()).map(|f| f.key()));
    keys.sort();
    keys.dedup();
    let scope = keys.clone();
    let mut want = keys.clone();
    for k in &keys {
        if let Some(r) = m.get(k).and_then(|i| i.ref_).map(|r| m.insts[r].key.clone()) {
            want.push(r);
        }
    }
    want.extend(cfg.beta_vs.clone());
    for f in &fills {
        if f.fee != 0.0 && !STABLES.contains(&f.fee_asset.as_str()) && !f.fee_asset.is_empty() {
            want.push(format!("spot:{}USDT", f.fee_asset));
        }
    }
    for (_, a, _) in &rebates {
        if a != "USDT" {
            want.push(format!("spot:{a}USDT"));
        }
    }
    want.push("spot:USDCUSDT".into());
    want.sort();
    want.dedup();
    let mut bars = HashMap::new();
    for k in &want {
        let v = crate::backfill::none_on_400(klines(&public, k, ds - MIN, ds + DAY).await)?;
        bars.insert(k.clone(), v);
    }
    eprintln!("{} kline series", bars.len());
    // the legs: mark price klines, the quantity at the day start
    let mut legs = vec![];
    for (sym, (trades, funding)) in legs_raw {
        let mut marks = vec![];
        let mut t = ds - MIN;
        while t < ds + DAY {
            let q = crate::params! {"symbol" => sym, "interval" => "1m", "startTime" => t, "endTime" => ds + DAY, "limit" => 1000};
            let rows: Vec<Vec<Value>> = public.get("/fapi/v1/markPriceKlines", &q, 5, false).await?;
            let n = rows.len();
            for r in rows {
                let f = |i: usize| r.get(i).and_then(|v| v.as_str()).and_then(|s| s.parse::<f64>().ok());
                if let (Some(ot), Some(o), Some(cl)) = (r.first().and_then(Value::as_i64), f(1), f(4)) {
                    marks.push((ot, o, cl));
                }
            }
            if n < 1000 {
                break;
            }
            t = marks.last().map_or(ds + DAY, |x| x.0 + MIN);
        }
        let q_now = pos.get(&sym).copied().unwrap_or(0.0);
        let mut day_trades = vec![];
        let mut q_after = 0.0;
        for (ts, sq, px, fee, asset) in trades {
            if ts >= ds + DAY {
                if ts <= t_bal {
                    q_after += sq;
                }
                continue;
            }
            let fee_usd = if matches!(asset.as_str(), "USDT" | "USDC") {
                fee
            } else {
                fee * bars.get(&format!("spot:{asset}USDT")).and_then(|b| interp_at(b, ts)).unwrap_or(0.0)
            };
            day_trades.push((ts, sq, px, fee_usd));
        }
        day_trades.sort_by_key(|x| x.0);
        let q0 = q_now - q_after - day_trades.iter().map(|x| x.1).sum::<f64>();
        let m0 = marks.iter().find(|x| x.0 == ds).map(|x| x.1).ok_or_else(|| anyhow!("{sym}: no mark at the day start"))?;
        eprintln!("leg {sym}: q0 {q0:.4} at {m0:.4}, {} trades, funding {:.4}", day_trades.len(), funding.iter().map(|x| x.1).sum::<f64>());
        legs.push(Leg { q0, m0, trades: day_trades, funding, marks });
    }

    let inp = Inputs {
        ds,
        horizon_s: cfg.mm_horizon_s,
        fills,
        q_end,
        m0: state.map(|s| s.m0).unwrap_or_default(),
        bars,
        legs,
        rebates,
        h_before,
    };
    let beta: Box<dyn Fn(&str) -> f64> = match &cfg.beta {
        Some(b) => {
            let mut est = Betas::new(b.clone());
            if let Ok(v) = c.query_row("SELECT v FROM kv WHERE k = 'beta'", [], |r| r.get::<_, String>(0)) {
                est.load(&v)?;
            }
            let est = RefCell::new(est);
            Box::new(move |k| est.borrow().beta(k))
        }
        None => {
            let fixed: HashMap<String, f64> = cfg.markets.iter().map(|mc| (format!("{}:{}", mc.venue, mc.symbol), mc.beta)).collect();
            Box::new(move |k| fixed.get(k).copied().unwrap_or(1.0))
        }
    };
    let mut d = Day::new(&inp, m, scope, beta, cfg.beta_vs.clone());
    d.book_hedge(from_hour);
    let live = desk_rows(&c, ds, ds + DAY)?;
    let (rows, check) = rebuild(&mut d, &live, from, to)?;

    // the report: the live rows before `from` against the recompute, then the repaired span hour by hour
    let f2 = |x: Option<f64>| x.map_or_else(|| "-".into(), |v| format!("{v:.2}"));
    eprintln!("{:<6} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}", "check", "trading", "recomp", "mm", "recomp", "hedge", "recomp",
              "rebates", "recomp");
    for (r, x) in check.iter().step_by(6) {
        eprintln!("{:<6} {:>9} {:>9.2} {:>9} {:>9.2} {:>9} {:>9.2} {:>9} {:>9.2}", hm(r.t), f2(r.trading), x.trading, f2(r.mm), x.mm,
                  f2(r.hedge), x.hedge, f2(r.rebates), x.rebates);
    }
    let old: HashMap<i64, &DeskRow> = live.iter().map(|r| (r.t, r)).collect();
    eprintln!("{:<6} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9}", "row", "day pnl", "trading", "(old)", "mm", "(old)", "hedge",
              "rebates", "other", "equity");
    let mut last_hour = -1;
    for r in &rows {
        let h = (r.t - ds) / HOUR;
        if h != last_hour || r.t == rows.last().map_or(0, |x| x.t) {
            last_hour = h;
            let o = old.get(&r.t);
            eprintln!("{:<6} {:>9.2} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9} {:>9.2}", hm(r.t), r.pnl_day, f2(r.trading),
                      f2(o.and_then(|o| o.trading)), f2(r.mm), f2(o.and_then(|o| o.mm)), f2(r.hedge), f2(r.rebates), f2(r.other()), r.equity);
        }
    }
    if let Some(p) = csv {
        let mut s = String::from("t,new,equity,pnl_day,inventory,futures,trading,hedged,realized,floating,hedge,mm,rebates\n");
        for r in &rows {
            s += &format!("{},{},{},{},{},{},{},{},{},{},{},{},{}\n", r.t, !old.contains_key(&r.t) as i32, r.equity, r.pnl_day, r.inventory,
                          r.futures, f2(r.trading), f2(r.hedged), f2(r.realized), f2(r.floating), f2(r.hedge), f2(r.mm), f2(r.rebates));
        }
        std::fs::write(p, s)?;
    }
    // the kept day (the day tables' row): Π, its split and market making as they stood at the day's end; its Day
    // PnL, hedge and rebates as the desk kept them at the roll; Other what they leave
    let kk = format!("dayreal:{day}");
    let kept: Option<String> = c.query_row("SELECT v FROM kv WHERE k = ?", [&kk], |r| r.get(0)).ok();
    let mut new_kept = None;
    if to >= ds + DAY
        && let Some(v) = &kept
        && let Ok(mut j) = serde_json::from_str::<Value>(v)
    {
        let e = d.at(ds + DAY - 1);
        let num = |j: &Value, k: &str| j.get(k).and_then(Value::as_f64);
        let (pnl_day, hedge, reb) = (num(&j, "pnl_day").unwrap_or(0.0), num(&j, "hedge").unwrap_or(e.hedge), num(&j, "rebates").unwrap_or(e.rebates));
        eprintln!("kept {day}: trading {} -> {:.2}, mm {} -> {:.2}, other {} -> {:.2} (Day PnL {pnl_day:.2}, hedge {hedge:.2}, rebates {reb:.2}; \
                   recomputed hedge {:.2}, rebates {:.2})", f2(num(&j, "trading")), e.trading, f2(num(&j, "mm")), e.mm, f2(num(&j, "other")),
                  pnl_day - e.trading - hedge - reb, e.hedge, e.rebates);
        j["trading"] = serde_json::json!(e.trading);
        j["realized"] = serde_json::json!(e.realized);
        j["realized_old"] = serde_json::json!(e.realized_old);
        j["floating"] = serde_json::json!(e.floating);
        j["mm"] = serde_json::json!(e.mm);
        j["inventory"] = serde_json::json!(e.trading - e.mm);
        j["other"] = serde_json::json!(pnl_day - e.trading - hedge - reb);
        new_kept = Some(j.to_string());
    }
    let new = rows.iter().filter(|r| !old.contains_key(&r.t)).count();
    eprintln!("{} rows: {new} new, {} recomputed; hour blocks from {}", rows.len(), rows.len() - new, hm(from_hour));
    if dry_run {
        eprintln!("dry run: nothing written");
        return Ok(());
    }
    let mut c = c;
    let tx = c.transaction()?;
    for r in &rows {
        tx.execute(
            "INSERT INTO equity (t, account, equity, pnl_day, markout_pnl, inventory, futures_notional, trading, hedged, realized, \
             floating, hedge, mm, rebates) VALUES (?, '*', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(t, account) DO UPDATE SET \
             trading = excluded.trading, hedged = excluded.hedged, realized = excluded.realized, floating = excluded.floating, \
             hedge = excluded.hedge, mm = excluded.mm, rebates = excluded.rebates",
            params![r.t, r.equity, r.pnl_day, r.inventory, r.futures, r.trading, r.hedged, r.realized, r.floating, r.hedge, r.mm, r.rebates],
        )?;
    }
    for (t, b) in d.book.hours.range(from_hour..ds + DAY) {
        tx.execute(
            "INSERT OR REPLACE INTO pnl_hours (t, trading, hedged, factor, ref_hedge, factor_hedge, fills, volume, covered_s, backfilled_s) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            params![t, b.trading, b.hedged(), b.factor(), b.ref_hedge, b.factor_hedge, b.fills, b.volume, b.backfilled_s],
        )?;
    }
    if let Some(v) = &new_kept {
        tx.execute("UPDATE kv SET v = ? WHERE k = ?", params![v, kk])?;
        tx.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", params![format!("repair:day-rows:{day}:kept-before"), kept])?;
    }
    let rec = serde_json::json!({"from": from, "to": to, "rows": rows.len(), "new": new, "hours_from": from_hour, "at": now});
    tx.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", params![format!("repair:day-rows:{day}"), rec.to_string()])?;
    tx.commit()?;
    eprintln!("written");
    Ok(())
}

fn hm(t: i64) -> String {
    let m = t.rem_euclid(DAY) / MIN;
    format!("{:02}:{:02}", m / 60, m % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::{Info, SymbolInfo};
    use approx::assert_relative_eq;

    const DS: i64 = 1_000 * DAY;

    fn market() -> Market {
        let mut info: Info = HashMap::new();
        info.insert(Venue::Spot, HashMap::from([("AAAUSDT".to_string(), SymbolInfo::new("AAA", "USDT", 0.0))]));
        info.insert(Venue::Usdm, HashMap::new());
        let mut m = Market::new(info, 120.0, 50.0);
        m.ensure("AAAUSDT", Venue::Spot, None);
        m
    }

    fn row(t: i64, pnl_day: f64, trading: f64, hedge: f64, mm: f64) -> DeskRow {
        DeskRow { t, equity: 1000.0 + pnl_day, pnl_day, inventory: 0.0, futures: 0.0, trading: Some(trading), hedged: Some(trading),
                  realized: Some(0.0), floating: Some(trading), hedge: Some(hedge), mm: Some(mm), rebates: Some(0.0) }
    }

    /// Price 10 → 12 linearly over the day; 1 held at the start, 1 bought at 10.5 at 06:00 (marked +10 bps), a
    /// hedge leg short 1 at 10. Rows live until 07:00 and from 22:00, none between.
    #[test]
    fn a_gap_is_filled_from_the_day_and_the_rows_around_it() {
        let px = |t: i64| 10.0 + 2.0 * (t - DS) as f64 / DAY as f64;
        let bars: Vec<(i64, f64, f64)> = (0..1441).map(|k| {
            let t = DS + k * MIN;
            (t, px(t), px(t + MIN))
        }).collect();
        let t_f = DS + 6 * HOUR;
        let mut f = FillRec::new("f", t_f, "a", "AAAUSDT", Venue::Spot, Side::Buy, 10.5, 1.0);
        f.mk_raw.0 = [Some(1.0), Some(5.0), Some(10.0), Some(10.0)];
        f.mk.0 = f.mk_raw.0;
        let leg = Leg { q0: -1.0, m0: 10.0, trades: vec![], funding: vec![(DS + 8 * HOUR, 0.25)], marks: bars.clone() };
        let inp = Inputs {
            ds: DS,
            horizon_s: 60,
            fills: vec![f],
            q_end: HashMap::from([("AAA".to_string(), 2.0)]),
            m0: [("AAA".to_string(), 10.0)].into_iter().collect(),
            bars: HashMap::from([("spot:AAAUSDT".to_string(), bars)]),
            legs: vec![leg],
            rebates: vec![(DS + 9 * HOUR, "USDT".into(), 1.5)],
            h_before: 0.0,
        };
        let mut d = Day::new(&inp, market(), vec!["spot:AAAUSDT".into()], Box::new(|_| 1.0), None);
        d.book_hedge(DS);
        // Π(t) = 1 (M − 10) + 1 (M − 10.5) after the fill
        let t = DS + 12 * HOUR;
        let x = d.at(t);
        assert_relative_eq!(x.trading, (px(t) - 10.0) + (px(t) - 10.5), epsilon = 1e-9);
        assert_relative_eq!(x.mm, 10.5 * 10.0 / 1e4, epsilon = 1e-9);
        assert_relative_eq!(x.hedge, -(px(t) - 10.0) + 0.25, epsilon = 1e-9);
        assert_relative_eq!(x.rebates, 1.5);
        assert_relative_eq!(x.inventory, 2.0 * px(t), epsilon = 1e-9);
        // before the fill: Q = 1
        assert_relative_eq!(d.at(DS + 3 * HOUR).trading, px(DS + 3 * HOUR) - 10.0, epsilon = 1e-9);

        // live rows: Other 0.5 before the gap, 1.5 after it; a 22:00 row whose split was wrong (an unswept fill)
        let at = |d: &mut Day, t: i64| d.at(t);
        let mut live = vec![];
        for k in 0..84 {
            let t = DS + k * 5 * MIN;
            let x = at(&mut d, t);
            live.push(row(t, x.trading + x.hedge + x.rebates + 0.5, x.trading, x.hedge, x.mm));
        }
        let tb = DS + 22 * HOUR;
        let xb = at(&mut d, tb);
        live.push(row(tb, xb.trading + xb.hedge + xb.rebates + 1.5, xb.trading - 7.0, xb.hedge, 0.0));
        let (rows, check) = rebuild(&mut d, &live, DS + 7 * HOUR, DS + DAY).unwrap();
        assert!(check.iter().all(|(r, x)| (r.trading.unwrap() - x.trading).abs() < 1e-9));
        // one row a minute in (06:55, 22:00), and the 22:00 row with its split recomputed
        let gap: Vec<&DeskRow> = rows.iter().filter(|r| r.t < tb).collect();
        assert_eq!(gap.len(), (22 * 60 - 6 * 60 - 55 - 1) as usize);
        let mid = rows.iter().find(|r| r.t == DS + 14 * HOUR + 27 * MIN).unwrap();
        let w = (mid.t - (DS + 6 * HOUR + 55 * MIN)) as f64 / (tb - (DS + 6 * HOUR + 55 * MIN)) as f64;
        assert_relative_eq!(mid.other().unwrap(), 0.5 + w, epsilon = 1e-9);
        assert_relative_eq!(mid.equity - mid.pnl_day, 1000.0, epsilon = 1e-9);
        let last = rows.last().unwrap();
        assert_eq!(last.t, tb);
        assert_relative_eq!(last.trading.unwrap(), xb.trading, epsilon = 1e-9);
        assert_relative_eq!(last.pnl_day, live.last().unwrap().pnl_day);
        assert_relative_eq!(last.other().unwrap(), 1.5, epsilon = 1e-9);
    }

    #[test]
    fn times_of_the_day() {
        assert_eq!(hhmm(DS, "07:10").unwrap(), DS + 7 * HOUR + 10 * MIN);
        assert_eq!(hhmm(DS, "24:00").unwrap(), DS + DAY);
        assert!(hhmm(DS, "24:01").is_err());
        assert_eq!(hm(DS + 22 * HOUR + 15 * MIN), "22:15");
    }
}
