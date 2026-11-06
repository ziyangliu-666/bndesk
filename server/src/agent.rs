//! `/api/agent/*`: the desk's history for agents (research, monitoring), read-only and self-describing.
//!
//! Not a page's view of one moment: every figure the desk and the engine keep, over any range, on one time grid.
//! `GET /api/agent` is the catalog (what each series is, in what unit, since when, how it changed); `/series`
//! puts any of them side by side; `/pnl` is the P&L split per bar; `/fills` every fill with its marks and price
//! path; `/events` what happened (alerts, transfers, distributions, definition changes); `/state` the desk and the
//! engine now; `/markouts` and `/klines` as the pages have them. Tabular answers come as JSON or `format=csv`.
//!
//! Access: the session cookie as for a page, or `Authorization: Bearer <BNDESK_READ_TOKEN>`, which opens these
//! paths only and GET only (`auth::middleware`). Nothing here writes, and no answer carries an email or a key.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use rusqlite::{Connection, params_from_iter};
use serde_json::{Map, Value, json};

use crate::fills::{FillRec, HK, PATH_S, REF_ANCHORS, TOX_HORIZONS};
use crate::history::{self, ApiError, STEPS};
use crate::server::HubHandle;
use crate::telemetry::Telemetry;

const DAY: i64 = 86_400_000;
/// Grid steps `/series` takes (s): the engine pushes every 15 s, the desk keeps a row every 5 s.
const SERIES_STEPS: [i64; 9] = [15, 60, 300, 900, 1800, 3600, 14_400, 86_400, 604_800];
/// Buckets in one `/series` answer at most, and the default it aims for when no step is given.
const MAX_BUCKETS: i64 = 20_000;
const AIM_BUCKETS: i64 = 1_500;
/// Engine samples read for one answer at most (a sample is inflated whole): a long range is read thinned.
const MAX_ENGINE_SAMPLES: i64 = 40_000;
const MAX_FILLS: i64 = 200_000;
const DEFAULT_FILLS: i64 = 50_000;
/// Stablecoins a pool account quotes with: its capital in `capital.*`.
const STABLES: [&str; 4] = ["USDT", "USDC", "FDUSD", "USD"];

/// Changes to what a series means, for an agent comparing across them. Newest last.
const CHANGES: [(&str, &str, &str); 2] = [
    ("2026-10-17", "desk.mm",
     "A fill whose price at t + 60 s was not taken live (the desk down then) is marked from klines; before this day such fills were valued at the mid at the time of reading."),
    ("2026-11-06", "desk.mm",
     "Market making marks each fill against the reference fair F(t+60s) = M(t-10s)*R(t+60s)/R(t-10s) (R the leader perp) instead of the instrument's own mid at t+60s, so the pull of the desk's own quotes on that mid is not charged to it. Days before keep the own-mid mark (40 to 90 USD a day lower on 2026-10-27..11-05). desk.inventory_pnl = trading - mm moves the other way."),
];

pub struct Agent {
    history: Arc<history::Api>,
    tel: Arc<Telemetry>,
    hub: HubHandle,
    /// The markout horizon market making marks at (index into `HK`).
    mm_h: usize,
}

impl Agent {
    pub fn new(history: Arc<history::Api>, tel: Arc<Telemetry>, hub: HubHandle, mm_horizon_s: i64) -> Arc<Agent> {
        let mm_h = HK.iter().position(|k| *k == mm_horizon_s.to_string()).unwrap_or(2);
        Arc::new(Agent { history, tel, hub, mm_h })
    }
}

pub fn routes(a: Arc<Agent>) -> Router {
    Router::new()
        .route("/api/agent", get(catalog))
        .route("/api/agent/state", get(state))
        .route("/api/agent/series", get(series))
        .route("/api/agent/pnl", get(pnl))
        .route("/api/agent/fills", get(fills))
        .route("/api/agent/events", get(events))
        .route("/api/agent/markouts", get(markouts))
        .with_state(a)
}

type Q = Query<HashMap<String, String>>;

fn bad(msg: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, msg.into())
}

fn now_ms() -> i64 {
    crate::clock::CLOCK.now()
}

fn json_body(v: &Value) -> Response {
    ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], v.to_string()).into_response()
}

// ================================ time ================================

/// A time as an agent writes it: epoch ms (or s, under 10^11), `now`, relative (`-90m`, `-24h`, `-7d`, `-30s`,
/// `-2w`), a UTC date (`2026-11-05`) or date and time (`2026-11-05T12:00`, seconds and a `Z` optional).
pub fn when(s: &str, now: i64) -> Result<i64, String> {
    let s = s.trim();
    if s == "now" {
        return Ok(now);
    }
    if let Some(r) = s.strip_prefix('-') {
        let (n, unit) = r.split_at(r.find(|c: char| !c.is_ascii_digit()).unwrap_or(r.len()));
        let n: i64 = n.parse().map_err(|_| format!("bad time {s:?}"))?;
        let ms = match unit {
            "s" => 1_000,
            "m" => 60_000,
            "h" => 3_600_000,
            "d" => DAY,
            "w" => 7 * DAY,
            _ => return Err(format!("bad time {s:?}: a unit of s, m, h, d or w")),
        };
        return Ok(now - n * ms);
    }
    if s.bytes().all(|b| b.is_ascii_digit()) && !s.is_empty() {
        let n: i64 = s.parse().map_err(|_| format!("bad time {s:?}"))?;
        return Ok(if n < 100_000_000_000 { n * 1000 } else { n });
    }
    let t = s.trim_end_matches('Z');
    let dt = if t.len() == 10 {
        chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0))
    } else {
        chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S")
            .or_else(|_| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M"))
            .ok()
    };
    dt.map(|d| d.and_utc().timestamp_millis()).ok_or_else(|| format!("bad time {s:?}"))
}

