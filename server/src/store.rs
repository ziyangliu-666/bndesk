//! SQLite (WAL) persistence: one writer thread fed by a queue; today's rows reloaded on start.
//!
//! The schema migrates in place: a newer desk opens an older desk.db.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, Row as SqlRow, params};

use crate::fills::{FillRec, REF_ANCHORS, TK};
use crate::protocol::Marks;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS fills (id TEXT PRIMARY KEY, ts INTEGER, account TEXT, symbol TEXT, venue TEXT,
  side TEXT, price REAL, qty REAL, fee REAL, fee_asset TEXT, maker INTEGER, fair REAL, edge_bps REAL,
  ref0 REAL, has_ref INTEGER, mk TEXT, mk_raw TEXT);
CREATE INDEX IF NOT EXISTS fills_ts ON fills(ts);
CREATE TABLE IF NOT EXISTS equity (t INTEGER, account TEXT, equity REAL, pnl_day REAL, markout_pnl REAL,
  inventory REAL, futures_notional REAL, PRIMARY KEY (t, account));
CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, ts INTEGER, from_email TEXT, to_email TEXT,
  asset TEXT, amount REAL);
CREATE TABLE IF NOT EXISTS alerts (id TEXT, since INTEGER, rule TEXT, level TEXT, text TEXT, active INTEGER,
  PRIMARY KEY (id, since));
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS pnl_hours (t INTEGER PRIMARY KEY, trading REAL, hedged REAL, factor REAL,
  ref_hedge REAL, factor_hedge REAL, fills INTEGER, volume REAL, covered_s INTEGER);
";

/// Columns added after the first release: (table, column, type).
pub const MIGRATIONS: [(&str, &str, &str); 10] = [
    ("fills", "mk_fast", "TEXT"), ("fills", "tox", "TEXT"), ("fills", "refs", "TEXT"),
    ("equity", "trading", "REAL"), ("equity", "hedged", "REAL"), ("pnl_hours", "backfilled_s", "INTEGER"),
    ("equity", "realized", "REAL"), ("equity", "floating", "REAL"), ("equity", "hedge", "REAL"),
    ("equity", "mm", "REAL"),
];
pub const FILL_COLS: &str = "id, ts, account, symbol, venue, side, price, qty, fee, fee_asset, maker, fair, edge_bps, \
    ref0, has_ref, mk, mk_raw, mk_fast, tox, refs";
pub const EQUITY_COLS: &str = "t, account, equity, pnl_day, markout_pnl, inventory, futures_notional, trading, hedged, \
    realized, floating, hedge, mm";
pub const HOUR_COLS: &str = "t, trading, hedged, factor, ref_hedge, factor_hedge, fills, volume, covered_s, backfilled_s";

const SQL_FILL: &str = "INSERT OR REPLACE INTO fills (id, ts, account, symbol, venue, side, price, qty, fee, fee_asset, \
    maker, fair, edge_bps, ref0, has_ref, mk, mk_raw, mk_fast, tox, refs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const SQL_EQUITY: &str = "INSERT OR REPLACE INTO equity (t, account, equity, pnl_day, markout_pnl, inventory, \
    futures_notional, trading, hedged, realized, floating, hedge, mm) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
const SQL_HOUR: &str = "INSERT OR REPLACE INTO pnl_hours (t, trading, hedged, factor, ref_hedge, factor_hedge, fills, \
    volume, covered_s, backfilled_s) VALUES (?,?,?,?,?,?,?,?,?,?)";
const SQL_TRANSFER: &str = "INSERT OR IGNORE INTO transfers VALUES (?,?,?,?,?,?)";
const SQL_ALERT: &str = "INSERT OR REPLACE INTO alerts VALUES (?,?,?,?,?,?)";
const SQL_KV: &str = "INSERT OR REPLACE INTO kv VALUES (?,?)";

/// equity row; `trading` / `hedged` are NULL in rows written before those columns existed. `realized`
/// (realized + realized_old), `floating` and `hedge` (the futures legs' P&L) are the desk row's ("*")
/// real-money split so far today: NULL in per-account rows and in rows written before the columns existed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct EquityRow {
    pub t: i64,
    pub account: String,
    pub equity: f64,
    pub pnl_day: f64,
    pub markout_pnl: f64,
    pub inventory: f64,
    pub futures_notional: f64,
    pub trading: Option<f64>,
    pub hedged: Option<f64>,
    pub realized: Option<f64>,
    pub floating: Option<f64>,
    pub hedge: Option<f64>,
    pub mm: Option<f64>,
}

