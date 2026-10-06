//! Alert rules and their active set.
use std::collections::{HashMap, VecDeque};

/// A public market-data connection silent this long is reported (the watchdog reconnects it at 60 s).
const SILENT_MS: i64 = 45_000;

use chrono::{Local, NaiveDate, TimeZone};

use crate::app::{Desk, View};
use crate::protocol::{self as P, FeedKind, Level, Venue};
use crate::store::AlertRow;

pub const MIN: i64 = 60_000;
const CLEARED_MAX: usize = 100;

fn level_rank(l: Level) -> i32 {
    match l {
        Level::Crit => 0,
        Level::Warn => 1,
        Level::Info => 2,
    }
}

fn names(xs: &[String]) -> String {
    let n = 6;
    let mut s = xs.iter().take(n).cloned().collect::<Vec<_>>().join(", ");
    if xs.len() > n {
        s += &format!(" +{}", xs.len() - n);
    }
    s
}

/// Python's `format(x, ",.{dec}f")` (`plus`: `"+,.{dec}f"`).
pub fn fmt_num(x: f64, dec: usize, plus: bool) -> String {
    let s = format!("{x:.dec$}");
    let (sign, digits) = match s.strip_prefix('-') {
        Some(d) => ("-", d),
        None => (if plus { "+" } else { "" }, s.as_str()),
    };
    let (int, frac) = digits.split_once('.').map_or((digits, None), |(i, f)| (i, Some(f)));
    let mut out = String::with_capacity(s.len() + 8);
    out.push_str(sign);
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if let Some(f) = frac {
        out.push('.');
        out.push_str(f);
    }
    out
}

/// Python's `format(x, ".0%")`.
fn pct(x: f64) -> String {
    format!("{:.0}%", x * 100.0)
}

/// Persists an alert when it opens, changes or clears.
pub type Persist = Box<dyn Fn(&P::Alert)>;

pub struct Alerts {
    pub items: Vec<P::Alert>,   // active, in insertion order (Python dict)
    pub cleared: VecDeque<P::Alert>,
    pub cond_since: HashMap<String, i64>,
    pub engine_hist: HashMap<String, VecDeque<(i64, i64, i64)>>,
    pub persist: Persist,
}

impl Default for Alerts {
    fn default() -> Self {
        Self::new(Box::new(|_| {}))
    }
}

type Cond = (String, String, Level, String);

impl Alerts {
    pub fn new(persist: Persist) -> Self {
        Alerts { items: vec![], cleared: VecDeque::new(), cond_since: HashMap::new(), engine_hist: HashMap::new(), persist }
    }

    pub fn load(&mut self, rows: &[AlertRow]) {
        for r in rows {
            let a = P::Alert {
                id: r.id.clone(),
                rule: r.rule.clone(),
                level: r.level.parse().unwrap_or(Level::Warn),
                text: r.text.clone(),
                since: r.since,
                active: r.active,
            };
            if a.active {
                match self.items.iter_mut().find(|x| x.id == a.id) {
                    Some(x) => *x = a,
                    None => self.items.push(a),
                }
            } else {
                self.cleared.push_front(a);
                self.cleared.truncate(CLEARED_MAX);
            }
        }
    }

    pub fn held(&mut self, k: &str, cond: bool, now: i64, ms: i64) -> bool {
        if !cond {
            self.cond_since.remove(k);
            return false;
        }
        now - *self.cond_since.entry(k.to_string()).or_insert(now) >= ms
    }

    pub fn apply(&mut self, conds: Vec<Cond>, now: i64) {
        let mut seen = std::collections::HashSet::new();
        for (id, rule, level, text) in conds {
            seen.insert(id.clone());
            match self.items.iter_mut().find(|a| a.id == id) {
                None => {
                    self.cleared.retain(|c| c.id != id);
                    let a = P::Alert { id, rule, level, text, since: now, active: true };
                    (self.persist)(&a);
                    self.items.push(a);
                }
                Some(a) => {
                    if a.text != text || a.level != level {
                        (a.text, a.level) = (text, level);
                        (self.persist)(a);
                    }
                }
            }
        }
        let (keep, gone): (Vec<_>, Vec<_>) = std::mem::take(&mut self.items).into_iter().partition(|a| seen.contains(&a.id));
        self.items = keep;
        for mut a in gone {
            a.active = false;
            (self.persist)(&a);
            self.cleared.push_front(a);
            self.cleared.truncate(CLEARED_MAX);
        }
    }

