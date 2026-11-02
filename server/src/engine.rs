//! Engine metrics: Prometheus text -> protocol::Engine, by what the engine's metrics are called: FastMM's own names
//! (`fastmm-top --metrics`), or any exporter's as `[engines.metrics]` names them, leaving out what they do not say.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use crate::clock::now_s;
use crate::config::{EngineCfg, EngineFormat, EngineMetrics};
use crate::feeds::{Feed, FeedKind, FeedRef};
use crate::protocol as P;

pub fn state_name(v: i64) -> &'static str {
    match v {
        0 => "starting",
        1 => "running",
        2 => "stopping",
        3 => "stopped",
        _ => "unknown",
    }
}

pub fn channel_name(v: i64) -> String {
    match v {
        0 => "down".into(),
        1 => "connecting".into(),
        2 => "live".into(),
        3 => "stale".into(),
        _ => v.to_string(),
    }
}

pub const KILL_REASONS: [&str; 15] = ["None", "Requested", "MaxLoss", "TransportFull", "JournalOverflow", "AllVenuesKilled",
    "VenueFatal", "VenueHardStop", "OrderRingOverflow", "StrategyError", "FeedLost",
    "OrderIdsExhausted", "DeadMansSwitchLost", "GatewayMaxLoss", "GatewayOperator"];
pub const LATENCIES: [&str; 7] = ["decode", "book_apply", "strategy", "serialize", "send", "tick_to_trade", "wire_to_book"];

pub type Labels = HashMap<String, String>;
pub type Samples = HashMap<String, Vec<(Labels, f64)>>;

fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') => out.push('\n'),
                Some(c) => out.push(c),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn is_name_start(c: u8, colon: bool) -> bool {
    c.is_ascii_alphabetic() || c == b'_' || (colon && c == b':')
}

fn is_name(c: u8, colon: bool) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || (colon && c == b':')
}

/// `name="value"` pairs in a label set (Python: `re.findall` of `_label`).
fn labels(s: &str) -> Labels {
    let b = s.as_bytes();
    let mut out = Labels::new();
    let mut i = 0;
    while i < b.len() {
        if is_name_start(b[i], false) {
            let mut j = i + 1;
            while j < b.len() && is_name(b[j], false) {
                j += 1;
            }
            if j + 1 < b.len() && b[j] == b'=' && b[j + 1] == b'"' {
                let mut k = j + 2;
                let mut closed = None;
                while k < b.len() {
                    match b[k] {
                        b'\\' if k + 1 < b.len() => k += 2,
                        b'"' => {
                            closed = Some(k);
                            break;
                        }
                        _ => k += 1,
                    }
                }
                if let Some(k) = closed {
                    out.insert(s[i..j].to_string(), unescape(&s[j + 2..k]));
                    i = k + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    out
}

/// One sample line: (name, label text, value text).
fn split_line(line: &str) -> Option<(&str, &str, &str)> {
    let b = line.as_bytes();
    if b.is_empty() || !is_name_start(b[0], true) {
        return None;
    }
    let mut i = 1;
    while i < b.len() && is_name(b[i], true) {
        i += 1;
    }
    let name = &line[..i];
    let mut lbl = "";
    if i < b.len() && b[i] == b'{' {
        let start = i + 1;
        let mut k = start;
        let mut quoted = false;
        loop {
            if k >= b.len() {
                return None;
            }
            match b[k] {
                b'\\' if quoted => k += 1,
                b'"' => quoted = !quoted,
                b'}' if !quoted => break,
                _ => {}
            }
            k += 1;
        }
        lbl = &line[start..k];
        i = k + 1;
    }
    let rest = &line[i..];
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() {
        return None;   // `\s+` between name and value
    }
    let v = trimmed.split_whitespace().next()?;
    Some((name, lbl, v))
}

pub fn parse(text: &str) -> Samples {
    let mut out = Samples::new();
    for line in text.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, lbl, v)) = split_line(line) else { continue };
        let Ok(v) = v.parse::<f64>() else { continue };
        out.entry(name.to_string()).or_default().push((labels(lbl), v));
    }
    out
}

fn one(s: &Samples, name: &str, default: f64) -> f64 {
    s.get(name).and_then(|v| v.first()).map_or(default, |x| x.1)
}

fn round_to(x: f64, places: i32) -> f64 {
    let p = 10f64.powi(places);
    (x * p).round() / p
}

fn lb<'a>(l: &'a Labels, k: &str) -> &'a str {
    l.get(k).map_or("", String::as_str)
}

