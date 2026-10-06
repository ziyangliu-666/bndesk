//! Configured trading sessions and event marks, resolved to epoch ms in their time zones.
use anyhow::{Result, anyhow};
use chrono::{Datelike, Days, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone};
use chrono_tz::Tz;

use crate::config::{EventCfg, PauseCfg, SessionCfg, hhmm, try_hhmm};
use crate::protocol as P;

pub const DAY_MS: i64 = 86_400_000;
pub const DAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

fn day_index(s: &str) -> Result<u32> {
    let a: String = s.chars().take(3).collect();
    DAYS.iter().position(|d| *d == a).map(|i| i as u32).ok_or_else(|| anyhow!("bad day {s:?}"))
}

/// Weekday set as a bitmask (bit 0 = Monday).
pub fn parse_days(s: &str) -> Result<u8> {
    let s = s.trim().to_lowercase();
    if matches!(s.as_str(), "" | "*" | "all" | "daily") {
        return Ok(0x7f);
    }
    let mut out = 0u8;
    for part in s.split(',') {
        let (a, b) = part.trim().split_once('-').unwrap_or((part.trim(), ""));
        let mut i = day_index(a)?;
        let j = if b.is_empty() { i } else { day_index(b)? };
        loop {
            out |= 1 << i;
            if i == j {
                break;
            }
            i = (i + 1) % 7;
        }
    }
    Ok(out)
}

fn days(s: &str) -> u8 {
    parse_days(s).unwrap_or_else(|e| panic!("{e}"))
}

pub fn zone(tz: &str) -> Result<Tz> {
    tz.parse::<Tz>().map_err(|e| anyhow!("bad time zone {tz:?}: {e}"))
}

fn tz_of(tz: &str) -> Tz {
    zone(tz).unwrap_or_else(|e| panic!("{e}"))
}

pub fn day_start(now_ms: i64, start_min: i64) -> i64 {
    let midnight = now_ms - now_ms.rem_euclid(DAY_MS);
    let t = midnight + start_min * 60_000;
    if t <= now_ms { t } else { t - DAY_MS }
}

/// Local d at `minutes` in tz, as Python's zoneinfo resolves it (fold 0: the earlier of an ambiguous
/// time; a time in a gap takes the offset from before the gap).
fn at(d: NaiveDate, minutes: i64, tz: &Tz) -> i64 {
    let ndt = NaiveDateTime::new(d, NaiveTime::MIN) + chrono::Duration::minutes(minutes);
    match tz.from_local_datetime(&ndt) {
        LocalResult::Single(t) => t.timestamp_millis(),
        LocalResult::Ambiguous(a, b) => a.timestamp_millis().min(b.timestamp_millis()),
        LocalResult::None => {
            let before = tz.offset_from_utc_datetime(&(ndt - chrono::Duration::days(1))).fix();
            (ndt - chrono::Duration::seconds(before.local_minus_utc() as i64)).and_utc().timestamp_millis()
        }
    }
}

fn local_date(t_ms: i64, tz: &Tz) -> NaiveDate {
    tz.timestamp_millis_opt(t_ms).unwrap().date_naive()
}

fn dates(lo: i64, hi: i64, tz: &Tz) -> impl Iterator<Item = NaiveDate> {
    let d = local_date(lo, tz) - Days::new(1);
    let end = local_date(hi, tz) + Days::new(1);
    d.iter_days().take_while(move |x| *x <= end)
}

fn weekday(d: NaiveDate) -> u32 {
    d.weekday().num_days_from_monday()
}

pub fn windows(sessions: &[SessionCfg], lo: i64, hi: i64) -> Vec<(String, i64, i64)> {
    let mut out = vec![];
    for s in sessions {
        let (tz, days, a, b) = (tz_of(&s.tz), days(&s.days), hhmm(&s.start), hhmm(&s.end));
        for d in dates(lo, hi, &tz) {
            if days & (1 << weekday(d)) == 0 {
                continue;
            }
            let start = at(d, a, &tz);
            let end = at(if b <= a { d + Days::new(1) } else { d }, b, &tz);
            if end > lo && start < hi {
                out.push((s.name.clone(), start, end));
            }
        }
    }
    out.sort_by_key(|w| w.1);
    out
}

pub fn event_marks(events: &[EventCfg], lo: i64, hi: i64) -> Vec<(String, i64)> {
    let mut out = vec![];
    for e in events {
        let (tz, days, m) = (tz_of(&e.tz), days(&e.days), hhmm(&e.at));
        for d in dates(lo, hi, &tz) {
            if days & (1 << weekday(d)) != 0 {
                let t = at(d, m, &tz);
                if lo <= t && t < hi {
                    out.push((e.name.clone(), t));
                }
            }
        }
    }
    out.sort_by_key(|x| x.1);
    out
}