    pub fn list(&self) -> Vec<P::Alert> {
        let mut active = self.items.clone();
        active.sort_by_key(|a| (level_rank(a.level), -a.since));
        active.extend(self.cleared.iter().take(50).cloned());
        active
    }

    pub fn evaluate(&mut self, desk: &Desk, v: &View, now: i64) {
        let cfg = &desk.cfg;
        let ac = &cfg.alerts;
        let mut out: Vec<Cond> = vec![];
        let mut add = |rule: &str, k: &str, level: Level, text: String| {
            let id = if k.is_empty() { rule.to_string() } else { format!("{rule}:{k}") };
            if !out.iter().any(|c| c.0 == id) {
                out.push((id, rule.to_string(), level, text));
            }
        };

        for f in desk.all_feeds() {
            let f = f.borrow();
            if f.kind == FeedKind::Engine || f.up {
                continue;
            }
            let Some(ds) = f.down_since else { continue };
            if now - ds > 10_000 {
                if ["no API key", "no secret", "bad Ed25519"].iter().any(|p| f.detail.starts_with(p)) {
                    add("stream_down", &f.detail, Level::Warn, format!("not connected: {}", f.detail));
                } else {
                    add("stream_down", &f.name, if f.kind == FeedKind::User { Level::Crit } else { Level::Warn },
                        format!("{} down {}s: {}", f.name, (now - ds).div_euclid(1000), f.detail));
                }
            }
        }

        if v.summary.session.open {
            // a public connection with nothing at all: the watchdog reconnects it, this says it is still silent
            for f in desk.all_feeds() {
                let f = f.borrow();
                if f.kind != FeedKind::Public || !f.up {
                    continue;
                }
                if let Some(last) = f.last && now - last > SILENT_MS {
                    add("stream_silent", &f.name, Level::Warn, format!("{} no data for {}s", f.name, (now - last).div_euclid(1000)));
                }
            }
            let stale_ms = ac.stale_quote_s * 1000.0;
            let tracked = desk.tracked.borrow();
            let m = desk.market.borrow();
            let stale: Vec<String> = m
                .insts
                .iter()
                .filter(|i| tracked.contains(&i.key) && (now - i.recv.unwrap_or(i.created)) as f64 > stale_ms)
                .map(|i| i.symbol.clone() + if i.venue == Venue::Spot { "" } else { " (usdm)" })
                .collect();
            if !stale.is_empty() {
                add("stale_quote", "", Level::Warn, format!("no quote > {}s: {}", ac.stale_quote_s, names(&stale)));
            }
        }

        for a in &v.accounts {
            for (name, n, lim) in [("orders_10s", a.orders_10s, a.orders_10s_limit), ("orders_1d", a.orders_1d, a.orders_1d_limit)] {
                if lim != 0 && n as f64 > 0.8 * lim as f64 {
                    add(name, &a.id, Level::Warn, format!("{} {n}/{lim} orders ({})", a.id, pct(n as f64 / lim as f64)));
                }
            }
            if a.fees.iter().any(|f| f.changed) {
                let fees = a
                    .fees
                    .iter()
                    .filter(|f| f.changed)
                    .map(|f| format!("{} {:+.2}/{:+.2} bps", f.venue, f.maker_bps, f.taker_bps))
                    .collect::<Vec<_>>()
                    .join("; ");
                add("fee_change", &a.id, Level::Warn, format!("{} commission changed: {fees}", a.id));
            }
            let acct = desk.account(&a.id);
            let (spot_active, futures) = acct.map_or((false, false), |x| {
                let x = x.borrow();
                (x.traded.iter().any(|k| k.starts_with("spot:")), x.cfg.futures)
            });
            if self.held(&format!("quote_idle:{}", a.id), spot_active && a.quote_free < ac.quote_idle_usd, now,
                         (ac.quote_idle_s * 1000.0) as i64) {
                add("quote_idle", &a.id, Level::Warn, format!("{} free quote {} < {} for > {}s (utilization {})", a.id,
                    fmt_num(a.quote_free, 2, false), fmt_num(ac.quote_idle_usd, 0, false), ac.quote_idle_s, pct(a.utilization)));
            }
            if acct.is_some() && futures && !a.positions.is_empty() && a.fut_available < ac.futures_margin_min_usd {
                add("futures_margin", &a.id, Level::Warn, format!("{} futures available {} < {}", a.id,
                    fmt_num(a.fut_available, 0, false), fmt_num(ac.futures_margin_min_usd, 0, false)));
            }
        }

        let now_s = now as f64 / 1000.0;
        for g in desk.govs.iter() {
            let banned = g.banned();
            let last = g.last_ban.get();
            if banned || last.is_some_and(|(_, t)| now_s - t < 600.0) {
                let code = last.map_or_else(|| "None".to_string(), |(c, _)| c.to_string());
                let tail = if banned { format!(", paused {:.0}s", g.banned_until.get() - now_s) } else { " in the last 10 min".into() };
                add("rest_ban", &g.name, if banned { Level::Crit } else { Level::Warn }, format!("{} REST {code}{tail}", g.name));
            }
        }

        if let Some(exp) = cfg.fee_expiry.as_deref().filter(|e| !e.is_empty())
            && let Ok(d) = NaiveDate::parse_from_str(exp, "%Y-%m-%d")
            && let Some(today) = Local.timestamp_millis_opt(now).single().map(|t| t.date_naive())
        {
            let days = (d - today).num_days();
            if days <= 7 {
                add("fee_change", "expiry", Level::Warn, format!("fee arrangement ends {exp} ({days} d)"));
            }
        }

        let s = &v.summary;
        if s.pnl_day < -ac.day_drawdown_usd {
            add("drawdown", "day", Level::Crit, format!("day PnL {} below -{}", fmt_num(s.pnl_day, 0, true),
                fmt_num(ac.day_drawdown_usd, 0, false)));
        }
        if s.pnl_1h < -ac.drop_1h_usd {
            add("pnl_1h", "", Level::Warn, format!("last hour PnL {} below -{}", fmt_num(s.pnl_1h, 0, true),
                fmt_num(ac.drop_1h_usd, 0, false)));
        }
        let recent = desk.series.iter().filter(|p| p.t >= now - 15 * MIN).map(|p| p.pnl_day).fold(None, |m: Option<f64>, x| {
            Some(m.map_or(x, |m| m.max(x)))
        });
        if let Some(mx) = recent {
            let drop = mx - s.pnl_day;
            if drop > ac.drop_15m_usd {
                add("drawdown", "15m", Level::Warn, format!("PnL down {} in 15 min", fmt_num(drop, 0, false)));
            }
        }

        if s.inventory_value > ac.inventory_cap_usd {
            add("inventory", "total", Level::Warn, format!("inventory {} > cap {}", fmt_num(s.inventory_value, 0, false),
                fmt_num(ac.inventory_cap_usd, 0, false)));
        }
        // with markets_only, holdings outside the configured markets (stray coins) are not watched
        let watched = |r: &P::SymbolRow| !cfg.markets_only || cfg.markets.iter().any(|m| m.symbol == r.symbol && m.venue == r.venue);
        let mine: Vec<&P::SymbolRow> = v.symbols.iter().filter(|r| watched(r)).collect();
        let big: Vec<String> = mine
            .iter()
            .filter(|r| r.venue == Venue::Spot && r.inv_value.abs() > ac.asset_cap_usd)
            .map(|r| format!("{} {}", r.symbol, fmt_num(r.inv_value, 0, false)))
            .collect();
        if !big.is_empty() {
            add("inventory", "asset", Level::Warn, format!("over {}: {}", fmt_num(ac.asset_cap_usd, 0, false), names(&big)));
        }

        let e = &v.exposure;
        let over = matches!((e.gap, e.band), (Some(g), Some(b)) if g.abs() > b);
        if self.held("exposure_gap", over, now, MIN) {
            if let Some(p) = &e.paused {
                add("exposure_gap", "", Level::Info, format!("{p}: hedge {} left to close", fmt_num(e.hedge_notional, 0, true)));
            } else {
                add("exposure_gap", "", Level::Warn, format!("hedge {} vs target {} (gap {})", fmt_num(e.hedge_notional, 0, true),
                    fmt_num(e.target.unwrap_or(0.0), 0, true), fmt_num(e.gap.unwrap_or(0.0), 0, true)));
            }
        }

        let unexplained = s.other.filter(|o| o.abs() > ac.reconcile_usd);
        if self.held("reconcile", unexplained.is_some(), now, 5 * MIN)
            && let Some(o) = unexplained
        {
            add("reconcile", "", Level::Warn, format!("day PnL − (realized + old + float + hedge) = {} for > 5 min",
                fmt_num(o, 2, true)));
        }

        let agg = &v.agg;
        if agg.n_30m >= 30
            && let Some(mk) = agg.mk10_30m.value()
            && mk < ac.markout_floor_bps
        {
            add("markout", "", Level::Warn, format!("30-min 10 s markout {mk:+.2} bps over {} fills", agg.n_30m));
        }

        let dust: Vec<String> = mine.iter().filter(|r| r.dust).map(|r| r.symbol.clone()).collect();
        if !dust.is_empty() {
            add("dust", "", Level::Info, format!("below min notional: {}", names(&dust)));
        }

        for eng in &v.engines {
            let h = self.engine_hist.entry(eng.name.clone()).or_default();
            h.push_back((now, eng.venue_rejects, eng.venues.iter().map(|x| x.cooldowns).sum()));
            while h.front().is_some_and(|x| x.0 < now - 10 * MIN) {
                h.pop_front();
            }
            if !eng.up || eng.stale_s > 5.0 {
                add("engine", &eng.name, Level::Warn, format!("{} metrics {} ({:.0}s)", eng.name,
                    if eng.up { "stale" } else { "unreachable" }, eng.stale_s));
                continue;
            }
            if eng.kill {
                add("engine", &format!("{}:kill", eng.name), Level::Crit, format!("{} kill switch: {}", eng.name,
                    eng.kill_reason.as_deref().filter(|r| !r.is_empty()).unwrap_or("active")));
            }
            let slow: Vec<String> = eng
                .latency
                .iter()
                .filter_map(|x| x.p99_us.filter(|p| *p > ac.latency_p99_us).map(|p| format!("{} {}us", x.name, fmt_num(p, 0, false))))
                .collect();
            if !slow.is_empty() {
                add("engine_latency", &eng.name, Level::Warn, format!("{} p99 over {}us: {}", eng.name,
                    fmt_num(ac.latency_p99_us, 0, false), names(&slow)));
            }
            if eng.state != "running" {
                add("engine", &format!("{}:state", eng.name), Level::Warn, format!("{} state {}", eng.name, eng.state));
            }
            let minute_ago = *h.iter().find(|x| x.0 >= now - MIN).unwrap_or(&h[0]);
            if eng.venue_rejects - minute_ago.1 > 20 {
                add("engine", &format!("{}:rejects", eng.name), Level::Warn, format!("{} {} venue rejects in 1 min", eng.name,
                    eng.venue_rejects - minute_ago.1));
            }
            let (first, last) = (h[0].2, h[h.len() - 1].2);
            if last > first {
                add("rest_ban", &eng.name, Level::Warn, format!("{} rate-limit cooldowns +{} in 10 min", eng.name, last - first));
            }
        }

        self.apply(out, now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn number_formats() {
        assert_eq!(fmt_num(1234567.891, 2, false), "1,234,567.89");
        assert_eq!(fmt_num(-1234.4, 0, true), "-1,234");
        assert_eq!(fmt_num(12.0, 0, true), "+12");
        assert_eq!(fmt_num(999.6, 0, false), "1,000");
        assert_eq!(pct(0.854), "85%");
        assert_eq!(names(&(0..8).map(|i| i.to_string()).collect::<Vec<_>>()), "0, 1, 2, 3, 4, 5 +2");
    }

    #[test]
    fn apply_opens_updates_and_clears() {
        let log: Rc<RefCell<Vec<(String, bool)>>> = Rc::default();
        let l2 = log.clone();
        let mut a = Alerts::new(Box::new(move |x| l2.borrow_mut().push((x.text.clone(), x.active))));
        let c = |id: &str, lvl, t: &str| (id.to_string(), id.to_string(), lvl, t.to_string());
        a.apply(vec![c("x", Level::Warn, "a"), c("y", Level::Crit, "b")], 10);
        a.apply(vec![c("x", Level::Warn, "a2"), c("y", Level::Crit, "b")], 20);
        assert_eq!(a.list().iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["y", "x"]);
        a.apply(vec![c("y", Level::Crit, "b")], 30);
        let l = a.list();
        assert_eq!((l[0].id.as_str(), l[0].active, l[1].id.as_str(), l[1].active), ("y", true, "x", false));
        assert_eq!(*log.borrow(), [("a".into(), true), ("b".into(), true), ("a2".into(), true), ("a2".into(), false)]);
        a.apply(vec![c("x", Level::Info, "a3")], 40);   // back: leaves the cleared list
        assert_eq!(a.list().iter().filter(|x| x.id == "x").count(), 1);
        assert!(!a.held("k", true, 0, 100) && a.held("k", true, 100, 100) && !a.held("k", false, 200, 100));
    }
}