fn samples<'a>(s: &'a Samples, name: &str) -> &'a [(Labels, f64)] {
    s.get(name).map_or(&[], Vec::as_slice)
}

#[derive(Default)]
struct VenueRow {
    md: Option<String>,
    user: Option<String>,
    order: Option<String>,
    reconnects: i64,
    cooldowns: i64,
    rest_errors: i64,
}

/// A counter summed over its labels.
fn total(s: &Samples, name: &str) -> Option<i64> {
    s.get(name).map(|v| v.iter().map(|x| x.1).sum::<f64>() as i64)
}

/// A histogram's quantile: linear within its bucket, as Prometheus's `histogram_quantile` has it, the buckets summed over
/// any other label. None with no observation yet.
fn bucket_quantile(rows: &[(Labels, f64)], q: f64) -> Option<f64> {
    let mut les: Vec<(f64, f64)> = vec![];
    for (l, v) in rows {
        let Ok(le) = lb(l, "le").parse::<f64>() else { continue };
        match les.iter_mut().find(|x| x.0 == le) {
            Some(x) => x.1 += v,
            None => les.push((le, *v)),
        }
    }
    les.sort_by(|a, b| a.0.total_cmp(&b.0));
    let n = les.last()?.1;
    if n <= 0.0 {
        return None;
    }
    let rank = q * n;
    let i = les.iter().position(|x| x.1 >= rank)?;
    let (hi, c) = les[i];
    let (lo, c0) = if i == 0 { (0.0, 0.0) } else { les[i - 1] };
    if !hi.is_finite() {
        return Some(lo);   // past the last bucket with a bound: its bound is all that is known
    }
    Some(if c > c0 { lo + (hi - lo) * (rank - c0) / (c - c0) } else { hi })
}

/// A latency row per configured metric: a summary's quantiles or a histogram's buckets; a summary with other labels, a row
/// per label value.
fn latency_rows(s: &Samples, m: &EngineMetrics) -> Vec<P::Latency> {
    let scale = m.latency_scale().unwrap_or(1e6);
    let mut out = vec![];
    for name in &m.latency {
        let row = name.trim_end_matches("_seconds").trim_end_matches("_microseconds").trim_end_matches("_milliseconds");
        let buckets = samples(s, &format!("{name}_bucket"));
        if !buckets.is_empty() {
            out.push(P::Latency { name: row.to_string(), p50_us: bucket_quantile(buckets, 0.5).map(|x| x * scale), p99_us: bucket_quantile(buckets, 0.99).map(|x| x * scale) });
            continue;
        }
        let mut rows: Vec<(String, P::Latency)> = vec![];
        for (l, v) in samples(s, name) {
            let mut others: Vec<(&String, &String)> = l.iter().filter(|(k, _)| *k != "quantile").collect();
            others.sort();
            let id = others.iter().map(|x| x.1.as_str()).collect::<Vec<_>>().join(" ");
            let i = rows.iter().position(|r| r.0 == id).unwrap_or_else(|| {
                let n = if id.is_empty() { row.to_string() } else { format!("{row} {id}") };
                rows.push((id.clone(), P::Latency { name: n, p50_us: None, p99_us: None }));
                rows.len() - 1
            });
            match lb(l, "quantile") {
                "0.5" => rows[i].1.p50_us = Some(v * scale),
                "0.99" => rows[i].1.p99_us = Some(v * scale),
                _ => {}
            }
        }
        out.extend(rows.into_iter().map(|r| r.1));
    }
    out
}

