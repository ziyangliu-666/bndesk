//! Wire protocol (server -> web). Field names mirror DESIGN.md and web/src/protocol.ts exactly;
//! serde writes fields in declaration order and `None` as `null`.
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

macro_rules! str_enum {
    ($(#[$m:meta])* $name:ident { $($v:ident = $s:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
        pub enum $name {
            #[default]
            $(#[serde(rename = $s)] $v),+
        }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $($name::$v => $s),+ }
            }
        }
        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
        impl std::str::FromStr for $name {
            type Err = String;
            fn from_str(s: &str) -> Result<Self, String> {
                match s { $($s => Ok($name::$v),)+ _ => Err(format!(concat!("bad ", stringify!($name), ": {:?}"), s)) }
            }
        }
    };
}

str_enum!(Venue { Spot = "spot", Usdm = "usdm" });
str_enum!(Side { Buy = "buy", Sell = "sell" });
str_enum!(Role { Master = "master", Sub = "sub" });
str_enum!(UserStream { Up = "up", Down = "down", NA = "n/a" });
str_enum!(Level { Info = "info", Warn = "warn", Crit = "crit" });
str_enum!(FeedKind { Public = "public", User = "user", Rest = "rest", Engine = "engine" });

impl Venue {
    pub const ALL: [Venue; 2] = [Venue::Spot, Venue::Usdm];

    pub fn index(self) -> usize {
        self as usize
    }
}

/// Markout horizons "1", "10", "60", "300" (fills::HK), serialized as an object in that order.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Marks(pub [Option<f64>; 4]);

pub const MARK_KEYS: [&str; 4] = ["1", "10", "60", "300"];

