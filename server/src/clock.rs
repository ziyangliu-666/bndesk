//! Wall clock in ms and the exchange clock offset.
use std::cell::Cell;
use std::sync::atomic::{AtomicI64, Ordering};
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

/// Exchange clock: local time plus the offset measured by `rest::sync_time`.
pub struct TimeSync {
    offset_ms: AtomicI64,
}

impl TimeSync {
    pub fn offset_ms(&self) -> i64 {
        self.offset_ms.load(Ordering::Relaxed)
    }

    pub fn set_offset_ms(&self, ms: i64) {
        self.offset_ms.store(ms, Ordering::Relaxed);
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

pub static CLOCK: TimeSync = TimeSync { offset_ms: AtomicI64::new(0) };

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
}