/// An engine by the names its config gives: what they do not name is null, and the page has no place for it.
fn generic(cfg: &EngineCfg, m: &EngineMetrics, s: &Samples, scrape_age_s: f64) -> P::Engine {
    let up = m.up.as_ref().is_none_or(|n| s.get(n).and_then(|v| v.first()).is_some_and(|x| x.1 != 0.0));
    let named = |n: &Option<String>| n.as_ref().and_then(|n| total(s, n));
    let mut rejects: Vec<P::RejectCount> = m.rejects.iter().flat_map(|n| samples(s, n)).map(|(l, v)| {
        let mut labels: Vec<(&String, &String)> = l.iter().collect();
        labels.sort();
        let reason = labels.iter().map(|x| x.1.as_str()).collect::<Vec<_>>().join(" ");
        P::RejectCount { reason: if reason.is_empty() { "all".into() } else { reason }, count: *v as i64 }
    }).collect();
    rejects.sort_by_key(|r| -r.count);
    P::Engine {
        name: cfg.name.clone(),
        url: cfg.url.clone(),
        up,
        stale_s: round_to(scrape_age_s, 2),
        state: if up { "running" } else { "stopped" }.into(),
        orders: named(&m.orders),
        cancels: named(&m.cancels),
        fills: named(&m.fills),
        rejects,
        latency: latency_rows(s, m),
        ..Default::default()
    }
}

