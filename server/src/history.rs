//! History endpoints: `/api/history`, `/api/fills`, `/api/klines`.
//!
//! Never on the desk's thread: SQLite reads run in `spawn_blocking` on a read-only connection to the desk's
//! db (one per blocking thread, kept; WAL lets it read while the store writes). The desk's P&L rows and each
//! fill's time and notional are kept in memory once read, and each request reads only what was written since:
//! on a small machine the db does not stay in the page cache, and reading the whole range from disk took half
//! a minute. Klines are Binance's public ones, proxied in chunks of `CHUNK` bars; a chunk whose bars have all
//! closed is cached in memory.
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use rusqlite::{Connection, OpenFlags, params_from_iter};
use serde::Serialize;

use crate::binance::rest::{FAPI, SPOT};
use crate::protocol as P;
use crate::sessions;

/// Bar sizes of `/api/history`, seconds.
pub const STEPS: [i64; 6] = [60, 300, 900, 3600, 14400, 86400];
/// Bars at most per response (history and klines); a longer range keeps its latest part.
pub const MAX_BARS: i64 = 25_000;
pub const MAX_FILLS: i64 = 20000;
/// Kline intervals `/api/klines` proxies (Binance's names; a week opens on Monday 00:00 UTC, which Binance aligns).
pub const INTERVALS: [(&str, i64); 8] = [
    ("1m", 60_000), ("5m", 300_000), ("15m", 900_000), ("30m", 1_800_000), ("1h", 3_600_000), ("4h", 14_400_000),
    ("1d", 86_400_000), ("1w", 604_800_000),
];
/// Klines per Binance request and per cache entry (spot allows 1000, USD-M 1500; 1000 costs USD-M weight 5, not 10).
const CHUNK: i64 = 1000;
const CACHE_MAX: usize = 512;
const DAY: i64 = 86_400_000;

/// (open time, open, high, low, close, base volume): serialized as `[t, o, h, l, c, v]`.
pub type Kline = (i64, f64, f64, f64, f64, f64);

type ApiError = (StatusCode, String);

fn bad(msg: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, msg.into())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