/// `from` and `to` from the query, `to` now and `from` `span` before it by default.
fn range(q: &HashMap<String, String>, span: i64) -> Result<(i64, i64), ApiError> {
    let now = now_ms();
    let get = |k: &str| q.get(k).filter(|v| !v.is_empty()).map(|v| when(v, now).map_err(bad)).transpose();
    let to = get("to")?.unwrap_or(now);
    let from = get("from")?.unwrap_or(to - span);
    if from >= to {
        return Err(bad("from must be before to"));
    }
    Ok((from, to))
}

fn iso(t: i64) -> String {
    chrono::DateTime::from_timestamp_millis(t).map_or_else(String::new, |d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

// ================================ csv ================================

fn wants_csv(q: &HashMap<String, String>) -> Result<bool, ApiError> {
    match q.get("format").map(String::as_str) {
        None | Some("") | Some("json") => Ok(false),
        Some("csv") => Ok(true),
        Some(x) => Err(bad(format!("bad format {x:?}: json or csv"))),
    }
}

fn cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) if s.contains([',', '"', '\n']) => format!("\"{}\"", s.replace('"', "\"\"")),
        Value::String(s) => s.clone(),
        v => v.to_string(),
    }
}

/// Rows of objects as CSV, with `cols` in that order.
fn csv(cols: &[&str], rows: &[Map<String, Value>]) -> Response {
    let mut out = cols.join(",");
    out.push('\n');
    for r in rows {
        let line: Vec<String> = cols.iter().map(|c| r.get(*c).map_or_else(String::new, cell)).collect();
        out.push_str(&line.join(","));
        out.push('\n');
    }
    ([(header::CONTENT_TYPE, "text/csv; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], out).into_response()
}

// ================================ grid ================================

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Agg {
    Last,
    First,
    Mean,
    Min,
    Max,
}

impl Agg {
    fn parse(s: Option<&str>) -> Result<Agg, ApiError> {
        Ok(match s {
            None | Some("") | Some("last") => Agg::Last,
            Some("first") => Agg::First,
            Some("mean") => Agg::Mean,
            Some("min") => Agg::Min,
            Some("max") => Agg::Max,
            Some(x) => Err(bad(format!("bad agg {x:?}: last, first, mean, min or max")))?,
        })
    }
}

/// The grid: buckets of `step` ms from the one holding `from`, aligned to UTC multiples of the step (a day or a
/// week to the P&L day's start).
#[derive(Debug, Clone, Copy)]
pub struct Grid {
    pub start: i64,
    pub step: i64,
    pub n: usize,
}

impl Grid {
    pub fn new(from: i64, to: i64, step: i64, anchor: i64) -> Grid {
        let anchor = if step >= DAY { anchor } else { 0 };
        let start = from - (from - anchor).rem_euclid(step);
        Grid { start, step, n: ((to - start + step - 1) / step).max(0) as usize }
    }

    fn times(&self) -> Vec<i64> {
        (0..self.n as i64).map(|i| self.start + i * self.step).collect()
    }

    /// `pts` (by time) aggregated per bucket.
    pub fn fill(&self, pts: &[(i64, f64)], agg: Agg) -> Vec<Option<f64>> {
        let mut acc: Vec<(f64, u32)> = vec![(0.0, 0); self.n];
        for &(t, v) in pts {
            if t < self.start || !v.is_finite() {
                continue;
            }
            let i = ((t - self.start) / self.step) as usize;
            let Some(a) = acc.get_mut(i) else { continue };
            *a = match (agg, a.1) {
                (_, 0) => (v, 1),
                (Agg::Last, k) => (v, k + 1),
                (Agg::First, k) => (a.0, k + 1),
                (Agg::Mean, k) => (a.0 + v, k + 1),
                (Agg::Min, k) => (a.0.min(v), k + 1),
                (Agg::Max, k) => (a.0.max(v), k + 1),
            };
        }
        acc.into_iter().map(|(x, k)| (k > 0).then(|| if agg == Agg::Mean { x / k as f64 } else { x })).collect()
    }
}

fn pick_step(q: &HashMap<String, String>, from: i64, to: i64) -> Result<i64, ApiError> {
    match q.get("step").filter(|v| !v.is_empty()) {
        Some(v) => {
            let s: i64 = v.parse().map_err(|_| bad(format!("bad step {v:?}")))?;
            if !SERIES_STEPS.contains(&s) {
                return Err(bad(format!("step must be one of {SERIES_STEPS:?} (s)")));
            }
            Ok(s * 1000)
        }
        None => Ok(SERIES_STEPS.iter().map(|s| s * 1000).find(|s| (to - from) / s <= AIM_BUCKETS).unwrap_or(604_800_000)),
    }
}

// ================================ series ================================

/// The desk's own columns: (key, column or derivation, unit, meaning).
const DESK: [(&str, &str, &str); 12] = [
    ("equity", "USD", "Equity of every valued account"),
    ("pnl_day", "USD", "Day PnL: equity change since the P&L day's start, transfers and distributions out; restarts each day"),
    ("trading", "USD", "Trading PnL of the spot inventory (fills and holdings, fees in), today so far"),
    ("mm", "USD", "Market making today: each fill against the fair 60 s later, minus fees (see changes)"),
    ("inventory_pnl", "USD", "trading - mm: what the held inventory made"),
    ("hedge", "USD", "The hedge's legs today: price, fees, funding"),
    ("rebates", "USD", "Market-maker rebates credited today"),
    ("other", "USD", "pnl_day - trading - hedge - rebates: what the split does not explain"),
    ("realized", "USD", "Sells matched FIFO (to today's buys and the opening inventory), today"),
    ("floating", "USD", "The inventory left, at its price now against its cost"),
    ("inventory_value", "USD", "Spot inventory x mid, now"),
    ("futures_notional", "USD", "Futures notional, signed, now"),
];
const ACCT: [(&str, &str, &str); 4] = [
    ("equity", "USD", "The account's equity"),
    ("pnl_day", "USD", "The account's Day PnL, restarting each day"),
    ("inventory_value", "USD", "Its spot inventory x mid"),
    ("futures_notional", "USD", "Its futures notional, signed"),
];
const CAPITAL: [(&str, &str, &str); 3] = [
    ("util", "ratio 0..1", "locked / (free + locked) of the stablecoins (USDT, USDC, FDUSD, USD): capital in open orders"),
    ("free", "USD", "Free stablecoins"),
    ("locked", "USD", "Stablecoins in open orders"),
];

/// A requested key resolved: where its points come from.
#[derive(Debug, Clone, PartialEq)]
enum Src {
    Desk(&'static str),
    Acct(String, &'static str),
    Engine(String),
    Capital(String, &'static str),
}

/// One equity row as `/series` reads it.
struct EqRow {
    t: i64,
    account: String,
    v: [Option<f64>; 11],
}
const EQ_COLS: &str = "t, account, equity, pnl_day, trading, mm, hedge, rebates, realized, floating, inventory, futures_notional, NULL";

impl EqRow {
    /// The desk key's value (account "*"), derived ones included.
    fn desk(&self, k: &str) -> Option<f64> {
        let [equity, pnl_day, trading, mm, hedge, rebates, realized, floating, inv, fut, _] = self.v;
        match k {
            "equity" => equity,
            "pnl_day" => pnl_day,
            "trading" => trading,
            "mm" => mm,
            "inventory_pnl" => Some(trading? - mm?),
            "hedge" => hedge,
            "rebates" => rebates,
            "other" => Some(pnl_day? - trading? - hedge? - rebates?),
            "realized" => realized,
            "floating" => floating,
            "inventory_value" => inv,
            "futures_notional" => fut,
            _ => None,
        }
    }

    fn acct(&self, k: &str) -> Option<f64> {
        let [equity, pnl_day, .., inv, fut, _] = self.v;
        match k {
            "equity" => equity,
            "pnl_day" => pnl_day,
            "inventory_value" => inv,
            "futures_notional" => fut,
            _ => None,
        }
    }
}

fn eq_rows(c: &Connection, from: i64, to: i64, accounts: &[String]) -> rusqlite::Result<Vec<EqRow>> {
    let have: Vec<String> = c.prepare("PRAGMA table_info(equity)")?.query_map([], |r| r.get(1))?.collect::<Result<_, _>>()?;
    let cols = EQ_COLS
        .split(", ")
        .map(|n| if n == "NULL" || have.iter().any(|h| h == n) { n.to_string() } else { "NULL".into() })
        .collect::<Vec<_>>()
        .join(", ");
    let marks = vec!["?"; accounts.len()].join(",");
    let sql = format!("SELECT {cols} FROM equity WHERE t >= ? AND t < ? AND account IN ({marks}) ORDER BY t");
    let mut args: Vec<rusqlite::types::Value> = vec![from.into(), to.into()];
    args.extend(accounts.iter().map(|a| a.clone().into()));
    let mut st = c.prepare(&sql)?;
    st.query_map(params_from_iter(args), |r| {
        let mut v = [None; 11];
        for (i, x) in v.iter_mut().enumerate() {
            *x = r.get::<_, Option<f64>>(i + 2)?;
        }
        // the desk row writes realized + realized_old as realized
        Ok(EqRow { t: r.get(0)?, account: r.get(1)?, v })
    })?
    .collect()
}

/// The accounts with equity rows in the last two days (the desk's own "*" left out).
fn accounts(c: &Connection, now: i64) -> rusqlite::Result<Vec<String>> {
    let mut st = c.prepare("SELECT DISTINCT account FROM equity WHERE t >= ? AND account != '*' ORDER BY account")?;
    st.query_map([now - 2 * DAY], |r| r.get(0))?.collect()
}

/// Splits `keys` (comma-separated, `*` at the end of a name expands) into sources; unknown names are errors.
fn resolve(keys: &str, accts: &[String], pools: &[String]) -> Result<Vec<(String, Src)>, ApiError> {
    let mut out: Vec<(String, Src)> = vec![];
    let mut push = |k: String, s: Src| {
        if !out.iter().any(|(x, _)| *x == k) {
            out.push((k, s));
        }
    };
    for raw in keys.split(',').map(str::trim).filter(|k| !k.is_empty()) {
        let (ns, rest) = raw.split_once('.').ok_or_else(|| bad(format!("bad key {raw:?}: desk.*, acct.*, capital.*, engine.*")))?;
        let star = |name: &str, pat: &str| pat == "*" || pat == name || pat.strip_suffix('*').is_some_and(|p| name.starts_with(p));
        match ns {
            "desk" => {
                let hits: Vec<_> = DESK.iter().filter(|(k, ..)| star(k, rest)).collect();
                if hits.is_empty() {
                    return Err(bad(format!("unknown key {raw:?}")));
                }
                for (k, ..) in hits {
                    push(format!("desk.{k}"), Src::Desk(k));
                }
            }
            "acct" | "capital" => {
                let (who, col) = rest.split_once('.').unwrap_or((rest, "*"));
                let (names, cols): (&[String], &[(&str, &str, &str)]) = if ns == "acct" { (accts, &ACCT) } else { (pools, &CAPITAL) };
                let pool = ["pool".to_string()];
                let whos: Vec<&String> = names.iter().chain(if ns == "capital" { &pool[..] } else { &[] }).filter(|n| star(n, who)).collect();
                let cs: Vec<&(&str, &str, &str)> = cols.iter().filter(|(k, ..)| star(k, col)).collect();
                if whos.is_empty() || cs.is_empty() {
                    return Err(bad(format!("unknown key {raw:?}")));
                }
                for w in whos {
                    for (c, ..) in &cs {
                        let s = if ns == "acct" { Src::Acct(w.clone(), c) } else { Src::Capital(w.clone(), c) };
                        push(format!("{ns}.{w}.{c}"), s);
                    }
                }
            }
            "engine" => push(raw.to_string(), Src::Engine(rest.to_string())),
            _ => return Err(bad(format!("unknown namespace {ns:?}: desk, acct, capital, engine"))),
        }
    }
    if out.is_empty() {
        return Err(bad("keys required, e.g. keys=desk.pnl_day,capital.*.util (see GET /api/agent)"));
    }
    Ok(out)
}

/// Pool accounts from an engine sample's keys: `balances.<account>.<stable>.free|locked`.
fn pools_of<'a>(keys: impl Iterator<Item = &'a String>) -> Vec<String> {
    let mut out: Vec<String> = keys
        .filter_map(|k| {
            let p: Vec<&str> = k.split('.').collect();
            (p.len() == 4 && p[0] == "balances" && STABLES.contains(&p[2]) && (p[3] == "free" || p[3] == "locked")).then(|| p[1].to_string())
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Free and locked stablecoins per pool account in each sample, and the pool's: account -> [(t, free, locked)].
fn capital(ts: &[i64], cols: &BTreeMap<String, Vec<Option<f64>>>) -> BTreeMap<String, Vec<(i64, f64, f64)>> {
    let mut out: BTreeMap<String, Vec<(i64, f64, f64)>> = BTreeMap::new();
    let pools = pools_of(cols.keys());
    for (i, &t) in ts.iter().enumerate() {
        let (mut pf, mut pl, mut any) = (0.0, 0.0, false);
        for a in &pools {
            let (mut f, mut l, mut seen) = (0.0, 0.0, false);
            for s in STABLES {
                for (side, acc) in [("free", &mut f), ("locked", &mut l)] {
                    if let Some(Some(v)) = cols.get(&format!("balances.{a}.{s}.{side}")).and_then(|c| c.get(i)) {
                        *acc += v;
                        seen = true;
                    }
                }
            }
            if seen {
                out.entry(a.clone()).or_default().push((t, f, l));
                (pf, pl, any) = (pf + f, pl + l, true);
            }
        }
        if any {
            out.entry("pool".into()).or_default().push((t, pf, pl));
        }
    }
    out
}

async fn series(State(a): State<Arc<Agent>>, Query(q): Q) -> Result<Response, ApiError> {
    let (from, to) = range(&q, DAY)?;
    let step = pick_step(&q, from, to)?;
    let agg = Agg::parse(q.get("agg").map(String::as_str))?;
    let grid = Grid::new(from, to, step, a.history.day_start_min() * 60_000);
    if grid.n as i64 > MAX_BUCKETS {
        return Err(bad(format!("{} buckets: at most {MAX_BUCKETS}; a larger step or a shorter range", grid.n)));
    }
    let now = now_ms();
    let accts = a.history.read(move |c| accounts(c, now)).await?;
    let pools = {
        let (_, cols) = a.tel.samples(now - 30 * 60_000, now, 0, &["balances.".to_string() + "*"]).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        pools_of(cols.keys())
    };
    let keys = q.get("keys").map_or("", String::as_str);
    let srcs = resolve(keys, &accts, &pools)?;

    let mut cols: Vec<(String, Vec<Option<f64>>)> = vec![];
    // the desk's rows: the desk's own and the accounts asked for, in one read
    let mut want: Vec<String> = vec![];
    for (_, s) in &srcs {
        match s {
            Src::Desk(_) if !want.contains(&"*".to_string()) => want.push("*".into()),
            Src::Acct(w, _) if !want.contains(w) => want.push(w.clone()),
            _ => {}
        }
    }
    if !want.is_empty() {
        let (f, t, w) = (grid.start, to, want.clone());
        let rows = a.history.read(move |c| eq_rows(c, f, t, &w)).await?;
        for (k, s) in &srcs {
            let pts: Vec<(i64, f64)> = match s {
                Src::Desk(c) => rows.iter().filter(|r| r.account == "*").filter_map(|r| r.desk(c).map(|v| (r.t, v))).collect(),
                Src::Acct(w, c) => rows.iter().filter(|r| r.account == *w).filter_map(|r| r.acct(c).map(|v| (r.t, v))).collect(),
                _ => continue,
            };
            cols.push((k.clone(), grid.fill(&pts, agg)));
        }
    }
    // the engine's samples: thinned to a few per bucket for a long range (the last of each, or about 60 a bucket
    // for an aggregate over it), never more than MAX_ENGINE_SAMPLES
    let mut eng: Vec<String> = srcs.iter().filter_map(|(_, s)| if let Src::Engine(k) = s { Some(k.clone()) } else { None }).collect();
    let cap = srcs.iter().any(|(_, s)| matches!(s, Src::Capital(..)));
    if cap {
        eng.push("balances.*".into());
    }
    if !eng.is_empty() {
        let per = if agg == Agg::Last || agg == Agg::First { 1 } else { 60 };
        let thin = (step / per).max((to - grid.start) / MAX_ENGINE_SAMPLES);
        let thin = if thin <= 15_000 { 0 } else { thin };
        let (ts, ecols) = a.tel.samples(grid.start, to - 1, thin, &eng).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let caps = if cap { capital(&ts, &ecols) } else { BTreeMap::new() };
        for (k, s) in &srcs {
            match s {
                Src::Engine(name) => {
                    let names: Vec<&String> = match name.strip_suffix('*') {
                        Some(p) => ecols.keys().filter(|x| x.starts_with(p)).collect(),
                        None => ecols.keys().filter(|x| *x == name).collect(),
                    };
                    if names.is_empty() {
                        cols.push((k.clone(), vec![None; grid.n]));
                    }
                    for n in names {
                        let pts: Vec<(i64, f64)> = ts.iter().zip(&ecols[n]).filter_map(|(t, v)| v.map(|v| (*t, v))).collect();
                        cols.push((format!("engine.{n}"), grid.fill(&pts, agg)));
                    }
                }
                Src::Capital(w, c) => {
                    let pts: Vec<(i64, f64)> = caps
                        .get(w)
                        .map(|v| {
                            v.iter()
                                .filter_map(|&(t, f, l)| match *c {
                                    "free" => Some((t, f)),
                                    "locked" => Some((t, l)),
                                    _ => (f + l > 0.0).then(|| (t, l / (f + l))),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    cols.push((k.clone(), grid.fill(&pts, agg)));
                }
                _ => {}
            }
        }
    }
    let ts = grid.times();
    if wants_csv(&q)? {
        let names: Vec<&str> = std::iter::once("t").chain(std::iter::once("time")).chain(cols.iter().map(|(k, _)| k.as_str())).collect();
        let rows: Vec<Map<String, Value>> = ts
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let mut m = Map::new();
                m.insert("t".into(), json!(t));
                m.insert("time".into(), json!(iso(*t)));
                for (k, c) in &cols {
                    m.insert(k.clone(), json!(c[i]));
                }
                m
            })
            .collect();
        return Ok(csv(&names, &rows));
    }
    let v: Map<String, Value> = cols.into_iter().map(|(k, c)| (k, json!(c))).collect();
    Ok(json_body(&json!({
        "from": from, "to": to, "step": step / 1000, "agg": format!("{agg:?}").to_lowercase(),
        "note": "t: each bucket's start (ms, UTC); a value is the bucket's aggregate of what was kept in it, null where nothing was",
        "t": ts, "v": v,
    })))
}

// ================================ pnl ================================

/// Bars of the desk's P&L as changes in each bar: the running figures of `/api/history` differenced.
pub fn pnl_rows(bars: &[crate::protocol::HistoryBar]) -> Vec<Map<String, Value>> {
    let mut out = Vec::with_capacity(bars.len());
    let mut prev_c: Option<f64> = None;
    let mut last: [Option<f64>; 5] = [None; 5];
    let start = bars.first().map_or(0.0, |b| b.o);
    for b in bars {
        let pnl = b.c - prev_c.unwrap_or(b.o);
        prev_c = Some(b.c);
        let mut d = [None; 5];
        for (i, v) in [b.pi, b.mm, b.hedge, b.rebates, b.realized].into_iter().enumerate() {
            if let Some(v) = v {
                d[i] = Some(v - last[i].unwrap_or(0.0));
                last[i] = Some(v);
            }
        }
        let [trading, mm, hedge, rebates, realized] = d;
        let inv = trading.zip(mm).map(|(a, b)| a - b);
        let other = match (trading, hedge, rebates) {
            (Some(t), Some(h), Some(r)) => Some(pnl - t - h - r),
            _ => None,
        };
        let mut m = Map::new();
        for (k, v) in [
            ("t", json!(b.t)),
            ("time", json!(iso(b.t))),
            ("pnl", json!(pnl)),
            ("cum_pnl", json!(b.c - start)),
            ("mm", json!(mm)),
            ("inventory_pnl", json!(inv)),
            ("hedge", json!(hedge)),
            ("rebates", json!(rebates)),
            ("other", json!(other)),
            ("trading", json!(trading)),
            ("realized", json!(realized)),
            ("fills", json!(b.fills)),
            ("volume", json!(b.volume)),
            ("equity", json!(b.equity)),
            ("inventory_value", json!(b.inventory)),
            ("futures_notional", json!(b.futures)),
        ] {
            m.insert(k.into(), v);
        }
        out.push(m);
    }
    out
}

const PNL_COLS: [&str; 16] = ["t", "time", "pnl", "cum_pnl", "mm", "inventory_pnl", "hedge", "rebates", "other", "trading", "realized",
                              "fills", "volume", "equity", "inventory_value", "futures_notional"];

async fn pnl(State(a): State<Arc<Agent>>, Query(q): Q) -> Result<Response, ApiError> {
    let step = match q.get("step").filter(|v| !v.is_empty()) {
        Some(v) => v.parse::<i64>().map_err(|_| bad(format!("bad step {v:?}")))?,
        None => 3600,
    };
    if !STEPS.contains(&step) {
        return Err(bad(format!("step must be one of {STEPS:?} (s)")));
    }
    let (from, to) = range(&q, 7 * DAY)?;
    let from = from.max(to - history::MAX_BARS * step * 1000);
    let rows = pnl_rows(&a.history.bars_in(from, to, step).await?);
    if wants_csv(&q)? {
        return Ok(csv(&PNL_COLS, &rows));
    }
    Ok(json_body(&json!({
        "from": from, "to": to, "step": step,
        "note": "Each row is the bar's change (t its start, UTC): pnl = mm + inventory_pnl + hedge + rebates + other; trading = mm + inventory_pnl. A part is null before the desk kept it. cum_pnl runs from the range's start. equity, inventory_value and futures_notional are levels at the bar's end.",
        "rows": rows,
    })))
}

// ================================ fills ================================

fn marks(m: &crate::protocol::Marks) -> Value {
    Value::Object(HK.iter().zip(m.0).map(|(k, v)| (k.to_string(), json!(v))).collect())
}

fn fill_json(f: &FillRec, mm_h: usize) -> Map<String, Value> {
    let mut m = Map::new();
    let mm_bps = f.mk_raw.0[mm_h].map(|raw| f.fair_bps(mm_h).unwrap_or(raw));
    for (k, v) in [
        ("t", json!(f.ts)),
        ("time", json!(iso(f.ts))),
        ("id", json!(f.id)),
        ("account", json!(f.account)),
        ("symbol", json!(f.symbol)),
        ("venue", json!(f.venue.as_str())),
        ("side", json!(f.side.as_str())),
        ("price", json!(f.price)),
        ("qty", json!(f.qty)),
        ("notional", json!(f.notional())),
        ("fee", json!(f.fee)),
        ("fee_asset", json!(f.fee_asset)),
        ("maker", json!(f.maker)),
        ("conversion", json!(f.conversion())),
        ("fair", json!(f.fair)),
        ("edge_bps", json!(f.edge_bps)),
        ("mm_bps", json!(mm_bps)),
        ("raw_bps", marks(&f.mk_raw)),
        ("net_bps", marks(&f.mk)),
        ("fast_bps", marks(&f.mk_fast)),
        ("tox_bps", Value::Object(TOX_HORIZONS.iter().zip(f.tox).map(|(h, v)| (h.to_string(), json!(v))).collect())),
        ("refs", Value::Object(REF_ANCHORS.iter().zip(f.refs).map(|((k, _), v)| (k.to_string(), json!(v))).collect())),
        ("path", if f.pm.iter().all(Option::is_none) { Value::Null } else { json!({ "s": PATH_S, "mid": f.pm, "ref": f.pr }) }),
    ] {
        m.insert(k.into(), v);
    }
    m
}

const FILL_CSV: [&str; 30] = ["t", "time", "id", "account", "symbol", "venue", "side", "price", "qty", "notional", "fee", "fee_asset", "maker",
                              "conversion", "fair", "edge_bps", "mm_bps", "raw_1", "raw_10", "raw_60", "raw_300", "net_1", "net_10", "net_60",
                              "net_300", "fast_1", "fast_10", "fast_60", "fast_300", "path"];

fn fill_flat(mut m: Map<String, Value>) -> Map<String, Value> {
    for (pre, k) in [("raw", "raw_bps"), ("net", "net_bps"), ("fast", "fast_bps")] {
        if let Some(Value::Object(o)) = m.remove(k) {
            for (h, v) in o {
                m.insert(format!("{pre}_{h}"), v);
            }
        }
    }
    let path = m.remove("path").filter(|p| !p.is_null()).map(|p| json!(p.to_string()));
    m.insert("path".into(), path.unwrap_or(Value::Null));
    m
}

async fn fills(State(a): State<Arc<Agent>>, Query(q): Q) -> Result<Response, ApiError> {
    let (from, to) = range(&q, DAY)?;
    let limit = match q.get("limit").filter(|v| !v.is_empty()) {
        Some(v) => v.parse::<i64>().map_err(|_| bad(format!("bad limit {v:?}")))?.clamp(1, MAX_FILLS),
        None => DEFAULT_FILLS,
    };
    let mut cond = String::new();
    let mut args: Vec<rusqlite::types::Value> = vec![from.into(), to.into()];
    for k in ["symbol", "venue", "account", "side"] {
        if let Some(v) = q.get(k).filter(|v| !v.is_empty()) {
            if v.len() > 40 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                return Err(bad(format!("bad {k} {v:?}")));
            }
            cond.push_str(&format!(" AND {k} = ?"));
            args.push(match k {
                "symbol" => v.to_uppercase(),
                "account" => v.clone(),
                _ => v.to_lowercase(),
            }
            .into());
        }
    }
    let sql = format!("SELECT {} FROM fills WHERE ts >= ? AND ts < ?{cond} ORDER BY ts LIMIT {}", crate::store::FILL_COLS, limit + 1);
    let mut rows: Vec<FillRec> = a
        .history
        .read(move |c| c.prepare(&sql)?.query_map(params_from_iter(args), crate::store::row_fill)?.collect())
        .await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let mm_h = a.mm_h;
    let objs: Vec<Map<String, Value>> = rows.iter().map(|f| fill_json(f, mm_h)).collect();
    if wants_csv(&q)? {
        let flat: Vec<Map<String, Value>> = objs.into_iter().map(fill_flat).collect();
        return Ok(csv(&FILL_CSV, &flat));
    }
    Ok(json_body(&json!({
        "from": from, "to": to, "count": objs.len(), "truncated": more,
        "note": "One row per fill, oldest first. Marks in bps, signed for the desk (+ = the price moved its way), keyed by horizon (s): raw_bps against the instrument's own mid, net_bps less the reference's move since t+1s, fast_bps since t+0.2s; tox_bps the reference's move against the fill since t-5s. mm_bps the mark market making counts at 60 s. path: the instrument's mid and the reference's at each offset s around the fill.",
        "fills": objs,
    })))
}

// ================================ events ================================

async fn events(State(a): State<Arc<Agent>>, Query(q): Q) -> Result<Response, ApiError> {
    let (from, to) = range(&q, 7 * DAY)?;
    let mut ev: Vec<Value> = a
        .history
        .read(move |c| {
            let mut out = vec![];
            let mut st = c.prepare("SELECT id, since, rule, level, text, active FROM alerts WHERE since >= ? AND since < ? ORDER BY since")?;
            for r in st.query_map([from, to], |r| {
                Ok(json!({ "t": r.get::<_, i64>(1)?, "kind": "alert", "id": r.get::<_, String>(0)?, "rule": r.get::<_, Option<String>>(2)?,
                           "level": r.get::<_, Option<String>>(3)?, "text": r.get::<_, Option<String>>(4)?, "active": r.get::<_, Option<i64>>(5)? == Some(1) }))
            })? {
                out.push(r?);
            }
            // between the desk's own accounts or in from outside: the amount, never the addresses
            let have: Vec<String> = c.prepare("PRAGMA table_info(transfers)")?.query_map([], |r| r.get(1))?.collect::<Result<_, _>>()?;
            let usd = if have.iter().any(|h| h == "usd") { "usd" } else { "NULL" };
            let mut st = c.prepare(&format!("SELECT ts, asset, amount, {usd} FROM transfers WHERE ts >= ? AND ts < ? ORDER BY ts"))?;
            for r in st.query_map([from, to], |r| {
                Ok(json!({ "t": r.get::<_, i64>(0)?, "kind": "transfer", "asset": r.get::<_, Option<String>>(1)?,
                           "amount": r.get::<_, Option<f64>>(2)?, "usd": r.get::<_, Option<f64>>(3)? }))
            })? {
                out.push(r?);
            }
            let mut st = c.prepare("SELECT ts, account, asset, amount, info FROM dividends WHERE ts >= ? AND ts < ? ORDER BY ts")?;
            for r in st.query_map([from, to], |r| {
                Ok(json!({ "t": r.get::<_, i64>(0)?, "kind": "distribution", "account": r.get::<_, Option<String>>(1)?, "asset": r.get::<_, Option<String>>(2)?,
                           "amount": r.get::<_, Option<f64>>(3)?, "info": r.get::<_, Option<String>>(4)? }))
            })? {
                out.push(r?);
            }
            Ok(out)
        })
        .await?;
    for (day, key, what) in CHANGES {
        if let Ok(t) = when(day, 0)
            && t >= from
            && t < to
        {
            ev.push(json!({ "t": t, "kind": "definition", "key": key, "text": what }));
        }
    }
    ev.sort_by_key(|e| e["t"].as_i64().unwrap_or(0));
    Ok(json_body(&json!({ "from": from, "to": to, "events": ev })))
}

// ================================ now ================================

async fn state(State(a): State<Arc<Agent>>) -> Result<Response, ApiError> {
    let desk = a.hub.snapshot_json().await.ok_or((StatusCode::SERVICE_UNAVAILABLE, "the desk did not answer".to_string()))?;
    let engine = a.tel.latest().map_or(Value::Null, |(t, p)| json!({ "t": t, "payload": *p }));
    let mut out = br#"{"note":"desk: the dashboard's snapshot now (as /api/snapshot); engine: the engine's last push, whole","t":"#.to_vec();
    out.extend(now_ms().to_string().as_bytes());
    out.extend(br#","desk":"#);
    out.extend(&desk[..]);
    out.extend(br#","engine":"#);
    out.extend(engine.to_string().as_bytes());
    out.push(b'}');
    Ok(([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], out).into_response())
}

async fn markouts(State(a): State<Arc<Agent>>, Query(q): Q) -> Result<Response, ApiError> {
    let q = crate::markouts::Query::parse(&q).map_err(bad)?;
    let b = a.hub.markouts(q).await.ok_or((StatusCode::SERVICE_UNAVAILABLE, "the desk did not answer".to_string()))?;
    Ok(([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], b).into_response())
}

// ================================ catalog ================================

async fn catalog(State(a): State<Arc<Agent>>) -> Result<Response, ApiError> {
    let now = now_ms();
    let accts = a.history.read(move |c| accounts(c, now)).await?;
    let (_, cols) = a.tel.samples(now - 30 * 60_000, now, 0, &["*".to_string()]).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let pools = pools_of(cols.keys());
    let engine_keys: Vec<&String> = cols.keys().collect();
    let entry = |(k, u, d): &(&str, &str, &str)| json!({ "key": k, "unit": u, "means": d });
    Ok(json_body(&json!({
        "about": "bndesk's history for agents: the market-making desk's P&L and its split, its accounts, every fill with its marks, and the trading engine's own figures (pushed every 15 s), over any range. Read-only.",
        "auth": "Authorization: Bearer <token> (BNDESK_READ_TOKEN); GET only; these paths only",
        "time": "from / to: epoch ms (or s), now, relative (-90m, -24h, -7d, -2w), a UTC date (2026-11-05) or date and time (2026-11-05T12:00Z). Default: the last 24 h (pnl, events: 7 d).",
        "format": "format=csv on series, pnl and fills; JSON otherwise. Money in USD(T).",
        "day": format!("A P&L day starts at {:02}:{:02} UTC; desk.* day figures restart there.", a.history.day_start_min() / 60, a.history.day_start_min() % 60),
        "endpoints": [
            { "path": "/api/agent", "means": "This catalog, with the accounts and the engine's keys as of now" },
            { "path": "/api/agent/state", "means": "Now: the dashboard's whole snapshot (accounts, instruments, exposure, quotes, alerts, feeds, today's P&L split, days, hours) and the engine's last push" },
            { "path": "/api/agent/series", "params": "keys (comma-separated, * expands a name), from, to, step (s, one of 15 60 300 900 1800 3600 14400 86400 604800; default about 1500 buckets), agg (last|first|mean|min|max; default last), format", "means": "Any series side by side on one UTC grid. e.g. keys=capital.*.util&step=3600&agg=mean; keys=desk.mm,desk.inventory_pnl,engine.metrics.*" },
            { "path": "/api/agent/pnl", "params": "from, to (default 7 d), step (s: 60 300 900 3600 14400 86400; default 3600), format", "means": "The desk's P&L per bar as changes: pnl = mm + inventory_pnl + hedge + rebates + other, with fills, volume and the levels at the bar's end" },
            { "path": "/api/agent/fills", "params": "from, to, symbol, venue (spot|usdm|...), account, side (buy|sell), limit (default 50000, max 200000), format", "means": "Every fill with its fee, edge, the mark market making counts, raw / net / fast markouts at 1 10 60 300 s, toxicity, and the price path (JSON)" },
            { "path": "/api/agent/events", "params": "from, to (default 7 d)", "means": "Alerts raised, transfers, distributions (airdrops, rebates), and changes to what a series means" },
            { "path": "/api/agent/markouts", "params": "account, venue, side, ref (net|fast|raw), weight (notional|fill), h (s)", "means": "Today's markout curves and distribution, as the Analysis page has them" },
            { "path": "/api/agent/klines", "params": "symbol, venue, interval (1m 5m 15m 1h 4h 1d ...), from, to (epoch ms)", "means": "An instrument's candles from the exchange (cached)" },
        ],
        "series": {
            "desk.<key>": DESK.iter().map(entry).collect::<Vec<_>>(),
            "acct.<account>.<key>": ACCT.iter().map(entry).collect::<Vec<_>>(),
            "capital.<pool account | pool>.<key>": CAPITAL.iter().map(entry).collect::<Vec<_>>(),
            "engine.<key>": "Any numeric leaf of the engine's push, as named in engine_keys (metrics.*, balances.<account>.<asset>.free|locked, ...); every 15 s for 7 days, then one per 5 min for 180 days",
        },
        "accounts": accts,
        "pool_accounts": pools,
        "engine_keys": engine_keys,
        "changes": CHANGES.iter().map(|(d, k, w)| json!({ "from": d, "key": k, "what": w })).collect::<Vec<_>>(),
        "retention": "Desk rows every 5 s for the store's fine window, thinned after; fills, alerts, transfers in full; engine samples as above.",
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_an_agent_writes_them() {
        let now = 1_800_000_000_000;
        assert_eq!(when("now", now), Ok(now));
        assert_eq!(when("-90m", now), Ok(now - 90 * 60_000));
        assert_eq!(when("-7d", now), Ok(now - 7 * DAY));
        assert_eq!(when("1762387200", now), Ok(1_762_387_200_000));
        assert_eq!(when("1762387200000", now), Ok(1_762_387_200_000));
        assert_eq!(when("2025-11-06", now), Ok(1_762_387_200_000));
        assert_eq!(when("2025-11-06T01:30Z", now), Ok(1_762_387_200_000 + 90 * 60_000));
        assert_eq!(when("2025-11-06T01:30:15", now), Ok(1_762_387_200_000 + 90 * 60_000 + 15_000));
        assert!(when("-3y", now).is_err() && when("yesterday", now).is_err());
    }

    #[test]
    fn the_grid_aggregates_each_bucket() {
        let g = Grid::new(1_000, 4_000, 1_000, 0);
        assert_eq!((g.start, g.n), (1_000, 3));
        let pts = [(1_000, 1.0), (1_500, 3.0), (2_100, 5.0), (3_000, 2.0), (3_999, -1.0)];
        assert_eq!(g.fill(&pts, Agg::Last), [Some(3.0), Some(5.0), Some(-1.0)]);
        assert_eq!(g.fill(&pts, Agg::Mean), [Some(2.0), Some(5.0), Some(0.5)]);
        assert_eq!(g.fill(&pts, Agg::Max), [Some(3.0), Some(5.0), Some(2.0)]);
        assert_eq!(g.fill(&[(2_500, 1.0)], Agg::First), [None, Some(1.0), None]);
        // a day's buckets start at the P&L day's start
        let d = Grid::new(10 * DAY + 5, 12 * DAY, DAY, 3_600_000);
        assert_eq!((d.start, d.n), (10 * DAY - DAY + 3_600_000, 3));
    }

    #[test]
    fn keys_expand_and_unknown_ones_are_refused() {
        let accts = vec!["binance".to_string(), "binance_m2".to_string()];
        let pools = accts.clone();
        let r = resolve("desk.mm, capital.*.util,acct.binance_m2.equity, engine.metrics.*", &accts, &pools).unwrap();
        let names: Vec<&str> = r.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["desk.mm", "capital.binance.util", "capital.binance_m2.util", "capital.pool.util", "acct.binance_m2.equity", "engine.metrics.*"]);
        assert_eq!(resolve("desk.*", &accts, &pools).unwrap().len(), DESK.len());
        assert!(resolve("desk.nope", &accts, &pools).is_err());
        assert!(resolve("acct.ghost.equity", &accts, &pools).is_err());
        assert!(resolve("wallet.x", &accts, &pools).is_err());
        assert!(resolve("", &accts, &pools).is_err());
    }

    #[test]
    fn capital_sums_the_stablecoins_per_account_and_the_pool() {
        let mut cols = BTreeMap::new();
        cols.insert("balances.a.USDT.free".to_string(), vec![Some(600.0), Some(500.0)]);
        cols.insert("balances.a.USDT.locked".to_string(), vec![Some(400.0), None]);
        cols.insert("balances.a.BTC.free".to_string(), vec![Some(1.0), Some(1.0)]);
        cols.insert("balances.b.USDC.free".to_string(), vec![Some(100.0), Some(100.0)]);
        cols.insert("balances.b.USDC.locked".to_string(), vec![Some(300.0), Some(300.0)]);
        let c = capital(&[1, 2], &cols);
        assert_eq!(c["a"], [(1, 600.0, 400.0), (2, 500.0, 0.0)]);
        assert_eq!(c["b"], [(1, 100.0, 300.0), (2, 100.0, 300.0)]);
        assert_eq!(c["pool"], [(1, 700.0, 700.0), (2, 600.0, 300.0)]);
    }

    #[test]
    fn pnl_bars_become_changes_that_add_up() {
        use crate::protocol::HistoryBar;
        let bar = |t, o, c, pi, mm, hedge, reb| HistoryBar { t, o, h: c, l: o, c, pi, mm, hedge, rebates: reb, ..Default::default() };
        let bars = [
            bar(0, 0.0, 5.0, None, None, None, None),
            bar(1, 5.0, 12.0, Some(4.0), Some(1.0), Some(1.0), Some(0.5)),
            bar(2, 12.0, 10.0, Some(3.0), Some(2.0), Some(0.0), Some(1.0)),
        ];
        let r = pnl_rows(&bars);
        assert_eq!(r[0]["pnl"], json!(5.0));
        assert_eq!(r[0]["mm"], Value::Null);
        assert_eq!((r[1]["pnl"].clone(), r[1]["trading"].clone(), r[1]["inventory_pnl"].clone()), (json!(7.0), json!(4.0), json!(3.0)));
        assert_eq!(r[1]["other"], json!(7.0 - 4.0 - 1.0 - 0.5));
        assert_eq!((r[2]["pnl"].clone(), r[2]["mm"].clone(), r[2]["hedge"].clone(), r[2]["cum_pnl"].clone()), (json!(-2.0), json!(1.0), json!(-1.0), json!(10.0)));
    }
}