pub fn to_engine(cfg: &EngineCfg, s: Option<&Samples>, scrape_age_s: f64) -> P::Engine {
    let Some(s) = s.filter(|s| !s.is_empty()) else {
        let zero = (cfg.format == EngineFormat::Fastmm).then_some(0);
        let money = zero.map(f64::from);
        return P::Engine {
            name: cfg.name.clone(),
            url: cfg.url.clone(),
            up: false,
            stale_s: round_to(scrape_age_s, 1),
            state: "unreachable".into(),
            orders: zero.map(i64::from),
            cancels: zero.map(i64::from),
            fills: zero.map(i64::from),
            risk_rejects: zero.map(i64::from),
            venue_rejects: zero.map(i64::from),
            realized: money,
            unrealized: money,
            fees: money,
            kill: zero.map(|_| false),
            ..Default::default()
        };
    };
    if let EngineFormat::Generic(m) = &cfg.format {
        return generic(cfg, m, s, scrape_age_s);
    }
    let empty = Labels::new();
    let info = s.get("fastmm_info").and_then(|v| v.first()).map_or(&empty, |x| &x.0);
    let kr = one(s, "fastmm_kill_reason", 0.0) as i64;
    // interval -> quantile -> microseconds, in order of first appearance
    let mut lat: Vec<(String, HashMap<String, f64>)> = vec![];
    let mut put_lat = |name: String, q: &str, v: f64| {
        let i = match lat.iter().position(|(n, _)| *n == name) {
            Some(i) => i,
            None => {
                lat.push((name, HashMap::new()));
                lat.len() - 1
            }
        };
        lat[i].1.insert(q.to_string(), v * 1e6);
    };
    for (l, v) in samples(s, "fastmm_latency_quantile_seconds") {
        put_lat(lb(l, "interval").to_string(), lb(l, "quantile"), *v);
    }
    for (l, v) in samples(s, "fastmm_venue_tick_to_trade_quantile_seconds") {
        put_lat(format!("wire tick_to_trade {}", lb(l, "venue")), lb(l, "quantile"), *v);
    }
    let order = |n: &str| LATENCIES.iter().position(|x| *x == n).unwrap_or(99);
    lat.sort_by_key(|(n, _)| order(n));
    let latency = lat
        .into_iter()
        .map(|(n, q)| P::Latency { name: n, p50_us: q.get("0.5").copied(), p99_us: q.get("0.99").copied() })
        .collect();
    let mut venues: Vec<(String, VenueRow)> = vec![];
    let mut venue = |name: &str| -> usize {
        match venues.iter().position(|(n, _)| n == name) {
            Some(i) => i,
            None => {
                venues.push((name.to_string(), VenueRow::default()));
                venues.len() - 1
            }
        }
    };
    let mut rows: Vec<(usize, &Labels, f64)> = vec![];
    for (l, v) in samples(s, "fastmm_venue_channel_state") {
        rows.push((venue(lb(l, "venue")), l, *v));
    }
    let mut counts: Vec<(usize, usize, i64)> = vec![];
    for (fi, metric) in ["fastmm_venue_reconnects_total", "fastmm_venue_rate_limit_cooldowns_total", "fastmm_venue_rest_errors_total"]
        .iter()
        .enumerate()
    {
        for (l, v) in samples(s, metric) {
            counts.push((venue(lb(l, "venue")), fi, *v as i64));
        }
    }
    for (i, l, v) in rows {
        let state = channel_name(v as i64);
        let r = &mut venues[i].1;
        match lb(l, "channel") {
            "md" => r.md = Some(state),
            "user" => r.user = Some(state),
            "order" => r.order = Some(state),
            _ => {}
        }
    }
    for (i, fi, n) in counts {
        let r = &mut venues[i].1;
        match fi {
            0 => r.reconnects = n,
            1 => r.cooldowns = n,
            _ => r.rest_errors = n,
        }
    }
    let mut rejects: Vec<P::RejectCount> = samples(s, "fastmm_rejects_by_reason_total")
        .iter()
        .map(|(l, v)| P::RejectCount {
            reason: format!("{} {}", lb(l, "kind"), lb(l, "reason")).trim().to_string(),
            count: *v as i64,
        })
        .collect();
    rejects.sort_by_key(|r| -r.count);
    let max_loss = one(s, "fastmm_max_loss", one(s, "fastmm_account_max_loss", 0.0));
    let kill_reason = (kr != 0).then(|| {
        let n = KILL_REASONS.len() as i64;
        if kr < n && kr >= -n {
            KILL_REASONS[kr.rem_euclid(n) as usize].to_string()
        } else {
            kr.to_string()
        }
    });
    let strategy = match info.get("strategy").filter(|v| !v.is_empty()) {
        Some(v) => v.clone(),
        None if info.contains_key("gateway") => "gateway".into(),
        None => String::new(),
    };
    let down = || "down".to_string();
    P::Engine {
        name: cfg.name.clone(),
        url: cfg.url.clone(),
        up: one(s, "fastmm_up", 0.0) == 1.0,
        stale_s: round_to(one(s, "fastmm_status_age_seconds", scrape_age_s), 2),
        state: state_name(one(s, "fastmm_state", -1.0) as i64).into(),
        strategy,
        orders: Some(one(s, "fastmm_orders_sent_total", 0.0) as i64),
        cancels: Some(one(s, "fastmm_cancels_sent_total", 0.0) as i64),
        fills: Some(one(s, "fastmm_fills_total", 0.0) as i64),
        risk_rejects: Some(one(s, "fastmm_risk_rejects_total", 0.0) as i64),
        venue_rejects: Some(one(s, "fastmm_venue_rejects_total", 0.0) as i64),
        rejects,
        realized: Some(one(s, "fastmm_realized_pnl", 0.0)),
        unrealized: Some(one(s, "fastmm_unrealized_pnl", 0.0)),
        fees: Some(one(s, "fastmm_fees", 0.0)),
        max_loss: (max_loss != 0.0).then_some(max_loss),
        kill: Some(one(s, "fastmm_kill_active", 0.0) == 1.0),
        kill_reason,
        latency,
        venues: venues
            .into_iter()
            .map(|(n, v)| P::EngineVenue {
                name: n,
                md: v.md.unwrap_or_else(down),
                user: v.user.unwrap_or_else(down),
                order: v.order.unwrap_or_else(down),
                reconnects: v.reconnects,
                cooldowns: v.cooldowns,
                rest_errors: v.rest_errors,
            })
            .collect(),
    }
}