type CacheKey = (String, &'static str, i64, i64); // symbol, venue, interval ms, chunk start

#[derive(Default)]
struct Cache {
    map: HashMap<CacheKey, (Arc<Vec<Kline>>, u64)>,
    tick: u64,
}

pub struct Api {
    db: PathBuf,
    day_start_min: i64,
    http: reqwest::Client,
    spot: String,
    fapi: String,
    cache: Mutex<Cache>,
    /// After a 429 / 418: no kline request before this (epoch ms).
    blocked_until: AtomicI64,
    mem: Arc<Mutex<Mem>>,
    /// The store's retention (`keep_fine_days`, `keep_days`), ms: the in-memory rows are thinned alike.
    keep_fine_ms: i64,
    keep_ms: i64,
}

/// What `/api/history` reads, kept in memory: the desk rows (account "*") by time, thinned as the store
/// thins them, and the fills' notional and count per minute. Every bar size is whole minutes on a
/// minute-aligned anchor, so minute sums add up to any bar. A fill written again (same id) within
/// `FILL_IDS_MS` replaces its earlier part.
#[derive(Default)]
struct Mem {
    rows: Vec<DeskRow>,
    minutes: HashMap<i64, (f64, i64)>,
    ids: HashMap<String, (i64, f64)>,
    fill_rowid: i64,
    trimmed: i64,
}

/// Rows this recent are read again on each refresh: a row can be rewritten for the same time.
const REREAD_MS: i64 = 120_000;
/// How long a fill's id is remembered.
const FILL_IDS_MS: i64 = 3 * DAY;
const MIN: i64 = 60_000;

impl Mem {
    /// Reads what was written since the last call (everything, the first time).
    fn refresh(&mut self, c: &Connection, now: i64, keep_fine_ms: i64, keep_ms: i64) -> rusqlite::Result<()> {
        let from = self.rows.last().map_or(i64::MIN, |r| r.t - REREAD_MS);
        let new = desk_rows(c, from, i64::MAX)?;
        let keep = self.rows.partition_point(|r| r.t < from);
        self.rows.truncate(keep);
        self.rows.extend(new);
        let mut st = c.prepare_cached("SELECT rowid, id, ts, price * qty FROM fills WHERE rowid > ? ORDER BY rowid")?;
        let mut q = st.query([self.fill_rowid])?;
        while let Some(r) = q.next()? {
            self.fill_rowid = r.get(0)?;
            let (id, ts, n): (String, Option<i64>, Option<f64>) = (r.get(1)?, r.get(2)?, r.get(3)?);
            let Some(ts) = ts else { continue };
            let n = n.unwrap_or(0.0);
            if let Some((t0, n0)) = self.ids.get(&id).copied() {
                let e = self.minutes.entry(t0 - t0.rem_euclid(MIN)).or_default();
                e.0 -= n0;
                e.1 -= 1;
            }
            if ts >= now - FILL_IDS_MS {
                self.ids.insert(id, (ts, n));
            }
            let e = self.minutes.entry(ts - ts.rem_euclid(MIN)).or_default();
            e.0 += n;
            e.1 += 1;
        }
        if now - self.trimmed > 3_600_000 {
            self.trimmed = now;
            self.ids.retain(|_, v| v.0 >= now - FILL_IDS_MS);
            let (fine, old) = (now - keep_fine_ms, now - keep_ms);
            self.rows.retain(|r| r.t >= old && (r.t >= fine || r.t % MIN == 0));
            self.minutes.retain(|t, _| *t >= old);
        }
        Ok(())
    }

    fn rows(&self, from: i64, to: i64) -> Vec<DeskRow> {
        let a = self.rows.partition_point(|r| r.t < from);
        let b = self.rows.partition_point(|r| r.t < to);
        self.rows[a..b].to_vec()
    }

    /// Bar start -> (Σ notional, fills) over the fills in [from, to) (to the minute).
    fn flows(&self, from: i64, to: i64, step_ms: i64, anchor: i64) -> HashMap<i64, (f64, i64)> {
        let mut out: HashMap<i64, (f64, i64)> = HashMap::new();
        for (&t, &(n, k)) in &self.minutes {
            if t >= from - from.rem_euclid(MIN) && t < to && k > 0 {
                let e = out.entry(bar_of(t, step_ms, anchor)).or_default();
                e.0 += n;
                e.1 += k;
            }
        }
        out
    }
}

impl Api {
    pub fn new(db: PathBuf, day_start_min: i64) -> Arc<Api> {
        Api::with_bases(db, day_start_min, SPOT, FAPI)
    }

    /// `spot` / `fapi`: base URLs of the kline endpoints (a stand-in server in tests).
    pub fn with_bases(db: PathBuf, day_start_min: i64, spot: &str, fapi: &str) -> Arc<Api> {
        Arc::new(Api {
            db,
            day_start_min,
            http: crate::binance::rest::client(),
            spot: spot.into(),
            fapi: fapi.into(),
            cache: Mutex::default(),
            blocked_until: AtomicI64::new(0),
            mem: Arc::default(),
            keep_fine_ms: 7 * DAY,
            keep_ms: 365 * DAY,
        })
    }

    pub fn retention(mut self: Arc<Self>, keep_fine_days: f64, keep_days: f64) -> Arc<Self> {
        if let Some(a) = Arc::get_mut(&mut self) {
            a.keep_fine_ms = (keep_fine_days * DAY as f64) as i64;
            a.keep_ms = (keep_days * DAY as f64) as i64;
        }
        self
    }

    /// Reads the history into memory ahead of the first request (the first read is the slow one).
    pub fn warm(self: &Arc<Self>) {
        let api = self.clone();
        tokio::spawn(async move {
            let t0 = std::time::Instant::now();
            match api.with_mem(|m| m.rows.len()).await {
                Ok(n) => tracing::info!("history in memory: {n} rows in {:.1} s", t0.elapsed().as_secs_f64()),
                Err(e) => tracing::warn!("history warm-up: {}", e.1),
            }
        });
    }

    /// `f` on the in-memory history, brought up to date first.
    async fn with_mem<R: Send + 'static>(&self, f: impl FnOnce(&Mem) -> R + Send + 'static) -> Result<R, ApiError> {
        let (mem, fine, keep) = (self.mem.clone(), self.keep_fine_ms, self.keep_ms);
        blocking(self, move |c| {
            let mut m = mem.lock().unwrap();
            m.refresh(c, now_ms(), fine, keep)?;
            Ok(f(&m))
        })
        .await
    }

    fn cache_get(&self, k: &CacheKey) -> Option<Arc<Vec<Kline>>> {
        let mut c = self.cache.lock().unwrap();
        c.tick += 1;
        let tick = c.tick;
        c.map.get_mut(k).map(|e| {
            e.1 = tick;
            e.0.clone()
        })
    }

    fn cache_insert(&self, k: CacheKey, v: Arc<Vec<Kline>>) {
        let mut c = self.cache.lock().unwrap();
        if c.map.len() >= CACHE_MAX
            && let Some(old) = c.map.iter().min_by_key(|e| e.1.1).map(|e| e.0.clone())
        {
            c.map.remove(&old);
        }
        c.tick += 1;
        let tick = c.tick;
        c.map.insert(k, (v, tick));
    }

    /// The `CHUNK` bars of `iv` from `cs` (a multiple of CHUNK × iv); cached once all have closed.
    async fn chunk(&self, sym: &str, venue: &'static str, name: &str, iv: i64, cs: i64, now: i64)
                   -> Result<Arc<Vec<Kline>>, ApiError> {
        let key = (sym.to_string(), venue, iv, cs);
        if let Some(v) = self.cache_get(&key) {
            return Ok(v);
        }
        let until = self.blocked_until.load(Ordering::Relaxed);
        if now < until {
            return Err((StatusCode::SERVICE_UNAVAILABLE, format!("binance rate limit: retry in {} s", (until - now) / 1000 + 1)));
        }
        let (base, path) = if venue == "spot" { (&self.spot, "/api/v3/klines") } else { (&self.fapi, "/fapi/v1/klines") };
        let end = cs + CHUNK * iv - 1;
        let r = self
            .http
            .get(format!("{base}{path}"))
            .query(&[("symbol", sym), ("interval", name), ("startTime", &cs.to_string()), ("endTime", &end.to_string()),
                     ("limit", &CHUNK.to_string())])
            .send()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, format!("binance: {e}")))?;
        let st = r.status();
        if st.as_u16() == 429 || st.as_u16() == 418 {
            let wait = r.headers().get(header::RETRY_AFTER).and_then(|v| v.to_str().ok()?.parse::<i64>().ok()).unwrap_or(60);
            self.blocked_until.store(now + wait * 1000, Ordering::Relaxed);
            return Err((StatusCode::SERVICE_UNAVAILABLE, format!("binance {st}: retry in {wait} s")));
        }
        let body = r.text().await.map_err(|e| (StatusCode::BAD_GATEWAY, format!("binance: {e}")))?;
        if !st.is_success() {
            let code = if st.is_client_error() { StatusCode::BAD_REQUEST } else { StatusCode::BAD_GATEWAY };
            return Err((code, format!("binance {st}: {body}")));
        }
        let rows = parse_klines(&body).map_err(|e| (StatusCode::BAD_GATEWAY, format!("binance klines: {e}")))?;
        let v = Arc::new(rows);
        if end + 5_000 < now {
            self.cache_insert(key, v.clone());
        }
        Ok(v)
    }

    /// Bars of `iv` opening in [from, to], the latest MAX_BARS.
    async fn klines(&self, sym: &str, venue: &'static str, name: &str, iv: i64, from: i64, to: i64)
                    -> Result<Vec<Kline>, ApiError> {
        let now = now_ms();
        let span = CHUNK * iv;
        let mut out: Vec<Kline> = vec![];
        let mut cs = from.div_euclid(span) * span;
        while cs <= to.min(now) {
            let rows = self.chunk(sym, venue, name, iv, cs, now).await?;
            out.extend(rows.iter().filter(|k| from <= k.0 && k.0 <= to).copied());
            cs += span;
        }
        if out.len() > MAX_BARS as usize {
            out.drain(..out.len() - MAX_BARS as usize);
        }
        Ok(out)
    }
}