impl Serialize for Marks {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(4))?;
        for (k, v) in MARK_KEYS.iter().zip(self.0.iter()) {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct SessionWindow {
    pub name: String,
    pub start: i64,
    pub end: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct EventMark {
    pub name: String,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct SessionState {
    pub name: Option<String>,
    pub open: bool,
    pub next_event: Option<String>,
    pub next_event_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct PnlSummary {
    pub trading: f64,
    pub trading_se: Option<f64>,
    pub hedged: f64,
    pub hedged_se: Option<f64>,
    pub factor: f64,
    pub factor_se: Option<f64>,
    pub ref_hedge: f64,
    pub factor_hedge: f64,
    pub liquidation: f64,
    pub covered_s: i64,
    pub backfilled_s: i64,
    /// sells matched FIFO to today's buys, minus today's spot fees
    pub realized: f64,
    /// sells matched to the inventory held at the day start, against its opening price
    pub realized_old: f64,
    /// the inventory left, at its price now against its cost
    pub floating: f64,
    /// market making: Σ s q (M(t + h) − p) − fee over today's fills, the instrument's own mid h after each
    /// fill (mid now until h has passed)
    pub mm: f64,
    /// the same at h = 0 against the fair at the fill: the spread alone
    pub mm_spread: f64,
    /// trading − mm: the opening inventory and each fill's position from h on, at the instrument's mid
    pub inventory: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Summary {
    pub equity: f64,
    pub pnl_day: f64,
    pub pnl_1h: f64,
    /// day PnL − Π − hedge legs' P&L
    pub other: Option<f64>,
    pub pnl: PnlSummary,
    pub markout_net_bps_1h: Option<f64>,
    pub fills_1h: i64,
    pub fills_day: i64,
    pub volume_day: f64,
    pub fills_24h: i64,
    pub volume_24h: f64,
    pub inventory_value: f64,
    pub inventory_assets: i64,
    pub fee_expiry: Option<String>,
    pub day_start: i64,
    pub sessions: Vec<SessionWindow>,
    pub events: Vec<EventMark>,
    pub session: SessionState,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Position {
    pub symbol: String,
    pub amt: f64,
    pub entry: f64,
    pub mark: f64,
    pub upnl: f64,
    pub notional: f64,
    /// Today's P&L of the symbol on this account: price, fees, funding.
    pub pnl_day: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct FeeRate {
    pub venue: Venue,
    pub maker_bps: f64,
    pub taker_bps: f64,
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Account {
    pub id: String,
    pub label: String,
    pub email: String,
    pub role: Role,
    pub equity: f64,
    pub equity_open: f64,
    pub pnl_day: f64,
    pub transfers_day: f64,
    pub quote_free: f64,
    pub quote_locked: f64,
    pub inventory_value: f64,
    pub fut_wallet: f64,
    pub fut_upnl: f64,
    pub fut_available: f64,
    pub positions: Vec<Position>,
    pub orders_10s: i64,
    pub orders_10s_limit: i64,
    pub orders_1d: i64,
    pub orders_1d_limit: i64,
    pub open_orders: i64,
    pub bids_notional: f64,
    pub asks_notional: f64,
    pub utilization: f64,
    pub fees: Vec<FeeRate>,
    pub user_stream: UserStream,
    pub updated: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct SymbolRow {
    pub symbol: String,
    pub venue: Venue,
    pub reference: Option<String>,
    pub mid: Option<f64>,
    pub ref_mid: Option<f64>,
    pub spread_bps: Option<f64>,
    pub basis_bps: Option<f64>,
    pub inv_qty: f64,
    pub inv_value: f64,
    pub avg_cost: Option<f64>,
    pub upnl: Option<f64>,
    pub fills_day: i64,
    pub buys_day: i64,
    pub sells_day: i64,
    pub volume_day: f64,
    pub edge_bps: Option<f64>,
    pub mk10_bps: Option<f64>,
    pub mk60_bps: Option<f64>,
    pub mk300_bps: Option<f64>,
    pub trading_pnl: f64,
    pub hedged_pnl: f64,
    pub realized_pnl: f64,
    pub float_pnl: f64,
    pub mm_pnl: f64,
    pub inv_pnl: f64,
    pub open_bids: i64,
    pub open_asks: i64,
    pub bid_dist_bps: Option<f64>,
    pub ask_dist_bps: Option<f64>,
    pub last_fill: Option<i64>,
    pub dust: bool,
    pub fair: Option<f64>,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Fill {
    pub id: String,
    pub ts: i64,
    pub account: String,
    pub symbol: String,
    pub venue: Venue,
    pub side: Side,
    pub price: f64,
    pub qty: f64,
    pub notional: f64,
    pub fee: f64,
    pub fee_asset: String,
    pub maker: bool,
    pub fair: Option<f64>,
    pub edge_bps: Option<f64>,
    pub mk: Marks,
    pub mk_raw: Marks,
    pub mk_fast: Marks,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct SeriesPoint {
    pub t: i64,
    pub equity: f64,
    pub pnl_day: f64,
    pub trading: Option<f64>,   // None before the P&L grid ran
    pub hedged: Option<f64>,
    pub inventory: f64,
    pub futures_notional: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct AccountExposure {
    pub account: String,
    pub spot_value: f64,
    pub futures_notional: f64,
    pub net: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Funding {
    pub symbol: String,
    pub rate: Option<f64>,
    pub next: Option<i64>,
    pub position: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Exposure {
    pub spot_value: f64,
    pub futures_notional: f64,
    pub net: f64,
    pub target: Option<f64>,
    pub band: Option<f64>,
    pub gap: Option<f64>,
    pub by_account: Vec<AccountExposure>,
    pub funding: Vec<Funding>,
    pub beta_value: f64,
    pub hedge_notional: f64,
    pub ratio: Option<f64>,
    pub paused: Option<String>,
    pub paused_until: Option<i64>,
    pub beta_source: String,
    pub hedge_day: Option<HedgeDay>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HedgeLeg {
    pub symbol: String,
    pub qty0: f64,
    pub qty: f64,
    pub mark0: Option<f64>,
    pub mark: Option<f64>,
    pub fills: i64,
    pub price_pnl: Option<f64>,
    pub fees: f64,
    pub funding: f64,
    pub pnl: Option<f64>,
}

/// Today's inventory drift against the futures legs.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HedgeDay {
    /// H: the spot inventory's move on each name's reference
    pub inventory_drift: f64,
    /// Hm: the part the beta instrument explains
    pub factor_drift: f64,
    /// H - Hm
    pub residual_drift: f64,
    /// futures legs: price P&L - fees + funding
    pub hedge_pnl: Option<f64>,
    pub price_pnl: Option<f64>,
    pub fees: f64,
    pub funding: f64,
    /// -hedge_pnl / Hm
    pub offset_factor: Option<f64>,
    /// -hedge_pnl / H
    pub offset_total: Option<f64>,
    /// H + hedge_pnl
    pub net: Option<f64>,
    pub legs: Vec<HedgeLeg>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct RejectCount {
    pub reason: String,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Latency {
    pub name: String,
    pub p50_us: Option<f64>,
    pub p99_us: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct EngineVenue {
    pub name: String,
    pub md: String,
    pub user: String,
    pub order: String,
    pub reconnects: i64,
    pub cooldowns: i64,
    pub rest_errors: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Engine {
    pub name: String,
    pub url: String,
    pub up: bool,
    pub stale_s: f64,
    pub state: String,
    pub strategy: String,
    pub orders: i64,
    pub cancels: i64,
    pub fills: i64,
    pub risk_rejects: i64,
    pub venue_rejects: i64,
    pub rejects: Vec<RejectCount>,
    pub realized: f64,
    pub unrealized: f64,
    pub fees: f64,
    pub max_loss: Option<f64>,
    pub kill: bool,
    pub kill_reason: Option<String>,
    pub latency: Vec<Latency>,
    pub venues: Vec<EngineVenue>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Alert {
    pub id: String,
    pub rule: String,
    pub level: Level,
    pub text: String,
    pub since: i64,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Feed {
    pub name: String,
    pub kind: FeedKind,
    pub up: bool,
    pub msgs_per_s: f64,
    pub last: Option<i64>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HourStats {
    pub hour: i64,
    pub fills: i64,
    pub mk10: Option<f64>,
    pub mk60: Option<f64>,
    pub pnl: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Toxicity {
    pub horizons_s: Vec<f64>,
    pub bps: Vec<Option<f64>>,
    pub fills: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct MarkoutStats {
    pub horizons: Vec<i64>,
    pub all: Vec<Option<f64>>,
    pub buys: Vec<Option<f64>>,
    pub sells: Vec<Option<f64>>,
    pub raw: Vec<Option<f64>>,
    pub fast: Vec<Option<f64>>,
    pub by_hour: Vec<HourStats>,
    pub toxicity: Toxicity,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct OpenOrder {
    pub id: String,
    pub account: String,
    pub symbol: String,
    pub venue: Venue,
    pub side: Side,
    pub price: f64,
    pub qty: f64,
    pub notional: f64,
    pub fair: Option<f64>,
    pub dist_bps: Option<f64>,
    pub since: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct DayPnl {
    pub day: String,
    pub trading: f64,
    pub trading_se: Option<f64>,
    pub hedged: f64,
    pub hedged_se: Option<f64>,
    pub factor: f64,
    pub factor_se: Option<f64>,
    pub fills: i64,
    pub volume: f64,
    pub covered_s: i64,
    pub backfilled_s: i64,
    /// the day's real-money split as it stood at its end (null before it was kept)
    pub pnl_day: Option<f64>,
    pub realized: Option<f64>,
    pub realized_old: Option<f64>,
    pub floating: Option<f64>,
    pub hedge: Option<f64>,
    pub other: Option<f64>,
    pub mm: Option<f64>,
    pub inventory: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HourPnl {
    pub t: i64,
    pub trading: f64,
    pub hedged: f64,
    pub factor: f64,
    pub fills: i64,
    pub volume: f64,
    /// market making of the hour's fills; inventory = trading − mm
    pub mm: f64,
    pub inventory: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct AccountSeries {
    pub account: String,
    pub t: Vec<i64>,
    pub equity: Vec<f64>,
    pub pnl_day: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Snapshot {
    pub now: i64,
    pub summary: Summary,
    pub accounts: Vec<Account>,
    pub symbols: Vec<SymbolRow>,
    pub fills: Vec<Fill>,
    pub series: Vec<SeriesPoint>,
    pub exposure: Exposure,
    pub engines: Vec<Engine>,
    pub alerts: Vec<Alert>,
    pub feeds: Vec<Feed>,
    pub markouts: MarkoutStats,
    pub orders: Vec<OpenOrder>,
    pub days: Vec<DayPnl>,
    pub hours: Vec<HourPnl>,
    pub account_series: Vec<AccountSeries>,
}

pub const SNAPSHOT_KEYS: [&str; 15] = [
    "now", "summary", "accounts", "symbols", "fills", "series", "exposure", "engines", "alerts", "feeds",
    "markouts", "orders", "days", "hours", "account_series",
];

/// `GET /api/history`: the desk's P&L since `from` in bars of `step` seconds.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct History {
    pub step: i64,
    pub bars: Vec<HistoryBar>,
    pub days: Vec<HistoryDay>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HistoryBar {
    pub t: i64,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
    pub pi: Option<f64>,
    pub realized: Option<f64>,
    pub mm: Option<f64>,
    pub hedge: Option<f64>,
    pub inventory: Option<f64>,
    pub futures: Option<f64>,
    pub volume: f64,
    pub fills: i64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HistoryDay {
    pub day: String,
    pub start: i64,
}

/// `GET /api/fills`: one stored fill.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HistoryFill {
    pub t: i64,
    pub side: String,
    pub price: f64,
    pub qty: f64,
    pub account: String,
    pub venue: String,
    pub maker: bool,
}

pub fn encode<T: Serialize + ?Sized>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).expect("protocol types always serialize")
}

#[cfg(test)]
mod tests {
    //! The structs must carry exactly the field names of the TypeScript contract in DESIGN.md.
    use super::*;
    use regex::Regex;
    use sonic_rs::JsonContainerTrait;
    use std::collections::HashMap;

    const DESIGN: &str = include_str!("../../DESIGN.md");

    /// Top-level `name: type` pairs of a TS object body (in order); nested object types are kept as text.
    fn fields(body: &str) -> Vec<(String, String)> {
        let mut parts = vec![];
        let (mut depth, mut start) = (0i32, 0usize);
        for (i, c) in body.char_indices() {
            match c {
                '{' | '(' | '[' => depth += 1,
                '}' | ')' | ']' => depth -= 1,
                ';' | ',' | '\n' if depth == 0 => {
                    parts.push(&body[start..i]);
                    start = i + 1;
                }
                _ => {}
            }
        }
        parts.push(&body[start..]);
        let comment = Regex::new(r"//.*").unwrap();
        let mut out: Vec<(String, String)> = vec![];
        for p in parts {
            let p = comment.replace_all(p, "");
            let p = p.trim();
            if let Some((name, typ)) = p.split_once(':') {
                let name = name.trim().trim_matches('"').to_string();
                match out.iter_mut().find(|(n, _)| *n == name) {
                    Some(e) => e.1 = typ.trim().to_string(),
                    None => out.push((name, typ.trim().to_string())),
                }
            }
        }
        out
    }

    fn interfaces() -> HashMap<String, Vec<(String, String)>> {
        let blocks = Regex::new(r"(?s)```ts\n(.*?)```").unwrap();
        let ts: Vec<&str> = blocks.captures_iter(DESIGN).map(|c| c.get(1).unwrap().as_str()).collect();
        let ts = ts.join("\n");
        let b = ts.as_bytes();
        let mut out = HashMap::new();
        for m in Regex::new(r"interface (\w+) \{").unwrap().captures_iter(&ts) {
            let end = m.get(0).unwrap().end();
            let (mut i, mut depth) = (end, 1);
            while depth > 0 {
                depth += match b[i] {
                    b'{' => 1,
                    b'}' => -1,
                    _ => 0,
                };
                i += 1;
            }
            out.insert(m[1].to_string(), fields(&ts[end..i - 1]));
        }
        out
    }

    fn inline(typ: &str) -> Vec<String> {
        fields(&typ[typ.find('{').unwrap() + 1..typ.rfind('}').unwrap()]).into_iter().map(|f| f.0).collect()
    }

    fn names(f: &[(String, String)]) -> Vec<String> {
        f.iter().map(|x| x.0.clone()).collect()
    }

    fn typ<'a>(f: &'a [(String, String)], k: &str) -> &'a str {
        &f.iter().find(|x| x.0 == k).unwrap().1
    }

    /// Field names of a struct in serialization order.
    fn struct_fields<T: Serialize>(v: &T) -> Vec<String> {
        let s = serde_json::to_string(v).unwrap();
        let v: sonic_rs::Value = sonic_rs::from_str(&s).unwrap();
        v.as_object().unwrap().iter().map(|(k, _)| k.to_string()).collect()
    }

    #[test]
    fn struct_matches_interface() {
        let ifaces = interfaces();
        let cases: Vec<(&str, Vec<String>)> = vec![
            ("Snapshot", struct_fields(&Snapshot::default())),
            ("Summary", struct_fields(&Summary::default())),
            ("Account", struct_fields(&Account::default())),
            ("SymbolRow", struct_fields(&SymbolRow::default())),
            ("Fill", struct_fields(&Fill::default())),
            ("SeriesPoint", struct_fields(&SeriesPoint::default())),
            ("Exposure", struct_fields(&Exposure::default())),
            ("Engine", struct_fields(&Engine::default())),
            ("Alert", struct_fields(&Alert::default())),
            ("Feed", struct_fields(&Feed::default())),
            ("MarkoutStats", struct_fields(&MarkoutStats::default())),
            ("AccountSeries", struct_fields(&AccountSeries::default())),
            ("History", struct_fields(&History::default())),
            ("HistoryBar", struct_fields(&HistoryBar::default())),
            ("HistoryFill", struct_fields(&HistoryFill::default())),
        ];
        for (name, got) in cases {
            assert_eq!(got, names(&ifaces[name]), "{name}");
        }
        assert_eq!(struct_fields(&Snapshot::default()), SNAPSHOT_KEYS);
    }

    #[test]
    fn nested_struct_matches() {
        let ifaces = interfaces();
        let nested: Vec<(&str, &str, Vec<String>)> = vec![
            ("Summary", "sessions", struct_fields(&SessionWindow::default())),
            ("Summary", "events", struct_fields(&EventMark::default())),
            ("Summary", "session", struct_fields(&SessionState::default())),
            ("Account", "positions", struct_fields(&Position::default())),
            ("Account", "fees", struct_fields(&FeeRate::default())),
            ("Exposure", "by_account", struct_fields(&AccountExposure::default())),
            ("Exposure", "funding", struct_fields(&Funding::default())),
            ("Engine", "rejects", struct_fields(&RejectCount::default())),
            ("Engine", "latency", struct_fields(&Latency::default())),
            ("Engine", "venues", struct_fields(&EngineVenue::default())),
            ("MarkoutStats", "by_hour", struct_fields(&HourStats::default())),
            ("MarkoutStats", "toxicity", struct_fields(&Toxicity::default())),
            ("Summary", "pnl", struct_fields(&PnlSummary::default())),
            ("Snapshot", "days", struct_fields(&DayPnl::default())),
            ("Snapshot", "hours", struct_fields(&HourPnl::default())),
            ("History", "days", struct_fields(&HistoryDay::default())),
        ];
        for (parent, field, got) in nested {
            assert_eq!(got, inline(typ(&ifaces[parent], field)), "{parent}.{field}");
        }
    }

    #[test]
    fn fill_marks_keys() {
        let ifaces = interfaces();
        for k in ["mk", "mk_raw", "mk_fast"] {
            assert_eq!(inline(typ(&ifaces["Fill"], k)), ["1", "10", "60", "300"]);
        }
        let f = Fill {
            id: "i".into(), ts: 1, account: "a".into(), symbol: "S".into(), venue: Venue::Spot, side: Side::Buy,
            price: 1.0, qty: 1.0, notional: 1.0, fee: 0.0, fee_asset: "USDT".into(), maker: true, fair: None,
            edge_bps: None, mk: Marks([Some(1.0), None, None, None]), mk_raw: Marks::default(),
            mk_fast: Marks::default(),
        };
        let d: serde_json::Value = serde_json::from_slice(&encode(&f)).unwrap();
        assert_eq!(d["mk"], serde_json::json!({"1": 1.0, "10": null, "60": null, "300": null}));
        assert_eq!(d["venue"], "spot");
        let s = String::from_utf8(encode(&f)).unwrap();
        assert!(s.contains(r#""mk":{"1":1.0,"10":null,"60":null,"300":null}"#), "{s}");
    }

    #[test]
    fn messages_are_typed() {
        let ts = DESIGN.split_once("type Msg =").unwrap().1.split(";\n\n").next().unwrap();
        let mut got: Vec<String> =
            Regex::new(r#"type: "(\w+)""#).unwrap().captures_iter(ts).map(|c| c[1].to_string()).collect();
        got.sort();
        got.dedup();
        assert_eq!(got, ["account_series", "fills", "patch", "series", "snapshot"]);
    }

    #[test]
    fn enums_serialize_as_strings() {
        assert_eq!(serde_json::to_string(&UserStream::NA).unwrap(), r#""n/a""#);
        assert_eq!("usdm".parse::<Venue>().unwrap(), Venue::Usdm);
        assert_eq!(serde_json::to_string(&f64::NAN).unwrap(), "null");
    }
}
