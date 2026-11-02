//! Wall clock in ms and the exchange clock offset.
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Local wall clock, epoch ms.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Local wall clock, epoch seconds (Python `time.time()`).
pub fn now_s() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64())
}

thread_local! {
    static FIXED: Cell<Option<i64>> = const { Cell::new(None) };
}

/// An exchange's clock: local time plus the offset a connector measured. Each connector has its own, for what it asks
/// and signs; `CLOCK` is the desk's, which reads the exchange that `lead`s.
pub struct TimeSync {
    offset_ms: AtomicI64,
    leads: AtomicBool,
}

impl TimeSync {
    pub const fn new() -> Self {
        TimeSync { offset_ms: AtomicI64::new(0), leads: AtomicBool::new(false) }
    }

    pub fn offset_ms(&self) -> i64 {
        self.offset_ms.load(Ordering::Relaxed)
    }

    pub fn set_offset_ms(&self, ms: i64) {
        self.offset_ms.store(ms, Ordering::Relaxed);
        if self.leads.load(Ordering::Relaxed) {
            CLOCK.offset_ms.store(ms, Ordering::Relaxed);
        }
    }

    /// The desk's clock reads this one from now on: a desk has one grid, on its first exchange's time.
    pub fn lead(&self) {
        self.leads.store(true, Ordering::Relaxed);
        CLOCK.offset_ms.store(self.offset_ms(), Ordering::Relaxed);
    }

    pub fn now(&self) -> i64 {
        if let Some(t) = FIXED.with(Cell::get) {
            return t;
        }
        now_ms() + self.offset_ms()
    }

    /// Pin `now()` on this thread (tests; the monkeypatched `CLOCK.now` of the Python tests). None unpins.
    pub fn set_fixed(&self, t: Option<i64>) {
        FIXED.with(|c| c.set(t));
    }
}

impl Default for TimeSync {
    fn default() -> Self {
        Self::new()
    }
}

pub static CLOCK: TimeSync = TimeSync::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_and_fixed() {
        CLOCK.set_fixed(Some(5));
        assert_eq!(CLOCK.now(), 5);
        CLOCK.set_fixed(None);
        let a = now_ms();
        assert!((CLOCK.now() - a - CLOCK.offset_ms()).abs() < 1000);
    }

    #[test]
    fn an_exchange_keeps_its_own_clock_and_the_desk_reads_the_one_that_leads() {
        static FIRST: TimeSync = TimeSync::new();
        static SECOND: TimeSync = TimeSync::new();
        FIRST.set_offset_ms(250);
        SECOND.set_offset_ms(-40);
        FIRST.lead();
        assert_eq!(CLOCK.offset_ms(), 250);
        SECOND.set_offset_ms(-90);
        assert_eq!((SECOND.offset_ms(), CLOCK.offset_ms()), (-90, 250));
        FIRST.set_offset_ms(300);
        assert_eq!(CLOCK.offset_ms(), 300);
    }
}