fn num(v: &serde_json::Value) -> anyhow::Result<f64> {
    match v {
        serde_json::Value::String(s) => Ok(s.trim().parse()?),
        serde_json::Value::Number(n) => n.as_f64().ok_or_else(|| anyhow::anyhow!("bad number")),
        _ => anyhow::bail!("bad kline field {v}"),
    }
}

fn parse_klines(body: &str) -> anyhow::Result<Vec<Kline>> {
    let raw: Vec<Vec<serde_json::Value>> = serde_json::from_str(body)?;
    raw.iter()
        .map(|r| {
            let f = |i: usize| r.get(i).ok_or_else(|| anyhow::anyhow!("short kline")).and_then(num);
            let t = r.first().and_then(|x| x.as_i64()).ok_or_else(|| anyhow::anyhow!("bad kline time"))?;
            Ok((t, f(1)?, f(2)?, f(3)?, f(4)?, f(5)?))
        })
        .collect()
}

// --- SQLite, read-only -------------------------------------------------------------------------------

thread_local! {
    static CONN: RefCell<Option<(PathBuf, Connection)>> = const { RefCell::new(None) };
}

/// `f` on this blocking thread's read-only connection to `path` (opened on first use, dropped on an error).
fn with_db<R>(path: &Path, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> rusqlite::Result<R> {
    CONN.with(|cell| {
        let mut cell = cell.borrow_mut();
        if cell.as_ref().is_none_or(|(p, _)| p != path) {
            let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
            c.busy_timeout(Duration::from_secs(5))?;
            *cell = Some((path.to_path_buf(), c));
        }
        let r = f(&cell.as_ref().expect("opened").1);
        if r.is_err() {
            *cell = None;
        }
        r
    })
}

async fn blocking<R: Send + 'static>(api: &Api, f: impl FnOnce(&Connection) -> rusqlite::Result<R> + Send + 'static)
                                     -> Result<R, ApiError> {
    let path = api.db.clone();
    match tokio::task::spawn_blocking(move || with_db(&path, f)).await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err((StatusCode::SERVICE_UNAVAILABLE, format!("db: {e}"))),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}

/// A desk equity row (account "*") as the history reads it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeskRow {
    pub t: i64,
    pub pnl_day: f64,
    pub trading: Option<f64>,
    pub realized: Option<f64>,
    pub hedge: Option<f64>,
    pub mm: Option<f64>,
    pub rebates: Option<f64>,
    pub inventory: f64,
    pub futures: f64,
    pub equity: f64,
}

