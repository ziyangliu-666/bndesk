//! Public market-data feeds and their health.
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

pub use crate::clock::now_ms;
pub use crate::protocol::FeedKind;

/// Health of one of the monitor's own connections.
#[derive(Debug, Clone)]
pub struct Feed {
    pub name: String,
    pub kind: FeedKind,
    pub up: bool,
    pub msgs: u64,
    pub last: Option<i64>,
    pub detail: String,
    pub error: String,
    pub down_since: Option<i64>,
    pub rate: f64,
    count_at: (u64, Instant),
}

/// A feed shared between its connection task and the snapshot builder.
pub type FeedRef = Rc<RefCell<Feed>>;

impl Feed {
    pub fn new(name: impl Into<String>, kind: FeedKind, detail: impl Into<String>) -> Self {
        Feed {
            name: name.into(),
            kind,
            up: false,
            msgs: 0,
            last: None,
            detail: detail.into(),
            error: String::new(),
            down_since: Some(now_ms()),
            rate: 0.0,
            count_at: (0, Instant::now()),
        }
    }

    pub fn shared(name: impl Into<String>, kind: FeedKind, detail: impl Into<String>) -> FeedRef {
        Rc::new(RefCell::new(Feed::new(name, kind, detail)))
    }

    pub fn hit(&mut self, n: u64) {
        self.msgs += n;
        self.last = Some(now_ms());
    }

    pub fn set_up(&mut self, up: bool, detail: Option<&str>) {
        if let Some(d) = detail {
            self.detail.clear();
            self.detail.push_str(d);
        }
        if up && !self.up {
            self.down_since = None;
        } else if !up && self.up {
            self.down_since = Some(now_ms());
        }
        self.up = up;
    }

    /// The wire row (rate rounded to 2 places like the Python snapshot).
    pub fn proto(&self) -> crate::protocol::Feed {
        crate::protocol::Feed {
            name: self.name.clone(),
            kind: self.kind,
            up: self.up,
            msgs_per_s: (self.rate * 100.0).round() / 100.0,
            last: self.last,
            detail: self.detail.clone(),
        }
    }

    pub fn update_rate(&mut self) {
        let (n, t) = self.count_at;
        let mt = Instant::now();
        let dt = mt.duration_since(t).as_secs_f64();
        if dt >= 1.0 {
            self.rate = (self.msgs - n) as f64 / dt;
            self.count_at = (self.msgs, mt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn up_down_tracks_down_since() {
        let mut f = Feed::new("x", FeedKind::Public, "");
        assert!(!f.up && f.down_since.is_some());
        f.set_up(true, Some("ok"));
        assert!(f.up && f.down_since.is_none() && f.detail == "ok");
        f.hit(2);
        assert_eq!(f.msgs, 2);
        f.set_up(false, None);
        assert!(f.down_since.is_some() && f.detail == "ok");
    }
}
