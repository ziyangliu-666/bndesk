//! `desk recompute-mm`: past days' market making as if the kline backfill of missed marks had always been
//! there.
//!
//! Before it, a spot fill whose mark at t + h (h = `mm_horizon_s`) was never taken (the desk was down then, or
//! its 1 s ring had a hole) was valued at the mid now for the rest of its day, so the stored market making
//! drifted with the inventory. Per past day this backfills the fills' missing marks the way the live backfill
//! does (`backfill::backfill_marks`: same klines, same pacing) and stores them, then corrects what was stored
//! from them: the desk equity rows' `mm` (the day's market making so far, which History and the day pages
//! draw) and the day's kept split (`kv dayreal:<day>`: `mm`, and `inventory` = trading − mm). Nothing else
//! changes: equity, day PnL, trading, hedge and rebates are not touched.
//!
//! A row at t had each such fill f (from t_f + h + grace on) at s q (M(t) − p) − fee; it now has f at its mark,
//! s q (M(t_f + h) − p) − fee, or leaves f out when klines have no price there, as live market making does now.
//! M(t), the mid the old row used, comes from 1 min klines (open → close of the minute, as the backfill reads
//! them). Only fills of days before today are read and only rows of those days written, one transaction per
//! day, so it runs beside the live desk (WAL); the desk reloads the kept days on its next start.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use rusqlite::{Connection, OptionalExtension, params};

use crate::backfill::{Prices, backfill_marks_with, interp_at, none_on_400};
use crate::fills::{FillBook, FillRec, HK, MARK_GRACE_MS};
use crate::market::{Market, STABLES};
use crate::protocol::{Side, Venue};
use crate::store::{FILL_COLS, SQL_FILL, fill_params, row_fill};

pub const DAY: i64 = 86_400_000;

/// What a day's recompute found (and wrote, unless a dry run).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DayReport {
    pub day: String,
    /// The day's market making as the equity rows end it (what History's bars sum to), before and after.
    pub old_mm: Option<f64>,
    pub new_mm: Option<f64>,
    /// The day's kept split (`dayreal:<day>`, the day tables' row), before and after.
    pub old_kept: Option<f64>,
    pub new_kept: Option<f64>,
    /// Spot fills past h + grace with no mark at h, before the backfill, and their notional.
    pub unmarked: usize,
    pub unmarked_notional: f64,
    /// Of those, the ones klines priced, and the ones they could not (left out of market making).
    pub backfilled: usize,
    pub backfilled_notional: f64,
    pub unpriceable: usize,
    pub unpriceable_notional: f64,
    /// Marks booked over all horizons (raw and net) and fills whose row changed.
    pub marks: usize,
    pub fills_written: usize,
    /// Equity rows whose `mm` changed.
    pub rows: usize,
}

/// A fill whose value in the old rows was the mid then: from `from` on, the old rows had it at
/// s q (M(t) − p) qpx − fee, the new ones at its mark (`bps`), or not at all (None).
struct Adj {
    from: i64,
    key: String,
    s: f64,
    q: f64,
    p: f64,
    quote: String,
    fee: f64,
    fee_asset: String,
    bps: Option<f64>,
}

/// 1 min bars by key, for the mids the old rows used and the USD prices of quotes and fee assets.
struct Mids(HashMap<String, Vec<(i64, f64, f64)>>);

impl Mids {
    fn at(&self, key: &str, t: i64) -> Option<f64> {
        self.0.get(key).and_then(|b| interp_at(b, t)).filter(|x| *x > 0.0)
    }

    /// An asset's USD price at t: 1 for a stable, else its USDT spot market's.
    fn usd(&self, asset: &str, t: i64) -> Option<f64> {
        if asset.is_empty() {
            return None;
        }
        if STABLES.contains(&asset) {
            return Some(1.0);
        }
        self.at(&format!("spot:{asset}USDT"), t)
    }
}

impl Adj {
    fn qpx(&self, m: &Mids, t: i64) -> f64 {
        m.usd(&self.quote, t).unwrap_or(1.0)
    }