fn desk_rows(c: &Connection, from: i64, to: i64) -> rusqlite::Result<Vec<DeskRow>> {
    // a db the desk has not migrated yet reads its missing columns as NULL
    let have: Vec<String> = c.prepare("PRAGMA table_info(equity)")?.query_map([], |r| r.get(1))?.collect::<Result<_, _>>()?;
    let col = |n: &str| if have.iter().any(|h| h == n) { n.to_string() } else { "NULL".into() };
    let sql = format!(
        "SELECT t, pnl_day, {}, {}, {}, inventory, futures_notional, {}, {}, equity FROM equity WHERE account = '*' AND t >= ? AND t < ? ORDER BY t",
        col("trading"), col("realized"), col("hedge"), col("mm"), col("rebates"));
    let mut st = c.prepare(&sql)?;
    st.query_map([from, to], |r| {
        Ok(DeskRow {
            t: r.get(0)?,
            pnl_day: r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            trading: r.get(2)?,
            realized: r.get(3)?,
            hedge: r.get(4)?,
            inventory: r.get::<_, Option<f64>>(5)?.unwrap_or(0.0),
            futures: r.get::<_, Option<f64>>(6)?.unwrap_or(0.0),
            mm: r.get(7)?,
            rebates: r.get(8)?,
            equity: r.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
        })
    })?
    .collect()
}

fn fills(c: &Connection, symbol: Option<String>, venue: Option<&'static str>, from: i64, to: i64) -> rusqlite::Result<Vec<P::HistoryFill>> {
    let sym = if symbol.is_some() { " AND symbol = ?" } else { "" };
    let ven = if venue.is_some() { " AND venue = ?" } else { "" };
    let sql = format!(
        "SELECT ts, side, price, qty, account, venue, maker FROM fills WHERE ts >= ? AND ts < ?{sym}{ven} ORDER BY ts LIMIT {MAX_FILLS}");
    let mut args: Vec<rusqlite::types::Value> = vec![from.into(), to.into()];
    args.extend(symbol.map(Into::into));
    args.extend(venue.map(|v| v.to_string().into()));
    let mut st = c.prepare(&sql)?;
    st.query_map(params_from_iter(args), |r| {
        Ok(P::HistoryFill {
            t: r.get(0)?,
            side: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            price: r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
            qty: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
            account: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            venue: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            maker: r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
        })
    })?
    .collect()
}

// --- bars ---------------------------------------------------------------------------------------------

/// One day-reset series summed across days: earlier days' final values plus today's, from 0 at its first
/// value in the range (a range that starts mid-day leaves out what that day made before it).
#[derive(Default)]
struct Cum {
    off: f64,
    last: Option<f64>,
    seen: bool,
}

impl Cum {
    fn roll(&mut self) {
        self.off += self.last.take().unwrap_or(0.0);
    }

    fn at(&mut self, v: Option<f64>) -> Option<f64> {
        v.map(|x| {
            if !self.seen {
                self.seen = true;
                self.off -= x;
            }
            self.last = Some(x);
            self.off + x
        })
    }
}

/// Start of the `step_ms` bar holding `t`; bars are aligned to `anchor` (the day start's offset).
pub fn bar_of(t: i64, step_ms: i64, anchor: i64) -> i64 {
    t - (t - anchor).rem_euclid(step_ms)
}

/// Desk P&L since the first row (0 there), in bars: pnl_day, trading, realized, hedge and rebates restart each P&L day, so
/// within a day a series is (the sum of the earlier days' final values) + its value now. OHLC of the
/// cumulative day P&L; pi / realized / hedge / rebates: the bar's last non-null cumulative value; inventory and
/// futures, equity: the bar's last row; volume and fills from `flows` (bar start -> (Σ notional, count)).
/// `per_day`: each figure as stored instead, restarting at each day start (a bar never spans two days when the
/// step divides a day). `rows` ordered by t; bars without rows are left out.
pub fn bars(rows: &[DeskRow], flows: &HashMap<i64, (f64, i64)>, step_ms: i64, day_start_min: i64, per_day: bool) -> Vec<P::HistoryBar> {
    let rows = clean(rows, day_start_min);
    let rows = &rows[..];
    let anchor = day_start_min * 60_000;
    let mut out: Vec<P::HistoryBar> = vec![];
    let (mut pnl, mut pi, mut re, mut he, mut mm, mut rb) =
        (Cum::default(), Cum::default(), Cum::default(), Cum::default(), Cum::default(), Cum::default());
    let mut day = None;
    for r in rows {
        let ds = sessions::day_start(r.t, day_start_min);
        if per_day {
            for c in [&mut pnl, &mut pi, &mut re, &mut he, &mut mm, &mut rb] {
                *c = Cum { seen: true, ..Cum::default() };
            }
        } else if day != Some(ds) {
            for c in [&mut pnl, &mut pi, &mut re, &mut he, &mut mm, &mut rb] {
                c.roll();
            }
            day = Some(ds);
        }
        let v = pnl.at(Some(r.pnl_day)).unwrap_or(0.0);
        let (vpi, vre, vhe, vmm, vrb) = (pi.at(r.trading), re.at(r.realized), he.at(r.hedge), mm.at(r.mm), rb.at(r.rebates));
        let b = bar_of(r.t, step_ms, anchor);
        match out.last_mut() {
            Some(x) if x.t == b => {
                x.h = x.h.max(v);
                x.l = x.l.min(v);
                x.c = v;
                x.pi = vpi.or(x.pi);
                x.realized = vre.or(x.realized);
                x.mm = vmm.or(x.mm);
                x.hedge = vhe.or(x.hedge);
                x.rebates = vrb.or(x.rebates);
                x.inventory = Some(r.inventory);
                x.futures = Some(r.futures);
                x.equity = Some(r.equity);
            }
            _ => out.push(P::HistoryBar {
                t: b,
                o: v,
                h: v,
                l: v,
                c: v,
                pi: vpi,
                realized: vre,
                mm: vmm,
                hedge: vhe,
                rebates: vrb,
                inventory: Some(r.inventory),
                futures: Some(r.futures),
                equity: Some(r.equity),
                volume: 0.0,
                fills: 0,
            }),
        }
    }
    for x in &mut out {
        if let Some((v, n)) = flows.get(&x.t) {
            x.volume = *v;
            x.fills = *n;
        }
    }
    out
}