/// pnl_hours row; `backfilled_s` is NULL in rows written before that column existed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct HourRow {
    pub t: i64,
    pub trading: f64,
    pub hedged: f64,
    pub factor: f64,
    pub ref_hedge: f64,
    pub factor_hedge: f64,
    pub fills: i64,
    pub volume: f64,
    pub covered_s: i64,
    pub backfilled_s: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TransferRow {
    pub id: String,
    pub ts: i64,
    pub from_email: String,
    pub to_email: String,
    pub asset: String,
    pub amount: f64,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AlertRow {
    pub id: String,
    pub since: i64,
    pub rule: String,
    pub level: String,
    pub text: String,
    pub active: bool,
}

/// One queued write; the variant is Python's `kind` ("fill", "equity", "pnl_hour", "transfer", "alert", "kv").
#[derive(Debug, Clone)]
pub enum Row {
    Fill(Box<FillRec>),
    Equity(EquityRow),
    PnlHour(HourRow),
    Transfer(TransferRow),
    Alert(AlertRow),
    Kv(String, String),
}

enum Item {
    Row(Row),
    Prune(i64, i64),
    Stop,
}

/// What `load` returns (Python's dict).
#[derive(Debug, Default)]
pub struct Loaded {
    pub fills: Vec<FillRec>,
    pub equity: Vec<EquityRow>,
    pub hours: Vec<HourRow>,
    pub transfers: Vec<TransferRow>,
    pub alerts: Vec<AlertRow>,
    pub kv: HashMap<String, String>,
}

fn marks_json(m: &Marks) -> String {
    serde_json::to_string(m).expect("marks serialize")
}

fn keyed_json(keys: &[&str], vals: &[Option<f64>], skip_none: bool) -> String {
    let mut m = serde_json::Map::new();
    for (k, v) in keys.iter().zip(vals) {
        if v.is_some() || !skip_none {
            m.insert((*k).to_string(), v.and_then(serde_json::Number::from_f64).map_or(serde_json::Value::Null, Into::into));
        }
    }
    serde_json::Value::Object(m).to_string()
}

/// `{"1": .., "10": ..}` -> values in `keys` order; keys missing or null -> None.
fn parse_keyed<const N: usize>(s: &str, keys: &[&str; N]) -> [Option<f64>; N] {
    let mut out = [None; N];
    if let Ok(m) = serde_json::from_str::<HashMap<String, Option<f64>>>(s) {
        for (i, k) in keys.iter().enumerate() {
            out[i] = m.get(*k).copied().flatten();
        }
    }
    out
}

fn ref_keys() -> [&'static str; 4] {
    REF_ANCHORS.map(|(k, _)| k)
}

fn fill_params(f: &FillRec) -> [Value; 20] {
    let opt = |v: Option<f64>| v.map_or(Value::Null, Value::Real);
    [
        Value::Text(f.id.clone()), Value::Integer(f.ts), Value::Text(f.account.clone()),
        Value::Text(f.symbol.clone()), Value::Text(f.venue.as_str().into()), Value::Text(f.side.as_str().into()),
        Value::Real(f.price), Value::Real(f.qty), Value::Real(f.fee), Value::Text(f.fee_asset.clone()),
        Value::Integer(f.maker as i64), opt(f.fair), opt(f.edge_bps), opt(f.ref0), Value::Integer(f.has_ref as i64),
        Value::Text(marks_json(&f.mk)), Value::Text(marks_json(&f.mk_raw)), Value::Text(marks_json(&f.mk_fast)),
        Value::Text(keyed_json(&TK, &f.tox, false)), Value::Text(keyed_json(&ref_keys(), &f.refs, true)),
    ]
}

// SQLite is dynamically typed: read numbers whatever their storage class, NULL as None.
fn f64_opt(r: &SqlRow, i: usize) -> rusqlite::Result<Option<f64>> {
    Ok(match r.get_ref(i)? {
        ValueRef::Integer(v) => Some(v as f64),
        ValueRef::Real(v) => Some(v),
        ValueRef::Text(t) => std::str::from_utf8(t).ok().and_then(|s| s.parse().ok()),
        _ => None,
    })
}

fn f64_at(r: &SqlRow, i: usize) -> rusqlite::Result<f64> {
    Ok(f64_opt(r, i)?.unwrap_or(0.0))
}

fn i64_opt(r: &SqlRow, i: usize) -> rusqlite::Result<Option<i64>> {
    Ok(match r.get_ref(i)? {
        ValueRef::Integer(v) => Some(v),
        ValueRef::Real(v) => Some(v as i64),
        ValueRef::Text(t) => std::str::from_utf8(t).ok().and_then(|s| s.parse().ok()),
        _ => None,
    })
}

fn i64_at(r: &SqlRow, i: usize) -> rusqlite::Result<i64> {
    Ok(i64_opt(r, i)?.unwrap_or(0))
}

fn str_opt(r: &SqlRow, i: usize) -> rusqlite::Result<Option<String>> {
    Ok(match r.get_ref(i)? {
        ValueRef::Text(t) | ValueRef::Blob(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Integer(v) => Some(v.to_string()),
        ValueRef::Real(v) => Some(v.to_string()),
        ValueRef::Null => None,
    })
}

fn str_at(r: &SqlRow, i: usize) -> rusqlite::Result<String> {
    Ok(str_opt(r, i)?.unwrap_or_default())
}

pub fn row_fill(r: &SqlRow) -> rusqlite::Result<FillRec> {
    let venue = str_at(r, 4)?.parse().unwrap_or_default();
    let side = str_at(r, 5)?.parse().unwrap_or_default();
    let mut f = FillRec::new(str_at(r, 0)?, i64_at(r, 1)?, str_at(r, 2)?, str_at(r, 3)?, venue, side, f64_at(r, 6)?,
                             f64_at(r, 7)?);
    f.fee = f64_at(r, 8)?;
    f.fee_asset = str_at(r, 9)?;
    f.maker = i64_at(r, 10)? != 0;
    f.fair = f64_opt(r, 11)?;
    f.edge_bps = f64_opt(r, 12)?;
    f.ref0 = f64_opt(r, 13)?;
    f.has_ref = i64_at(r, 14)? != 0;
    let hk = crate::fills::HK;
    f.mk = Marks(parse_keyed(&str_at(r, 15)?, &hk));
    f.mk_raw = Marks(parse_keyed(&str_at(r, 16)?, &hk));
    if let Some(s) = str_opt(r, 17)?.filter(|s| !s.is_empty()) {
        f.mk_fast = Marks(parse_keyed(&s, &hk));
    }
    if let Some(s) = str_opt(r, 18)?.filter(|s| !s.is_empty()) {
        f.tox = parse_keyed(&s, &TK);
    }
    if let Some(s) = str_opt(r, 19)?.filter(|s| !s.is_empty()) {
        f.refs = parse_keyed(&s, &ref_keys());
    }
    Ok(f)
}

pub struct Store {
    pub path: PathBuf,
    tx: Sender<Item>,
    rx: Mutex<Option<Receiver<Item>>>,
    thread: Mutex<Option<(JoinHandle<()>, Receiver<()>)>>,
}

impl Store {
    pub fn new(path: impl AsRef<Path>) -> Store {
        let (tx, rx) = mpsc::channel();
        Store { path: path.as_ref().to_path_buf(), tx, rx: Mutex::new(Some(rx)), thread: Mutex::new(None) }
    }

    fn connect(&self) -> rusqlite::Result<Connection> {
        if let Some(dir) = self.path.parent().filter(|d| !d.as_os_str().is_empty()) {
            let _ = std::fs::create_dir_all(dir);
        }
        let c = Connection::open(&self.path)?;
        c.busy_timeout(Duration::from_secs(5))?; // Python sqlite3's default timeout
        c.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))?;
        c.execute_batch("PRAGMA synchronous=NORMAL")?;
        c.execute_batch(SCHEMA)?;
        for (table, col, typ) in MIGRATIONS {
            let mut st = c.prepare(&format!("PRAGMA table_info({table})"))?;
            let cols: Vec<String> = st.query_map([], |r| r.get(1))?.collect::<Result<_, _>>()?;
            if !cols.iter().any(|c| c == col) {
                c.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {typ}"))?;
            }
        }
        Ok(c)
    }

    /// Rows from `since` on (hour rows from `hours_back` hours earlier), alerts still active, all kv.
    /// Python's default `hours_back` is 61 * 24.
    pub fn load(&self, since: i64, hours_back: i64) -> rusqlite::Result<Loaded> {
        let c = self.connect()?;
        let mut out = Loaded::default();
        let mut st = c.prepare(&format!("SELECT {FILL_COLS} FROM fills WHERE ts >= ? ORDER BY ts"))?;
        out.fills = st.query_map([since], row_fill)?.collect::<Result<_, _>>()?;
        let mut st = c.prepare(&format!("SELECT {EQUITY_COLS} FROM equity WHERE t >= ? ORDER BY t"))?;
        out.equity = st
            .query_map([since], |r| {
                Ok(EquityRow {
                    t: i64_at(r, 0)?,
                    account: str_at(r, 1)?,
                    equity: f64_at(r, 2)?,
                    pnl_day: f64_at(r, 3)?,
                    markout_pnl: f64_at(r, 4)?,
                    inventory: f64_at(r, 5)?,
                    futures_notional: f64_at(r, 6)?,
                    trading: f64_opt(r, 7)?,
                    hedged: f64_opt(r, 8)?,
                    realized: f64_opt(r, 9)?,
                    floating: f64_opt(r, 10)?,
                    hedge: f64_opt(r, 11)?,
                    mm: f64_opt(r, 12)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut st = c.prepare(&format!("SELECT {HOUR_COLS} FROM pnl_hours WHERE t >= ? ORDER BY t"))?;
        out.hours = st
            .query_map([since - hours_back * 3_600_000], |r| {
                Ok(HourRow {
                    t: i64_at(r, 0)?,
                    trading: f64_at(r, 1)?,
                    hedged: f64_at(r, 2)?,
                    factor: f64_at(r, 3)?,
                    ref_hedge: f64_at(r, 4)?,
                    factor_hedge: f64_at(r, 5)?,
                    fills: i64_at(r, 6)?,
                    volume: f64_at(r, 7)?,
                    covered_s: i64_at(r, 8)?,
                    backfilled_s: i64_opt(r, 9)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut st = c.prepare("SELECT * FROM transfers WHERE ts >= ?")?;
        out.transfers = st
            .query_map([since], |r| {
                Ok(TransferRow {
                    id: str_at(r, 0)?,
                    ts: i64_at(r, 1)?,
                    from_email: str_at(r, 2)?,
                    to_email: str_at(r, 3)?,
                    asset: str_at(r, 4)?,
                    amount: f64_at(r, 5)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut st = c.prepare("SELECT * FROM alerts WHERE since >= ? OR active = 1 ORDER BY since")?;
        out.alerts = st
            .query_map([since], |r| {
                Ok(AlertRow {
                    id: str_at(r, 0)?,
                    since: i64_at(r, 1)?,
                    rule: str_at(r, 2)?,
                    level: str_at(r, 3)?,
                    text: str_at(r, 4)?,
                    active: i64_at(r, 5)? != 0,
                })
            })?
            .collect::<Result<_, _>>()?;
        let mut st = c.prepare("SELECT k, v FROM kv")?;
        out.kv = st.query_map([], |r| Ok((str_at(r, 0)?, str_at(r, 1)?)))?.collect::<Result<_, _>>()?;
        Ok(out)
    }

    /// Starts the writer thread; rows put before this wait in the queue.
    pub fn start(&self) -> rusqlite::Result<()> {
        let Some(rx) = self.rx.lock().unwrap().take() else { return Ok(()) };
        let c = self.connect()?;
        let (done_tx, done_rx) = mpsc::channel();
        let h = std::thread::Builder::new()
            .name("desk-store".into())
            .spawn(move || {
                run(c, rx);
                let _ = done_tx.send(());
            })
            .expect("spawn desk-store");
        *self.thread.lock().unwrap() = Some((h, done_rx));
        Ok(())
    }

    /// Equity rows: 5 s grid before fine_before thinned to one a minute; everything before keep_after dropped.
    pub fn prune(&self, fine_before: i64, keep_after: i64) {
        let _ = self.tx.send(Item::Prune(fine_before, keep_after));
    }

    pub fn put(&self, row: Row) {
        let _ = self.tx.send(Item::Row(row));
    }

    /// Flushes the queue and stops the writer (waits at most 5 s).
    pub fn close(&self) {
        let Some((h, done)) = self.thread.lock().unwrap().take() else { return };
        let _ = self.tx.send(Item::Stop);
        match done.recv_timeout(Duration::from_secs(5)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                let _ = h.join();
            }
            Err(RecvTimeoutError::Timeout) => tracing::warn!("store writer still busy after 5 s"),
        }
    }
}

fn write(c: &Connection, batch: &[Item]) -> rusqlite::Result<()> {
    let tx = c.unchecked_transaction()?;
    for b in batch {
        match b {
            Item::Stop => {}
            Item::Prune(fine, keep) => {
                c.execute("DELETE FROM equity WHERE t < ? AND t % 60000 != 0", [fine])?;
                c.execute("DELETE FROM equity WHERE t < ?", [keep])?;
                c.execute("DELETE FROM fills WHERE ts < ?", [keep])?;
                c.execute("DELETE FROM transfers WHERE ts < ?", [keep])?;
                c.execute("DELETE FROM alerts WHERE active = 0 AND since < ?", [keep])?;
                c.execute("DELETE FROM pnl_hours WHERE t < ?", [keep])?;
            }
            Item::Row(Row::Fill(f)) => {
                c.prepare_cached(SQL_FILL)?.execute(rusqlite::params_from_iter(fill_params(f)))?;
            }
            Item::Row(Row::Equity(e)) => {
                c.prepare_cached(SQL_EQUITY)?.execute(params![e.t, e.account, e.equity, e.pnl_day, e.markout_pnl,
                                                              e.inventory, e.futures_notional, e.trading, e.hedged,
                                                              e.realized, e.floating, e.hedge, e.mm])?;
            }
            Item::Row(Row::PnlHour(h)) => {
                c.prepare_cached(SQL_HOUR)?.execute(params![h.t, h.trading, h.hedged, h.factor, h.ref_hedge,
                                                            h.factor_hedge, h.fills, h.volume, h.covered_s,
                                                            h.backfilled_s])?;
            }
            Item::Row(Row::Transfer(t)) => {
                c.prepare_cached(SQL_TRANSFER)?.execute(params![t.id, t.ts, t.from_email, t.to_email, t.asset,
                                                                t.amount])?;
            }
            Item::Row(Row::Alert(a)) => {
                c.prepare_cached(SQL_ALERT)?.execute(params![a.id, a.since, a.rule, a.level, a.text,
                                                             a.active as i64])?;
            }
            Item::Row(Row::Kv(k, v)) => {
                c.prepare_cached(SQL_KV)?.execute(params![k, v])?;
            }
        }
    }
    tx.commit()
}

fn run(c: Connection, rx: Receiver<Item>) {
    // the Store owns the sender, so recv only fails once it is dropped
    while let Ok(item) = rx.recv() {
        let mut batch = vec![item];
        while batch.len() < 5000 {
            match rx.try_recv() {
                Ok(i) => batch.push(i),
                Err(_) => break,
            }
        }
        let stop = batch.iter().any(|b| matches!(b, Item::Stop));
        if let Err(e) = write(&c, &batch) {
            // keep writing later batches
            tracing::error!("store: batch of {} dropped: {e}", batch.len());
        }
        if stop {
            break;
        }
    }
    let _ = c.close();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Side, Venue};

    fn eq(t: i64) -> Row {
        Row::Equity(EquityRow { t, account: "a".into(), equity: 1.0, trading: Some(0.0), hedged: Some(0.0),
                                ..Default::default() })
    }

    #[test]
    fn test_prune_thins_and_drops() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().join("p.db"));
        s.start().unwrap();
        for t in [5_000, 60_000, 65_000, 120_000, 1_000_000] {
            s.put(eq(t));
        }
        s.prune(200_000, 10_000);
        s.close();
        let rows: Vec<i64> = s.load(0, 61 * 24).unwrap().equity.iter().map(|r| r.t).collect();
        assert_eq!(rows, [60_000, 120_000, 1_000_000]);
    }

    #[test]
    fn puts_before_start_are_kept() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().join("sub/q.db"));
        s.put(Row::Kv("a".into(), "1".into()));
        s.start().unwrap();
        s.close();
        assert_eq!(s.load(0, 0).unwrap().kv.get("a").map(String::as_str), Some("1"));
    }

    #[test]
    fn fill_round_trip_and_rows() {
        let d = tempfile::tempdir().unwrap();
        let s = Store::new(d.path().join("f.db"));
        let mut f = FillRec::new("x1", 1000, "acc", "BTCUSDT", Venue::Usdm, Side::Sell, 100.5, 0.25);
        f.fee = 0.01;
        f.fee_asset = "USDT".into();
        f.maker = false;
        f.fair = Some(100.4);
        f.edge_bps = Some(-9.95);
        f.has_ref = true;
        f.ref0 = Some(50.0);
        f.mk = Marks([Some(1.5), None, Some(-2.0), None]);
        f.mk_raw = Marks([Some(1.0), Some(2.0), None, None]);
        f.mk_fast = Marks([None, None, None, Some(0.1)]);
        f.tox = [Some(0.0), None, Some(3.25), None, None];
        f.refs = [Some(49.9), Some(50.0), None, Some(50.1)];
        s.put(Row::Fill(Box::new(f.clone())));
        s.put(Row::PnlHour(HourRow { t: 3_600_000, trading: 1.0, hedged: 0.5, factor: 0.25, ref_hedge: 0.1,
                                     factor_hedge: 0.2, fills: 3, volume: 300.0, covered_s: 3600,
                                     backfilled_s: Some(60) }));
        s.put(Row::Transfer(TransferRow { id: "t1".into(), ts: 5, from_email: "a@x".into(), to_email: "b@x".into(),
                                          asset: "USDT".into(), amount: 10.0 }));
        s.put(Row::Transfer(TransferRow { id: "t1".into(), ts: 5, amount: 99.0, ..Default::default() }));
        s.put(Row::Alert(AlertRow { id: "al".into(), since: 1, rule: "r".into(), level: "warn".into(),
                                    text: "t".into(), active: true }));
        s.start().unwrap();
        s.close();
        let l = s.load(100, 1).unwrap();
        assert_eq!(l.fills, vec![f]);
        assert_eq!(l.hours.len(), 1);
        assert_eq!(l.hours[0].backfilled_s, Some(60));
        assert_eq!(l.transfers.len(), 0); // ts 5 < since 100
        assert_eq!(s.load(0, 1).unwrap().transfers[0].amount, 10.0); // INSERT OR IGNORE
        assert!(l.alerts[0].active); // active alerts come back whatever their age
    }

    #[test]
    fn opens_a_pre_migration_db() {
        // a desk.db from the first release: no migrated columns; rows from then read as NULL
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("old.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch(SCHEMA).unwrap();
            c.execute("INSERT INTO fills VALUES ('o', 7, 'a', 'S', 'spot', 'buy', 1.0, 2.0, 0.0, '', 1, NULL, NULL, \
                       NULL, 0, '{\"1\": 2.5, \"10\": null, \"60\": null, \"300\": null}', '{}')", []).unwrap();
            c.execute("INSERT INTO equity VALUES (5000, '*', 1.0, 2.0, 0.0, 3.0, 4.0)", []).unwrap();
            c.execute("INSERT INTO pnl_hours VALUES (0, 1.0, 1.0, 1.0, 1.0, 1.0, 2, 3.0, 60)", []).unwrap();
        }
        let s = Store::new(&p);
        let l = s.load(0, 1).unwrap();
        assert_eq!(l.fills[0].mk, Marks([Some(2.5), None, None, None]));
        assert_eq!(l.fills[0].tox, [None; 5]);
        assert_eq!((l.equity[0].trading, l.equity[0].hedged), (None, None));
        assert_eq!((l.equity[0].realized, l.equity[0].floating, l.equity[0].hedge), (None, None, None));
        let s = Store::new(&p);
        s.put(Row::Equity(EquityRow { t: 10_000, account: "*".into(), realized: Some(1.5), floating: Some(-0.5),
                                      hedge: Some(2.0), ..Default::default() }));
        s.start().unwrap();
        s.close();
        let e = s.load(10_000, 0).unwrap().equity;
        assert_eq!((e[0].realized, e[0].floating, e[0].hedge, e[0].trading), (Some(1.5), Some(-0.5), Some(2.0), None));
        assert_eq!(l.hours[0].backfilled_s, None);
        let c = Connection::open(&p).unwrap();
        let mode: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode, "wal");
    }
}