/// "fri 16:00" -> (weekday, minutes).
pub fn day_time(s: &str) -> Result<(u32, i64)> {
    let mut it = s.split_whitespace();
    let (Some(d), Some(t), None) = (it.next(), it.next(), it.next()) else {
        return Err(anyhow!("bad day and time {s:?}, want e.g. \"fri 16:00\""));
    };
    Ok((day_index(&d.trim().to_lowercase())?, try_hhmm(t)?))
}

/// The weekly pause window open at now, as (name, end ms), resolved in the window's zone.
pub fn pause(pauses: &[PauseCfg], now: i64) -> Option<(String, i64)> {
    for w in pauses {
        let tz = tz_of(&w.tz);
        let (da, a) = day_time(&w.start).unwrap_or_else(|e| panic!("{e}"));
        let (db, b) = day_time(&w.end).unwrap_or_else(|e| panic!("{e}"));
        let span = match (db as i64 - da as i64).rem_euclid(7) {
            0 if b <= a => 7,
            x => x,
        };
        for d in dates(now - 8 * DAY_MS, now, &tz) {
            if weekday(d) == da && at(d, a, &tz) <= now {
                let end = at(d + Days::new(span as u64), b, &tz);
                if now < end {
                    return Some((w.name.clone(), end));
                }
            }
        }
    }
    None
}

pub fn state(sessions: &[SessionCfg], events: &[EventCfg], now: i64, start_min: i64) -> P::SessionState {
    let wins = windows(sessions, now - DAY_MS, now + 8 * DAY_MS);
    let open_w = wins.iter().find(|w| w.1 <= now && now < w.2);
    let mut nxt: Vec<(i64, String)> = vec![];
    nxt.extend(wins.iter().filter(|w| w.1 > now).map(|w| (w.1, format!("{} open", w.0))));
    nxt.extend(wins.iter().filter(|w| w.2 > now).map(|w| (w.2, format!("{} close", w.0))));
    nxt.extend(event_marks(events, now + 1, now + 8 * DAY_MS).into_iter().map(|(n, t)| (t, n)));
    if nxt.is_empty() {
        nxt.push((day_start(now, start_min) + DAY_MS, "day start".into()));
    }
    let (t, name) = nxt.into_iter().min().unwrap();
    P::SessionState {
        name: open_w.map(|w| w.0.clone()),
        open: open_w.is_some() || sessions.is_empty(),
        next_event: Some(name),
        next_event_at: Some(t),
    }
}