/// Rows as drawn: a row whose day PnL jumps and is back by the next row (a desk half-valued just after a
/// restart, in rows from before the warm-up) is left out; the row at a day's very start keeps its day PnL
/// but not Π / realized / hedge, which can still be the ending day's there.
fn clean(rows: &[DeskRow], day_start_min: i64) -> Vec<DeskRow> {
    let mut out: Vec<DeskRow> = Vec::with_capacity(rows.len());
    for (i, r) in rows.iter().enumerate() {
        if let (Some(p), Some(n)) = (out.last(), rows.get(i + 1)) {
            let jump = (r.pnl_day - p.pnl_day).abs();
            let same_day = sessions::day_start(p.t, day_start_min) == sessions::day_start(n.t, day_start_min);
            if same_day && jump > 1.0 && (n.pnl_day - p.pnl_day).abs() < 0.3 * jump {
                continue;
            }
        }
        let mut r = r.clone();
        if r.t == sessions::day_start(r.t, day_start_min) {
            (r.trading, r.realized, r.hedge, r.mm, r.rebates) = (None, None, None, None, None);
        }
        out.push(r);
    }
    out
}

/// The P&L days overlapping [from, to): UTC date of the day start, and the start.
pub fn days(from: i64, to: i64, day_start_min: i64) -> Vec<P::HistoryDay> {
    let mut out = vec![];
    let mut ds = sessions::day_start(from, day_start_min);
    while ds < to {
        out.push(P::HistoryDay { day: crate::pnl::utc_day(ds), start: ds });
        ds += DAY;
    }
    out
}

// --- handlers -----------------------------------------------------------------------------------------

type Params = Query<HashMap<String, String>>;

fn int(q: &HashMap<String, String>, k: &str) -> Result<Option<i64>, ApiError> {
    q.get(k).filter(|v| !v.is_empty()).map(|v| v.parse::<i64>().map_err(|_| bad(format!("bad {k}: {v:?}")))).transpose()
}

/// `from`, `to` (epoch ms); `to` defaults to now, `from` to `span` before it.
fn range(q: &HashMap<String, String>, span: i64) -> Result<(i64, i64), ApiError> {
    let to = int(q, "to")?.unwrap_or_else(now_ms);
    let from = int(q, "from")?.unwrap_or(to - span);
    if from >= to {
        return Err(bad("from must be before to"));
    }
    Ok((from, to))
}

/// `symbol` if given: [A-Z0-9]{2,20}.
fn symbol(q: &HashMap<String, String>) -> Result<Option<String>, ApiError> {
    match q.get("symbol").filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if (2..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()) => {
            Ok(Some(s.clone()))
        }
        Some(s) => Err(bad(format!("bad symbol {s:?}"))),
    }
}

fn json<T: Serialize + ?Sized>(v: &T) -> Response {
    ([(header::CONTENT_TYPE, "application/json")], P::encode(v)).into_response()
}

async fn history(State(api): State<Arc<Api>>, Query(q): Params) -> Result<Response, ApiError> {
    let step = int(&q, "step")?.unwrap_or(300);
    if !STEPS.contains(&step) {
        return Err(bad(format!("step must be one of {STEPS:?}")));
    }
    let sm = step * 1000;
    let per_day = q.get("per").map(String::as_str) == Some("day");
    let (from, to) = range(&q, DAY)?;
    let from = from.max(to - MAX_BARS * sm);
    let dsm = api.day_start_min;
    let (rows, flows) = api.with_mem(move |m| (m.rows(from, to), m.flows(from, to, sm, dsm * 60_000))).await?;
    let h = P::History { step, bars: bars(&rows, &flows, sm, dsm, per_day), days: days(from, to, dsm) };
    Ok(json(&h))
}

async fn fills_handler(State(api): State<Arc<Api>>, Query(q): Params) -> Result<Response, ApiError> {
    let sym = symbol(&q)?;
    let venue = match q.get("venue").map(String::as_str) {
        None => None,
        Some("spot") => Some("spot"),
        Some("usdm") => Some("usdm"),
        Some(v) => return Err(bad(format!("bad venue {v:?}"))),
    };
    let (from, to) = range(&q, DAY)?;
    let rows = blocking(&api, move |c| fills(c, sym, venue, from, to)).await?;
    Ok(json(&rows))
}