/// The metrics a config names that a scrape does not have: the page shows them as "--" and this says why.
fn missing_names<'a>(cfg: &'a EngineCfg, s: &Samples) -> Vec<&'a str> {
    let EngineFormat::Generic(m) = &cfg.format else { return vec![] };
    m.names().into_iter().filter(|n| !s.contains_key(*n) && !s.contains_key(&format!("{n}_bucket"))).collect()
}

pub struct EngineScraper {
    pub cfg: EngineCfg,
    pub feed: FeedRef,
    pub samples: Option<Samples>,
    pub ok_at: f64,
    pub started: f64,
}

pub type EngineScraperRef = Rc<RefCell<EngineScraper>>;

impl EngineScraper {
    pub fn new(cfg: EngineCfg) -> Self {
        let feed = Feed::shared(format!("engine {}", cfg.name), FeedKind::Engine, cfg.url.clone());
        EngineScraper { cfg, feed, samples: None, ok_at: 0.0, started: now_s() }
    }

    pub fn engine(&self) -> P::Engine {
        let age = now_s() - if self.ok_at != 0.0 { self.ok_at } else { self.started };
        to_engine(&self.cfg, if age < 10.0 { self.samples.as_ref() } else { None }, age)
    }
}

async fn scrape(http: &reqwest::Client, url: &str) -> anyhow::Result<String> {
    let r = http.get(url).timeout(Duration::from_secs(3)).send().await?;
    let status = r.status();
    let text = r.text().await?;
    if status.as_u16() != 200 {
        anyhow::bail!("HTTP {}", status.as_u16());
    }
    Ok(text)
}