pub fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    chrono::Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ny() -> SessionCfg {
        SessionCfg::new("NY", "America/New_York", "08:00", "17:00", "mon-fri")
    }
    fn ldn() -> SessionCfg {
        SessionCfg::new("London", "Europe/London", "08:00", "16:30", "mon-fri")
    }
    fn data() -> EventCfg {
        EventCfg::new("data", "America/New_York", "07:30", "mon-fri")
    }
    fn u(y: i32, mo: u32, d: u32) -> i64 {
        utc(y, mo, d, 0, 0)
    }
    fn set(days: &[u32]) -> u8 {
        days.iter().fold(0, |m, d| m | 1 << d)
    }

    #[test]
    fn parse_days_() {
        assert_eq!(parse_days("mon-fri").unwrap(), set(&[0, 1, 2, 3, 4]));
        assert_eq!(parse_days("fri-mon").unwrap(), set(&[4, 5, 6, 0]));
        assert_eq!(parse_days("sat,sun").unwrap(), set(&[5, 6]));
        assert_eq!(parse_days("").unwrap(), set(&[0, 1, 2, 3, 4, 5, 6]));
        assert!(parse_days("xyz").is_err());
    }

    #[test]
    fn dst_summer_and_winter() {
        // Monday 2026-10-05, New York on EDT (UTC-4)
        let w = windows(&[ny()], u(2026, 10, 5), u(2026, 10, 6));
        assert_eq!(w, [("NY".to_string(), utc(2026, 10, 5, 12, 0), utc(2026, 10, 5, 21, 0))]);
        // Monday 2026-11-09, after the November switch to EST (UTC-5)
        let w = windows(&[ny()], u(2026, 11, 9), u(2026, 11, 10));
        assert_eq!(w, [("NY".to_string(), utc(2026, 11, 9, 13, 0), utc(2026, 11, 9, 22, 0))]);
        // the week between US and UK switches in March: London still GMT, New York already EDT
        assert_eq!(windows(&[ldn()], u(2026, 3, 9), u(2026, 3, 10))[0].1, utc(2026, 3, 9, 8, 0));
        assert_eq!(windows(&[ny()], u(2026, 3, 9), u(2026, 3, 10))[0].1, utc(2026, 3, 9, 12, 0));
    }

    #[test]
    fn events_resolve_in_their_zone() {
        assert_eq!(event_marks(&[data()], u(2026, 10, 5), u(2026, 10, 6)), [("data".to_string(), utc(2026, 10, 5, 11, 30))]);
        assert_eq!(event_marks(&[data()], u(2026, 12, 7), u(2026, 12, 8)), [("data".to_string(), utc(2026, 12, 7, 12, 30))]);
    }

    #[test]
    fn state_open_and_next_event() {
        let s = state(&[ny()], &[data()], utc(2026, 10, 5, 11, 0), 0);
        assert_eq!((s.open, s.name, s.next_event.as_deref(), s.next_event_at), (false, None, Some("data"), Some(utc(2026, 10, 5, 11, 30))));
        let s = state(&[ny()], &[data()], utc(2026, 10, 5, 14, 0), 0);
        assert_eq!(
            (s.open, s.name.as_deref(), s.next_event.as_deref(), s.next_event_at),
            (true, Some("NY"), Some("NY close"), Some(utc(2026, 10, 5, 21, 0)))
        );
        let s = state(&[ny()], &[], utc(2026, 10, 3, 14, 0), 0);   // Saturday
        assert!(!s.open && s.next_event.as_deref() == Some("NY open") && s.next_event_at == Some(utc(2026, 10, 5, 12, 0)));
    }

    #[test]
    fn no_sessions_is_24h() {
        let s = state(&[], &[], utc(2026, 10, 4, 10, 0), 0);
        assert!(s.open && s.name.is_none() && s.next_event.as_deref() == Some("day start"));
        assert_eq!(s.next_event_at, Some(u(2026, 10, 5)));
    }

    #[test]
    fn day_start_() {
        let now = utc(2026, 10, 4, 10, 0);
        assert_eq!(day_start(now, 0), u(2026, 10, 4));
        assert_eq!(day_start(now, 12 * 60), utc(2026, 10, 3, 12, 0));
        assert_eq!(day_start(now, 8 * 60) + DAY_MS, utc(2026, 10, 5, 8, 0));
    }

    #[test]
    fn hedge_pause_follows_dst() {
        let w = [PauseCfg::new("off", "Europe/London", "fri 21:00", "sun 21:00")];
        let off = |t| Some(("off".to_string(), t));
        // October (BST, UTC+1): Fri 20:00Z to Sun 20:00Z
        assert_eq!(pause(&w, utc(2026, 10, 9, 19, 59)), None);
        assert_eq!(pause(&w, utc(2026, 10, 9, 20, 0)), off(utc(2026, 10, 11, 20, 0)));
        assert_eq!(pause(&w, utc(2026, 10, 10, 12, 0)), off(utc(2026, 10, 11, 20, 0)));
        assert_eq!(pause(&w, utc(2026, 10, 11, 20, 0)), None);
        assert_eq!(pause(&w, utc(2026, 10, 5, 6, 0)), None);   // Monday
        // after the October switch (GMT, UTC+0): Fri 21:00Z to Sun 21:00Z
        assert_eq!(pause(&w, utc(2026, 11, 6, 20, 30)), None);
        assert_eq!(pause(&w, utc(2026, 11, 6, 21, 0)), off(utc(2026, 11, 8, 21, 0)));
        assert!(pause(&w, utc(2026, 11, 8, 20, 30)).is_some());
        assert_eq!(pause(&w, utc(2026, 11, 8, 21, 0)), None);
    }

    #[test]
    fn gap_and_fold_like_zoneinfo() {
        let tz = zone("America/New_York").unwrap();
        // 2026-03-08 02:30 does not exist: zoneinfo (fold 0) uses EST, i.e. 07:30Z
        assert_eq!(at(NaiveDate::from_ymd_opt(2026, 3, 8).unwrap(), 150, &tz), utc(2026, 3, 8, 7, 30));
        // 2026-11-01 01:30 happens twice: fold 0 is the first (EDT), 05:30Z
        assert_eq!(at(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), 90, &tz), utc(2026, 11, 1, 5, 30));
    }
}