async fn klines(State(api): State<Arc<Api>>, Query(q): Params) -> Result<Response, ApiError> {
    let sym = symbol(&q)?.ok_or_else(|| bad("symbol required"))?;
    let venue = match q.get("venue").map(String::as_str) {
        None | Some("spot") => "spot",
        Some("usdm") => "usdm",
        Some(v) => return Err(bad(format!("bad venue {v:?}"))),
    };
    let name = q.get("interval").map_or("1m", String::as_str);
    let (name, iv) = *INTERVALS.iter().find(|i| i.0 == name).ok_or_else(|| bad(format!("bad interval {name:?}")))?;
    let (from, to) = range(&q, DAY)?;
    let from = from.max(to - MAX_BARS * iv + 1);
    Ok(json(&api.klines(&sym, venue, name, iv, from, to).await?))
}

/// `/api/history`, `/api/fills`, `/api/klines` (all GET).
pub fn routes(api: Arc<Api>) -> Router {
    Router::new()
        .route("/api/history", get(history))
        .route("/api/fills", get(fills_handler))
        .route("/api/klines", get(klines))
        .with_state(api)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{Hub, make_app, serve};
    use crate::sessions::utc;
    use crate::store::{EquityRow, Row, Store};
    use std::sync::atomic::AtomicUsize;

    fn row(t: i64, pnl: f64, tr: Option<f64>) -> DeskRow {
        DeskRow { t, pnl_day: pnl, trading: tr, realized: tr.map(|x| x / 2.0), hedge: None, mm: None, rebates: None, inventory: t as f64,
                  futures: -1.0, equity: 0.0 }
    }

    #[test]
    fn restart_spike_and_stale_roll_row_are_not_drawn() {
        let d0 = utc(2026, 10, 6, 0, 0);
        let rows = vec![
            row(d0 - 5_000, 17.0, Some(18.0)),
            row(d0, 0.0, Some(18.0)),             // the roll: day PnL reset, Π still the ending day's
            row(d0 + 5_000, 0.1, Some(0.2)),
            row(d0 + 10_000, 6.6, Some(0.3)),     // half-valued just after a restart
            row(d0 + 15_000, 0.2, Some(0.3)),
        ];
        let b = bars(&rows, &HashMap::new(), 60_000, 0, false);
        let today = b.last().unwrap();
        assert_eq!((today.h, today.c), (0.2, 0.2));
        // Π: the range starts at day 0's last row (18 → 0), today adds 0.3; the roll row's stale 18 is not used
        assert_eq!(today.pi, Some(0.3));
    }

    #[test]
    fn cumulative_bars_across_a_day_boundary() {
        // day start 08:00; rows every 20 min from 07:00 to 09:00 on day 1, then day 2 from 08:00
        let d0 = utc(2026, 10, 5, 8, 0);
        let m = 60_000;
        let rows = vec![
            row(d0 - 60 * m, 1.0, Some(0.5)),
            row(d0 - 40 * m, 3.0, None),
            row(d0 - 20 * m, 2.0, Some(1.0)),   // day 0 ends at pnl 2, trading 1
            row(d0, 0.5, Some(0.25)),           // day 1: 2 + 0.5
            row(d0 + 20 * m, -1.0, None),
            row(d0 + 40 * m, 4.0, Some(3.0)),   // day 1 ends at 4
            // day 2 has no rows; day 3:
            row(d0 + 2 * DAY + 10 * m, 1.0, Some(1.0)),
        ];
        let flows: HashMap<i64, (f64, i64)> = [(d0, (100.0, 2))].into_iter().collect();
        let b = bars(&rows, &flows, 3_600_000, 8 * 60, false);
        assert_eq!(b.len(), 3);
        // 07:00 bar: day 0, from 0 at the first row (pnl 1, trading 0.5, realized 0.25)
        assert_eq!((b[0].t, b[0].o, b[0].h, b[0].l, b[0].c), (d0 - 3_600_000, 0.0, 2.0, 0.0, 1.0));
        assert_eq!((b[0].pi, b[0].realized, b[0].hedge), (Some(0.5), Some(0.25), None));
        assert_eq!((b[0].volume, b[0].fills), (0.0, 0));
        // 08:00 bar: day 1 on top of day 0's final 2 (and trading's final 1)
        assert_eq!((b[1].t, b[1].o, b[1].h, b[1].l, b[1].c), (d0, 1.5, 5.0, 0.0, 5.0));
        assert_eq!((b[1].pi, b[1].realized), (Some(3.5), Some(1.75)));
        assert_eq!((b[1].inventory, b[1].futures), (Some((d0 + 40 * m) as f64), Some(-1.0)));
        assert_eq!((b[1].volume, b[1].fills), (100.0, 2));
        // two days on: 2 + 4 + 1 (trading: 1 + 3 + 1)
        assert_eq!((b[2].t, b[2].c, b[2].pi), (d0 + 2 * DAY, 6.0, Some(4.5)));
        // daily bars start at the day start
        let b = bars(&rows, &HashMap::new(), DAY, 8 * 60, false);
        assert_eq!(b.iter().map(|x| x.t).collect::<Vec<_>>(), [d0 - DAY, d0, d0 + 2 * DAY]);
        assert_eq!((b[1].o, b[1].c), (1.5, 5.0));
        let ds = days(d0 - 30 * m, d0 + DAY + 1, 8 * 60);
        assert_eq!(ds.iter().map(|d| (d.day.as_str(), d.start)).collect::<Vec<_>>(),
                   [("2026-10-04", d0 - DAY), ("2026-10-05", d0), ("2026-10-06", d0 + DAY)]);
    }

    #[test]
    fn per_day_bars_restart_at_each_day_start() {
        let d0 = utc(2026, 10, 5, 0, 0);
        let m = 60_000;
        let mut rows = vec![row(d0 - 20 * m, 2.0, Some(1.0)), row(d0 - 10 * m, 3.0, Some(1.5)), row(d0 + 10 * m, 0.5, Some(0.25))];
        rows[2].equity = 99.0;
        let b = bars(&rows, &HashMap::new(), 3_600_000, 0, true);
        assert_eq!(b.len(), 2);
        // as stored: day 0 ends at 3, day 1 starts again near 0 (not 3 + 0.5)
        assert_eq!((b[0].o, b[0].h, b[0].c, b[0].pi), (2.0, 3.0, 3.0, Some(1.5)));
        assert_eq!((b[1].t, b[1].o, b[1].c, b[1].pi, b[1].equity), (d0, 0.5, 0.5, Some(0.25), Some(99.0)));
    }

    #[test]
    fn reads_a_db_from_before_the_split_columns() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("old.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch(crate::store::SCHEMA).unwrap();
            c.execute("INSERT INTO equity VALUES (5000, '*', 1.0, 2.0, 0.0, 3.0, 4.0)", []).unwrap();
        }
        let r = with_db(&p, |c| desk_rows(c, 0, 10_000)).unwrap();
        assert_eq!(r, [DeskRow { t: 5000, pnl_day: 2.0, inventory: 3.0, futures: 4.0, equity: 1.0, ..Default::default() }]);
    }

    #[test]
    fn memory_reads_only_what_is_new_and_a_rewritten_fill_once() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("m.db");
        let c = Connection::open(&p).unwrap();
        c.execute_batch(crate::store::SCHEMA).unwrap();
        let eq = |t: i64, pnl: f64| c.execute("INSERT OR REPLACE INTO equity (t, account, pnl_day) VALUES (?, '*', ?)", rusqlite::params![t, pnl]).unwrap();
        let fill = |id: &str, ts: i64, px: f64| c.execute(
            "INSERT OR REPLACE INTO fills (id, ts, account, symbol, venue, side, price, qty) VALUES (?, ?, 'a', 'X', 'spot', 'buy', ?, 1.0)",
            rusqlite::params![id, ts, px]).unwrap();
        let now = 10 * DAY;
        eq(now - 300_000, 1.0);
        eq(now - 60_000, 2.0);
        fill("f1", now - 290_000, 5.0);
        let mut m = Mem::default();
        m.refresh(&c, now, 7 * DAY, 365 * DAY).unwrap();
        assert_eq!(m.rows.len(), 2);
        eq(now - 60_000, 3.0); // rewritten
        eq(now, 4.0);
        fill("f1", now - 290_000, 7.0); // written again
        fill("f2", now - 10_000, 1.0);
        m.refresh(&c, now, 7 * DAY, 365 * DAY).unwrap();
        assert_eq!(m.rows.iter().map(|r| r.pnl_day).collect::<Vec<_>>(), [1.0, 3.0, 4.0]);
        let f = m.flows(now - DAY, now + 1, 3_600_000, 0);
        assert_eq!(f.values().map(|v| v.1).sum::<i64>(), 2);
        assert_eq!(f.values().map(|v| v.0).sum::<f64>(), 8.0);
    }

    async fn fake_binance(hits: Arc<AtomicUsize>) -> String {
        async fn k(State(hits): State<Arc<AtomicUsize>>, Query(q): Params) -> Response {
            hits.fetch_add(1, Ordering::SeqCst);
            let iv = INTERVALS.iter().find(|i| i.0 == q["interval"]).unwrap().1;
            let (s, e): (i64, i64) = (q["startTime"].parse().unwrap(), q["endTime"].parse().unwrap());
            if q["symbol"] == "NOPE" {
                return (StatusCode::BAD_REQUEST, r#"{"code":-1121,"msg":"Invalid symbol."}"#).into_response();
            }
            let rows: Vec<serde_json::Value> = (0..q["limit"].parse::<i64>().unwrap())
                .map(|i| s + i * iv)
                .filter(|t| *t <= e)
                .map(|t| serde_json::json!([t, "1.5", "2", "1", "1.75", "10", t + iv - 1, "0", 3, "0", "0", "0"]))
                .collect();
            axum::Json(rows).into_response()
        }
        let app = Router::new().route("/api/v3/klines", get(k)).route("/fapi/v1/klines", get(k)).with_state(hits);
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        base
    }

    #[tokio::test(flavor = "current_thread")]
    async fn endpoints() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("desk.db");
        let s = Store::new(&db);
        let d0 = utc(2026, 10, 5, 0, 0);
        for (t, acc, pnl) in [(d0 - 5000, "*", 3.0), (d0 + 5000, "*", 1.0), (d0 + 65_000, "*", 2.0), (d0 + 65_000, "a", 9.0)] {
            s.put(Row::Equity(EquityRow { t, account: acc.into(), pnl_day: pnl, trading: Some(pnl), inventory: 10.0,
                                          realized: (acc == "*").then_some(0.5), hedge: None, ..Default::default() }));
        }
        let mut f = crate::fills::FillRec::new("f1", d0 + 1000, "a", "XUSDT", P::Venue::Spot, P::Side::Buy, 2.0, 3.0);
        f.maker = true;
        s.put(Row::Fill(Box::new(f)));
        s.put(Row::Fill(Box::new(crate::fills::FillRec::new("f2", d0 + 2000, "b", "YUSDT", P::Venue::Usdm,
                                                               P::Side::Sell, 10.0, 1.0))));
        s.start().unwrap();
        s.close();

        let hits = Arc::new(AtomicUsize::new(0));
        let fake = fake_binance(hits.clone()).await;
        let hub = Hub::new();
        let h = hub.handle();
        let api = Api::with_bases(db.clone(), 0, &fake, &fake).retention(3650.0, 3650.0);
        let srv = serve(&h, make_app(&h, None, dir.path().to_path_buf(), api), "127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", srv.addr);
        let get = |p: String| reqwest::get(format!("{base}{p}"));

        let v: serde_json::Value =
            get(format!("/api/history?from={}&to={}&step=60", d0 - DAY, d0 + DAY)).await.unwrap().json().await.unwrap();
        assert_eq!(v["step"], 60);
        let b = v["bars"].as_array().unwrap();
        assert_eq!(b.len(), 3);
        assert_eq!(b[0], serde_json::json!({"t": d0 - 60_000, "o": 0.0, "h": 0.0, "l": 0.0, "c": 0.0, "pi": 0.0,
            "realized": 0.0, "mm": null, "hedge": null, "rebates": null, "inventory": 10.0, "futures": 0.0, "equity": 0.0, "volume": 0.0, "fills": 0}));
        assert_eq!((&b[1]["c"], &b[1]["pi"], &b[1]["realized"]), (&1.0.into(), &1.0.into(), &0.5.into()));
        assert_eq!((&b[1]["volume"], &b[1]["fills"]), (&16.0.into(), &2.into()));
        assert_eq!(b[2]["c"], 2.0);
        // per=day: as stored, each day from its own start
        let w: serde_json::Value =
            get(format!("/api/history?from={}&to={}&step=60&per=day", d0 - DAY, d0 + DAY)).await.unwrap().json().await.unwrap();
        assert_eq!(w["bars"].as_array().unwrap().len(), 3);
        assert_eq!(v["days"][1], serde_json::json!({"day": "2026-10-05", "start": d0}));
        assert_eq!(get("/api/history?step=7".into()).await.unwrap().status(), 400);

        let v: serde_json::Value = get(format!("/api/fills?symbol=XUSDT&from={}&to={}", d0, d0 + DAY))
            .await.unwrap().json().await.unwrap();
        assert_eq!(v, serde_json::json!([{"t": d0 + 1000, "side": "buy", "price": 2.0, "qty": 3.0, "account": "a",
                                           "venue": "spot", "maker": true}]));
        let v: serde_json::Value =
            get(format!("/api/fills?from={}&to={}", d0, d0 + DAY)).await.unwrap().json().await.unwrap();
        assert_eq!(v.as_array().unwrap().len(), 2);
        assert_eq!(get("/api/fills?symbol=xusdt".into()).await.unwrap().status(), 400);

        // 1500 bars across two closed chunks, then served from the cache
        let q = format!("/api/klines?symbol=XUSDT&venue=usdm&interval=1m&from=0&to={}", 1499 * 60_000);
        let v: Vec<Vec<f64>> = get(q.clone()).await.unwrap().json().await.unwrap();
        assert_eq!(v.len(), 1500);
        assert_eq!(v[1], [60_000.0, 1.5, 2.0, 1.0, 1.75, 10.0]);
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        let w: Vec<Vec<f64>> = get(q).await.unwrap().json().await.unwrap();
        assert_eq!((w, hits.load(Ordering::SeqCst)), (v, 2));
        // the open chunk is fetched each time; at most MAX_BARS
        let q = format!("/api/klines?symbol=XUSDT&interval=1m&from=0&to={}", now_ms());
        let v: Vec<Vec<f64>> = get(q).await.unwrap().json().await.unwrap();
        assert_eq!(v.len(), MAX_BARS as usize);
        // 30m and 1w pass through under Binance's names
        for (name, iv) in [("30m", 1_800_000_i64), ("1w", 604_800_000)] {
            let q = format!("/api/klines?symbol=XUSDT&interval={name}&from=0&to={}", 9 * iv);
            let v: Vec<Vec<f64>> = get(q).await.unwrap().json().await.unwrap();
            assert_eq!((v.len(), v[1][0]), (10, iv as f64), "{name}");
        }
        for (q, code) in [("symbol=NOPE&interval=1m", 400), ("symbol=XUSDT&interval=2m", 400),
                          ("symbol=XUSDT&venue=coinm", 400), ("interval=1m", 400), ("symbol=A&interval=1m", 400)] {
            assert_eq!(get(format!("/api/klines?{q}")).await.unwrap().status(), code, "{q}");
        }
        srv.cleanup().await;
    }
}