/// Scrape every 2 s forever (cancel by aborting the task).
pub async fn run(this: EngineScraperRef, http: reqwest::Client) {
    let (url, feed) = {
        let t = this.borrow();
        (t.cfg.url.clone(), t.feed.clone())
    };
    let mut said = String::new();
    loop {
        match scrape(&http, &url).await {
            Ok(text) => {
                let s = parse(&text);
                let missing = missing_names(&this.borrow().cfg, &s).join(", ");
                if missing != said {
                    if !missing.is_empty() {
                        tracing::warn!("engine {}: {url} has no {missing}", this.borrow().cfg.name);
                    }
                    said = missing;
                }
                {
                    let mut t = this.borrow_mut();
                    t.samples = Some(s);
                    t.ok_at = now_s();
                }
                let mut f = feed.borrow_mut();
                f.hit(1);
                f.set_up(true, Some(&url));
            }
            Err(e) => {
                let d: String = format!("{url}: {e:#}").chars().take(200).collect();
                feed.borrow_mut().set_up(false, Some(&d));
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# HELP fastmm_up 1 while a status snapshot can be read
# TYPE fastmm_up gauge
fastmm_up 1
# TYPE fastmm_info gauge
fastmm_info{engine="eng-1",strategy="mm \"x\"",pid="4242",session_id="7"} 1
fastmm_state 1
fastmm_status_age_seconds 0.21
fastmm_kill_active 0
fastmm_kill_reason 0
fastmm_realized_pnl 12.5
fastmm_unrealized_pnl -3.25
fastmm_fees 0.5
fastmm_max_loss 200
fastmm_orders_sent_total 1000
fastmm_cancels_sent_total 900
fastmm_fills_total 42
fastmm_risk_rejects_total 3
fastmm_venue_rejects_total 7
fastmm_rejects_by_reason_total{kind="risk",reason="MaxPosition"} 3
fastmm_rejects_by_reason_total{kind="venue",reason="RateLimited"} 7
fastmm_latency_quantile_seconds{interval="decode",quantile="0.5"} 1.5e-06
fastmm_latency_quantile_seconds{interval="decode",quantile="0.99"} 4e-06
fastmm_latency_quantile_seconds{interval="decode",quantile="0.999"} 9e-06
fastmm_latency_quantile_seconds{interval="tick_to_trade",quantile="0.5"} 2.5e-05
fastmm_latency_quantile_seconds{interval="tick_to_trade",quantile="0.99"} 8e-05
fastmm_venue_channel_state{venue="binance",channel="md"} 2
fastmm_venue_channel_state{venue="binance",channel="user"} 2
fastmm_venue_channel_state{venue="binance",channel="order"} 3
fastmm_venue_reconnects_total{venue="binance"} 2
fastmm_venue_rest_errors_total{venue="binance"} 1
fastmm_venue_rate_limit_cooldowns_total{venue="binance"} 4
"#;

    fn cfg(url: &str) -> EngineCfg {
        EngineCfg { name: "eng".into(), url: url.into(), format: EngineFormat::Fastmm }
    }

    #[test]
    fn parse_labels_and_escapes() {
        let s = parse(SAMPLE);
        let (labels, v) = &s["fastmm_info"][0];
        assert!(labels["strategy"] == "mm \"x\"" && *v == 1.0);
        assert_eq!(s["fastmm_latency_quantile_seconds"].len(), 5);
    }

    #[test]
    fn to_engine_sample() {
        let s = parse(SAMPLE);
        let e = to_engine(&cfg("http://x/metrics"), Some(&s), 0.0);
        assert!(e.up && e.state == "running" && e.strategy == "mm \"x\"");
        assert_eq!((e.orders, e.cancels, e.fills, e.risk_rejects, e.venue_rejects), (Some(1000), Some(900), Some(42), Some(3), Some(7)));
        assert!(e.realized == Some(12.5) && e.unrealized == Some(-3.25) && e.max_loss == Some(200.0) && e.kill == Some(false) && e.kill_reason.is_none());
        assert!(e.rejects[0].reason == "venue RateLimited" && e.rejects[0].count == 7);
        assert!(e.latency[0].name == "decode" && (e.latency[0].p50_us.unwrap() - 1.5).abs() < 1e-9);
        assert!(e.latency[1].name == "tick_to_trade" && (e.latency[1].p99_us.unwrap() - 80.0).abs() < 1e-9);
        let v = &e.venues[0];
        assert_eq!(
            (v.name.as_str(), v.md.as_str(), v.user.as_str(), v.order.as_str(), v.reconnects, v.cooldowns, v.rest_errors),
            ("binance", "live", "live", "stale", 2, 4, 1)
        );
    }

    #[test]
    fn kill_and_unreachable() {
        let s = parse("fastmm_up 1\nfastmm_state 3\nfastmm_kill_active 1\nfastmm_kill_reason 2\n");
        let e = to_engine(&cfg("u"), Some(&s), 0.0);
        assert!(e.kill == Some(true) && e.kill_reason.as_deref() == Some("MaxLoss") && e.state == "stopped");
        let e = to_engine(&cfg("u"), None, 12.0);
        assert!(!e.up && e.state == "unreachable" && e.stale_s == 12.0);
        // an engine that went away reads 0 on the wire, as it always has
        assert_eq!((e.orders, e.realized, e.kill), (Some(0), Some(0.0), Some(false)));
    }

    fn generic_cfg(m: EngineMetrics) -> EngineCfg {
        EngineCfg { name: "gen".into(), url: "u".into(), format: EngineFormat::Generic(m) }
    }

    const EXPORTER: &str = r#"# TYPE quoter_up gauge
quoter_up 1
quoter_orders_total{venue="a",side="buy"} 10
quoter_orders_total{venue="a",side="sell"} 5
quoter_orders_total{venue="b",side="buy"} 1
quoter_fills_total 4
quoter_rejects_total{reason="post_only"} 2
quoter_rejects_total{reason="rate"} 7
quoter_tick_seconds{step="decode",quantile="0.5"} 2e-06
quoter_tick_seconds{step="decode",quantile="0.99"} 5e-06
quoter_tick_seconds{step="send",quantile="0.5"} 1e-05
quoter_rtt_seconds_bucket{le="0.001"} 50
quoter_rtt_seconds_bucket{le="0.01"} 100
quoter_rtt_seconds_bucket{le="+Inf"} 100
quoter_rtt_seconds_count 100
"#;

    #[test]
    fn any_exporter_by_the_names_it_is_given() {
        let s = parse(EXPORTER);
        let m = EngineMetrics {
            up: Some("quoter_up".into()),
            orders: Some("quoter_orders_total".into()),
            fills: Some("quoter_fills_total".into()),
            rejects: Some("quoter_rejects_total".into()),
            latency: vec!["quoter_tick_seconds".into(), "quoter_rtt_seconds".into()],
            ..Default::default()
        };
        let e = to_engine(&generic_cfg(m.clone()), Some(&s), 0.5);
        assert!(e.up && e.state == "running" && e.stale_s == 0.5);
        // summed over their labels; rows by reason; what is not named is null, FastMM's own with it
        assert_eq!((e.orders, e.fills, e.cancels), (Some(16), Some(4), None));
        assert_eq!((e.risk_rejects, e.venue_rejects, e.realized, e.unrealized, e.fees, e.max_loss, e.kill), (None, None, None, None, None, None, None));
        assert!(e.venues.is_empty() && e.strategy.is_empty());
        assert_eq!((e.rejects[0].reason.as_str(), e.rejects[0].count, e.rejects[1].reason.as_str()), ("rate", 7, "post_only"));
        let lat = |n: &str| e.latency.iter().find(|l| l.name == n).unwrap().clone();
        assert_eq!((lat("quoter_tick decode").p50_us, lat("quoter_tick decode").p99_us), (Some(2.0), Some(5.0)));
        assert_eq!(lat("quoter_tick send").p99_us, None);
        // a histogram: the 50th of 100 at the top of the first bucket, the 99th nearly through the second
        assert!((lat("quoter_rtt").p50_us.unwrap() - 1000.0).abs() < 1e-6);
        assert!((lat("quoter_rtt").p99_us.unwrap() - 9820.0).abs() < 1e-6);
        // on the wire a null, not a 0
        let v = serde_json::to_value(&e).unwrap();
        assert!(v["cancels"].is_null() && v["realized"].is_null() && v["kill"].is_null() && v["orders"] == 16);
        assert!(missing_names(&generic_cfg(m), &s).is_empty());
    }

    #[test]
    fn up_goes_by_its_metric_or_by_the_scrape_and_a_missing_name_is_said() {
        let named = EngineMetrics { up: Some("x_up".into()), orders: Some("x_orders".into()), ..Default::default() };
        let s = parse("x_up 0\n");
        let e = to_engine(&generic_cfg(named.clone()), Some(&s), 0.0);
        assert!(!e.up && e.state == "stopped" && e.orders.is_none());
        assert_eq!(missing_names(&generic_cfg(named.clone()), &s), ["x_orders"]);
        // no such metric: not known to be up
        assert!(!to_engine(&generic_cfg(named), Some(&parse("other 1\n")), 0.0).up);
        // none named: its metrics answering is all there is
        let scrape_only = EngineMetrics { orders: Some("x_orders".into()), ..Default::default() };
        assert!(to_engine(&generic_cfg(scrape_only.clone()), Some(&parse("x_orders 3\n")), 0.0).up);
        // unreachable: nothing, not zeros
        let e = to_engine(&generic_cfg(scrape_only), None, 9.0);
        assert!(!e.up && e.state == "unreachable" && e.orders.is_none() && e.kill.is_none());
    }

    #[test]
    fn a_histogram_with_nothing_in_it_has_no_quantile() {
        let s = parse("x_bucket{le=\"1\"} 0\nx_bucket{le=\"+Inf\"} 0\n");
        assert_eq!(bucket_quantile(samples(&s, "x_bucket"), 0.5), None);
        let s = parse("x_bucket{le=\"1\"} 1\nx_bucket{le=\"+Inf\"} 100\n");
        assert_eq!(bucket_quantile(samples(&s, "x_bucket"), 0.99), Some(1.0));
    }
}