    fn fee_usd(&self, m: &Mids, t: i64) -> f64 {
        if self.fee == 0.0 { 0.0 } else { self.fee * m.usd(&self.fee_asset, t).unwrap_or(0.0) }
    }

    /// New less old value in a row at t (from `from` on).
    fn delta(&self, m: &Mids, t: i64) -> f64 {
        let (qpx, fee) = (self.qpx(m, t), self.fee_usd(m, t));
        let old = m.at(&self.key, t).map_or(0.0, |x| self.s * self.q * (x - self.p) * qpx) - fee;
        let new = self.bps.map_or(0.0, |b| self.q * self.p * qpx * b / 1e4 - fee);
        new - old
    }
}

/// The day start of a UTC date ("YYYY-MM-DD"), `day_start_min` after its midnight.
pub fn day_start_of(day: &str, day_start_min: i64) -> anyhow::Result<i64> {
    let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|e| anyhow::anyhow!("bad day {day:?}: {e}"))?;
    Ok(d.and_hms_opt(0, 0, 0).expect("midnight").and_utc().timestamp_millis() + day_start_min * 60_000)
}

fn day_fills(c: &Connection, ds: i64) -> rusqlite::Result<Vec<FillRec>> {
    let mut st = c.prepare(&format!("SELECT {FILL_COLS} FROM fills WHERE ts >= ? AND ts < ? ORDER BY ts"))?;
    st.query_map([ds, ds + DAY], row_fill)?.collect()
}

/// Recompute the market making of the day starting at `ds` (a past day: `ds + DAY <= today`'s start, checked by
/// the caller), backfilling its fills' marks from `src` on `market` (the configured markets and their
/// references `ensure`d). `now`: the clock the marks are due by. Writes in one transaction unless `dry_run`.
pub async fn recompute_day(c: &mut Connection, market: &Rc<RefCell<Market>>, src: &impl Prices, ds: i64,
                           horizon_s: i64, now: i64, dry_run: bool) -> anyhow::Result<DayReport> {
    let h = HK.iter().position(|k| *k == horizon_s.to_string()).unwrap_or(2);
    let hms = horizon_s * 1000;
    let end = ds + DAY;
    let mut rep = DayReport { day: crate::pnl::utc_day(ds), ..Default::default() };

    // the day's fills, and those market making valued at the mid now past h + grace (before the fix)
    let fills = day_fills(c, ds)?;
    let mut book = FillBook::new();
    {
        let mut m = market.borrow_mut();
        for f in fills {
            book.add(&mut m, f, false);
        }
    }
    book.take_dirty();
    // (a fill flagged unpriceable at h already was corrected by an earlier run)
    let unmarked: Vec<String> = book
        .fills
        .iter()
        .filter(|f| f.venue == Venue::Spot && f.mk_raw.0[h].is_none() && !f.unpriceable(h) && f.ts + hms + MARK_GRACE_MS < end)
        .map(|f| f.id.clone())
        .collect();

    // their marks, as the live backfill books them
    let access = (Rc::new(RefCell::new(book)), market.clone());
    // (a dry run asks only the instruments' prices: the references' trades, 10 s apart under the budget, change
    // only the net marks, not market making)
    rep.marks = backfill_marks_with(&access, src, now, !dry_run).await?;
    let changed = access.0.borrow_mut().take_dirty();
    rep.fills_written = changed.len();
    let mut adjs = vec![];
    for id in &unmarked {
        let Some(f) = access.0.borrow().get(id).cloned() else { continue };
        let notional = f.notional();
        rep.unmarked += 1;
        rep.unmarked_notional += notional;
        let bps = f.mk_raw.0[h];
        if bps.is_some() {
            rep.backfilled += 1;
            rep.backfilled_notional += notional;
        } else {
            rep.unpriceable += 1;
            rep.unpriceable_notional += notional;
        }
        let quote = market.borrow().get(&f.key()).map(|i| i.quote.clone()).unwrap_or_default();
        adjs.push(Adj {
            from: f.ts + hms + MARK_GRACE_MS,
            key: f.key(),
            s: if f.side == Side::Buy { 1.0 } else { -1.0 },
            q: f.qty,
            p: f.price,
            quote,
            fee: f.fee,
            fee_asset: f.fee_asset.clone(),
            bps,
        });
    }

    // the mids the old rows used, and the USD prices of the quotes and fee assets, from 1 min klines
    let mut want: BTreeMap<String, i64> = BTreeMap::new();
    for a in &adjs {
        let mut need = vec![a.key.clone()];
        let fee_asset = if a.fee != 0.0 { a.fee_asset.as_str() } else { "" };
        for asset in [a.quote.as_str(), fee_asset] {
            if !asset.is_empty() && !STABLES.contains(&asset) {
                need.push(format!("spot:{asset}USDT"));
            }
        }
        for k in need {
            let e = want.entry(k).or_insert(a.from);
            *e = (*e).min(a.from);
        }
    }
    let mut mids = HashMap::new();
    for (key, from) in want {
        let a = (from - 60_000).div_euclid(60_000) * 60_000;
        mids.insert(key.clone(), none_on_400(src.bars(&key, "1m", a, end - 1).await)?);
    }
    let mids = Mids(mids);

    // the desk rows of the day, corrected
    let rows: Vec<(i64, f64)> = {
        let mut st = c.prepare("SELECT t, mm FROM equity WHERE account = '*' AND t >= ? AND t < ? AND mm IS NOT NULL ORDER BY t")?;
        st.query_map([ds, end], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?
    };
    let corr = |t: i64| -> f64 { adjs.iter().filter(|a| t >= a.from).map(|a| a.delta(&mids, t)).sum() };
    let mut new_rows = vec![];
    for &(t, mm) in &rows {
        let d = corr(t);
        if d != 0.0 {
            new_rows.push((t, mm + d));
        }
    }
    rep.rows = new_rows.len();
    if let Some(&(t, mm)) = rows.last() {
        rep.old_mm = Some(mm);
        rep.new_mm = Some(mm + corr(t));
    }

    // the day's kept split: market making at the day's end, the inventory P&L what trading leaves
    let k = format!("dayreal:{}", rep.day);
    let kept: Option<String> = c.query_row("SELECT v FROM kv WHERE k = ?", [&k], |r| r.get(0)).optional()?;
    let mut new_kept = None;
    if let Some(v) = kept
        && let Ok(mut j) = serde_json::from_str::<serde_json::Value>(&v)
        && let Some(mm) = j.get("mm").and_then(|x| x.as_f64())
    {
        let t_end = rows.last().map_or(end - 1, |r| r.0);
        let mm_new = mm + corr(t_end);
        rep.old_kept = Some(mm);
        rep.new_kept = Some(mm_new);
        j["mm"] = serde_json::json!(mm_new);
        if let Some(tr) = j.get("trading").and_then(|x| x.as_f64()) {
            j["inventory"] = serde_json::json!(tr - mm_new);
        }
        new_kept = Some(j.to_string());
    }

    if !dry_run {
        let tx = c.transaction()?;
        for f in &changed {
            tx.prepare_cached(SQL_FILL)?.execute(rusqlite::params_from_iter(fill_params(f)))?;
        }
        for (t, mm) in &new_rows {
            tx.prepare_cached("UPDATE equity SET mm = ? WHERE t = ? AND account = '*'")?.execute(params![mm, t])?;
        }
        if let Some(v) = &new_kept {
            tx.execute("UPDATE kv SET v = ? WHERE k = ?", params![v, k])?;
        }
        tx.commit()?;
    }
    Ok(rep)
}

/// The first day the desk valued fills this way live (fd23289 deployed early on 2026-10-17 UTC): from it on, a
/// fill without its mark was left out live, not valued at the mid, and there is nothing to correct.
pub const FIRST_FIXED_DAY: &str = "2026-10-17";

/// `desk recompute-mm --from --to [--dry-run]`: each day in [from, to] (UTC dates) before today and before
/// FIRST_FIXED_DAY, on the configured db; prints the table.
pub async fn run(cfg: &crate::config::Config, from: &str, to: &str, dry_run: bool) -> anyhow::Result<Vec<DayReport>> {
    use crate::binance::rest::{Rest, client, governors};
    let (a, b) = (day_start_of(from, cfg.day_start_min)?, day_start_of(to, cfg.day_start_min)?);
    let now = crate::clock::now_ms();
    let today = crate::sessions::day_start(now, cfg.day_start_min);
    let fixed = day_start_of(FIRST_FIXED_DAY, cfg.day_start_min)?;
    let rest = Rest::new(client(), governors(), None, None);
    let spot: serde_json::Value = rest.get("/api/v3/exchangeInfo", &[], 20, false).await?;
    let usdm: serde_json::Value = rest.get("/fapi/v1/exchangeInfo", &[], 1, false).await?;
    let mut info: crate::market::Info = HashMap::new();
    info.insert(Venue::Spot, crate::market::parse_exchange_info(&spot));
    info.insert(Venue::Usdm, crate::market::parse_exchange_info(&usdm));
    let market = Rc::new(RefCell::new(Market::new(info, cfg.fair_halflife_s, cfg.mark_max_spread_bps)));
    {
        let mut m = market.borrow_mut();
        for mc in &cfg.markets {
            m.ensure(&mc.symbol, mc.venue, mc.reference.as_ref().map(|r| (r.symbol.as_str(), r.venue)));
        }
    }
    let mut c = crate::store::open(&cfg.db)?;
    let mut reps = vec![];
    let mut ds = a;
    while ds <= b {
        let day = crate::pnl::utc_day(ds);
        if ds + DAY > today || ds >= fixed {
            eprintln!("{day}: skipped (today, or valued with the fix live)");
        } else {
            let r = recompute_day(&mut c, &market, &rest, ds, cfg.mm_horizon_s, now, dry_run).await?;
            eprintln!("{day}: rows {} -> {}, kept {} -> {}{}", fmt(r.old_mm), fmt(r.new_mm), fmt(r.old_kept), fmt(r.new_kept),
                      if dry_run { " (dry run)" } else { " (written)" });
            reps.push(r);
        }
        ds += DAY;
    }
    print!("{}", table(&reps));
    Ok(reps)
}

fn fmt(x: Option<f64>) -> String {
    x.map_or_else(|| "-".into(), |v| format!("{v:.2}"))
}

/// The reports as a table: per day the old and new market making (rows' end / kept split), the fills
/// backfilled and those klines could not price.
pub fn table(reps: &[DayReport]) -> String {
    let mut s = format!(
        "{:<10} {:>9} {:>9} {:>8} {:>9} {:>9} {:>8} {:>9} {:>12} {:>11} {:>12} {:>6} {:>6} {:>6}\n",
        "day", "rows old", "rows new", "change", "kept old", "kept new", "change", "unmarked", "backfilled", "notional",
        "unpriceable", "notnl", "marks", "rows");
    for r in reps {
        let ch = |a: Option<f64>, b: Option<f64>| fmt(a.zip(b).map(|(a, b)| b - a));
        s += &format!(
            "{:<10} {:>9} {:>9} {:>8} {:>9} {:>9} {:>8} {:>9} {:>12} {:>11.0} {:>12} {:>6.0} {:>6} {:>6}\n",
            r.day, fmt(r.old_mm), fmt(r.new_mm), ch(r.old_mm, r.new_mm), fmt(r.old_kept), fmt(r.new_kept),
            ch(r.old_kept, r.new_kept), r.unmarked, r.backfilled, r.backfilled_notional, r.unpriceable,
            r.unpriceable_notional, r.marks, r.rows);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::market::{Info, SymbolInfo};
    use crate::store::{EquityRow, Row, Store};
    use approx::assert_relative_eq;

    const DS: i64 = 1_000 * DAY;

    /// 1 s and 1 min klines from tables; trades from a table.
    #[derive(Default)]
    struct Mock {
        secs: HashMap<String, Vec<(i64, f64, f64)>>,
        mins: HashMap<String, Vec<(i64, f64, f64)>>,
        log: RefCell<Vec<String>>,
    }

    impl Prices for Mock {
        async fn bars(&self, key: &str, interval: &str, start: i64, end: i64) -> anyhow::Result<Vec<(i64, f64, f64)>> {
            self.log.borrow_mut().push(format!("{interval} {key}"));
            let t = if interval == "1s" { &self.secs } else { &self.mins };
            Ok(t.get(key).map(|v| v.iter().copied().filter(|b| b.0 >= start && b.0 <= end).collect()).unwrap_or_default())
        }

        async fn trade_at(&self, _key: &str, _t: i64) -> anyhow::Result<Option<f64>> {
            Ok(None)
        }
    }

    fn market() -> Rc<RefCell<Market>> {
        let mut info: Info = HashMap::new();
        info.insert(Venue::Spot, HashMap::from([
            ("AAAUSDT".to_string(), SymbolInfo::new("AAA", "USDT", 0.0)),
            ("BBBUSDT".to_string(), SymbolInfo::new("BBB", "USDT", 0.0)),
        ]));
        info.insert(Venue::Usdm, HashMap::new());
        Rc::new(RefCell::new(Market::new(info, 120.0, 50.0)))
    }

    fn fill(id: &str, ts: i64, sym: &str, side: Side, price: f64, qty: f64, mk60: Option<f64>) -> FillRec {
        let mut f = FillRec::new(id, ts, "acct", sym, Venue::Spot, side, price, qty);
        f.mk_raw.0 = [Some(1.0), Some(1.0), mk60, Some(1.0)];
        f.mk.0 = f.mk_raw.0;
        f
    }

    fn desk_row(t: i64, mm: f64) -> Row {
        Row::Equity(EquityRow { t, account: "*".into(), equity: 1000.0, pnl_day: 5.0, trading: Some(3.0), mm: Some(mm),
                                ..Default::default() })
    }

    /// A day with one fill marked live, one whose 60 s mark the desk missed (klines have it) and one klines
    /// cannot price; the old rows valued the last two at the mid then.
    #[tokio::test(flavor = "current_thread")]
    async fn corrects_rows_and_kept_day_from_backfilled_marks() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("r.db");
        let s = Store::new(&p);
        let t1 = DS + 3_600_000;
        // live-marked: +10 bps on 100 notional = +0.1 for the whole day
        s.put(Row::Fill(Box::new(fill("ok", DS + 60_000, "AAAUSDT", Side::Buy, 10.0, 10.0, Some(10.0)))));
        // missed: bought 1 at 10; klines have 11 at t + 60 s
        s.put(Row::Fill(Box::new(fill("miss", t1, "AAAUSDT", Side::Buy, 10.0, 1.0, None))));
        // no klines at all for BBB: left out
        s.put(Row::Fill(Box::new(fill("none", t1, "BBBUSDT", Side::Sell, 5.0, 2.0, None))));
        // tomorrow's fill: not read
        s.put(Row::Fill(Box::new(fill("next", DS + DAY + 1, "AAAUSDT", Side::Buy, 10.0, 1.0, None))));
        // old rows: before the missed fill 0.1; after it 0.1 + (M(t) − 10) with M = 12 from 2 h on
        let t_late = DS + 2 * 3_600_000;
        for (t, mm) in [(DS, 0.0), (DS + 600_000, 0.1), (t_late, 0.1 + 2.0), (DS + DAY - 5_000, 0.1 + 2.0)] {
            s.put(desk_row(t, mm));
        }
        s.put(desk_row(DS + DAY + 5_000, 0.0));   // tomorrow's row: not touched
        s.put(Row::Kv(format!("dayreal:{}", crate::pnl::utc_day(DS)),
                      r#"{"pnl_day":5.0,"trading":3.0,"mm":2.1,"inventory":0.9,"rebates":1.0,"other":0.5}"#.into()));
        s.start().unwrap();
        s.close();

        let mut src = Mock::default();
        // 1 s bars around t1 + 60 s: 11
        src.secs.insert("spot:AAAUSDT".into(), (0..1000).map(|k| (t1 + k * 1000, 11.0, 11.0)).collect());
        // 1 min bars: 12 flat from 2 h on (the mid the old rows used)
        src.mins.insert("spot:AAAUSDT".into(), (0..1440).map(|k| (DS + k * 60_000, 12.0, 12.0)).collect());

        let mut c = crate::store::open(&p).unwrap();
        let m = market();
        let now = DS + 2 * DAY;
        let dry = recompute_day(&mut c, &m, &src, DS, 60, now, true).await.unwrap();
        // new: 0.1 + (11 − 10) = 1.1, BBB out (it was at 0: no mid)
        assert_relative_eq!(dry.new_mm.unwrap(), 1.1, epsilon = 1e-9);
        assert_eq!(dry.old_mm, Some(2.1));
        assert_relative_eq!(dry.new_kept.unwrap(), 1.1, epsilon = 1e-9);
        assert_eq!((dry.unmarked, dry.backfilled, dry.unpriceable), (2, 1, 1));
        assert_relative_eq!(dry.backfilled_notional, 10.0);
        assert_relative_eq!(dry.unpriceable_notional, 10.0);
        assert_eq!(dry.rows, 2);
        // a dry run writes nothing
        let mm: f64 = c.query_row("SELECT mm FROM equity WHERE t = ?", [t_late], |r| r.get(0)).unwrap();
        assert_eq!(mm, 2.1);
        let bf: i64 = c.query_row("SELECT bf FROM fills WHERE id = 'miss'", [], |r| r.get(0)).unwrap();
        assert_eq!(bf, 0);

        let m = market();
        let rep = recompute_day(&mut c, &m, &src, DS, 60, now, false).await.unwrap();
        assert_eq!(rep.new_mm, dry.new_mm);
        let rows: Vec<(i64, f64)> = c
            .prepare("SELECT t, mm FROM equity WHERE account = '*' ORDER BY t").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
        assert_eq!(rows[0], (DS, 0.0));
        assert_eq!(rows[1], (DS + 600_000, 0.1));
        assert_relative_eq!(rows[2].1, 1.1, epsilon = 1e-9);
        assert_relative_eq!(rows[3].1, 1.1, epsilon = 1e-9);
        assert_eq!(rows[4], (DS + DAY + 5_000, 0.0));
        let v: String = c.query_row("SELECT v FROM kv WHERE k LIKE 'dayreal:%'", [], |r| r.get(0)).unwrap();
        let j: serde_json::Value = serde_json::from_str(&v).unwrap();
        assert_relative_eq!(j["mm"].as_f64().unwrap(), 1.1, epsilon = 1e-9);
        assert_relative_eq!(j["inventory"].as_f64().unwrap(), 3.0 - 1.1, epsilon = 1e-9);
        assert_eq!((j["pnl_day"].as_f64(), j["rebates"].as_f64(), j["other"].as_f64()), (Some(5.0), Some(1.0), Some(0.5)));
        // the marks are stored with the fills, flagged
        let l = Store::new(&p).load(0, 0).unwrap();
        let miss = l.fills.iter().find(|f| f.id == "miss").unwrap();
        assert_relative_eq!(miss.mk_raw.0[2].unwrap(), 1000.0, epsilon = 1e-9);
        assert_eq!(miss.bf, 0b0100);
        let none = l.fills.iter().find(|f| f.id == "none").unwrap();
        assert!(none.mk_raw.0[2].is_none() && none.unpriceable(2));
        assert!(l.fills.iter().find(|f| f.id == "next").unwrap().mk_raw.0[2].is_none());

        // run again: nothing left to do, nothing changes
        let m = market();
        src.log.borrow_mut().clear();
        let again = recompute_day(&mut c, &m, &src, DS, 60, now, false).await.unwrap();
        assert_eq!((again.unmarked, again.rows, again.marks, again.fills_written), (0, 0, 0, 0));
        assert_relative_eq!(again.new_mm.unwrap(), 1.1, epsilon = 1e-9);
    }

    #[test]
    fn day_starts() {
        assert_eq!(day_start_of("1970-01-02", 0).unwrap(), DAY);
        assert_eq!(day_start_of("1970-01-02", 60).unwrap(), DAY + 3_600_000);
        assert!(day_start_of("1970-13-02", 0).is_err());
    }
}
