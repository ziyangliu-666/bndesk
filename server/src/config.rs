//! desk.toml: accounts, markets, exposure, sessions, alerts.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use toml::{Table, Value};

use crate::beta::BetaCfg;
use crate::protocol::{Role, Venue};

#[derive(Debug, Clone, PartialEq)]
pub struct Ref {
    pub symbol: String,
    pub venue: Venue,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MarketCfg {
    pub symbol: String,
    pub venue: Venue,
    pub reference: Option<Ref>,
    pub beta: f64,
    pub beta_prior: Option<f64>,   // overrides [exposure] beta_prior for this market
}

impl MarketCfg {
    pub fn new(symbol: impl Into<String>, venue: Venue) -> Self {
        MarketCfg { symbol: symbol.into(), venue, reference: None, beta: 1.0, beta_prior: None }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AccountCfg {
    pub id: String,
    pub label: String,
    pub email: String,
    pub role: Role,
    pub futures: bool,
    pub api_key_env: String,
    pub secret_env: String,
    pub private_key_env: String,
    pub show: bool,   // false: used for transfers and sub-account reads, kept off the desk
}

impl AccountCfg {
    pub fn new(id: &str, label: &str, email: &str, role: Role) -> Self {
        AccountCfg {
            id: id.into(),
            label: label.into(),
            email: email.into(),
            role,
            futures: false,
            api_key_env: String::new(),
            secret_env: String::new(),
            private_key_env: String::new(),
            show: true,
        }
    }
}

fn mon_fri() -> String {
    "mon-fri".into()
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionCfg {
    pub name: String,
    pub tz: String,
    pub start: String,
    pub end: String,
    #[serde(default = "mon_fri")]
    pub days: String,
}

impl SessionCfg {
    pub fn new(name: &str, tz: &str, start: &str, end: &str, days: &str) -> Self {
        SessionCfg { name: name.into(), tz: tz.into(), start: start.into(), end: end.into(), days: days.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventCfg {
    pub name: String,
    pub tz: String,
    pub at: String,
    #[serde(default = "mon_fri")]
    pub days: String,
}

impl EventCfg {
    pub fn new(name: &str, tz: &str, at: &str, days: &str) -> Self {
        EventCfg { name: name.into(), tz: tz.into(), at: at.into(), days: days.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct AlertCfg {
    pub day_drawdown_usd: f64,
    pub drop_15m_usd: f64,
    pub inventory_cap_usd: f64,
    pub asset_cap_usd: f64,
    pub markout_floor_bps: f64,
    pub stale_quote_s: f64,
    pub futures_margin_min_usd: f64,
    pub drop_1h_usd: f64,
    pub quote_idle_usd: f64,
    pub quote_idle_s: f64,
    pub latency_p99_us: f64,
    /// |day PnL − Π − hedge legs| above this for 5 min: a fill, transfer or asset the desk does not see
    pub reconcile_usd: f64,
}

impl Default for AlertCfg {
    fn default() -> Self {
        AlertCfg {
            day_drawdown_usd: 100.0,
            drop_15m_usd: 40.0,
            inventory_cap_usd: 10000.0,
            asset_cap_usd: 1000.0,
            markout_floor_bps: -1.0,
            stale_quote_s: 5.0,
            futures_margin_min_usd: 100.0,
            drop_1h_usd: 100.0,
            quote_idle_usd: 10.0,
            quote_idle_s: 600.0,
            latency_p99_us: 2000.0,
            reconcile_usd: 1.0,
        }
    }
}

/// A weekly window in which the hedge is off: the target is 0 and any hedge left is to be closed.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PauseCfg {
    pub name: String,
    pub tz: String,
    pub start: String,   // "fri 16:00"
    pub end: String,     // "sun 17:00"
}

impl PauseCfg {
    pub fn new(name: &str, tz: &str, start: &str, end: &str) -> Self {
        PauseCfg { name: name.into(), tz: tz.into(), start: start.into(), end: end.into() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EngineCfg {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub path: PathBuf,
    pub listen: String,
    pub db: PathBuf,
    pub simulate: bool,
    pub day_start_min: i64,
    pub fair_halflife_s: f64,
    pub keep_fine_days: f64,
    pub mark_max_spread_bps: f64,
    pub keep_days: f64,
    /// market making is marked at the instrument's own mid this long after each fill (a markout horizon)
    pub mm_horizon_s: i64,
    pub markets: Vec<MarketCfg>,
    pub target_ratio: Option<f64>,
    pub band_usd: Option<f64>,
    pub band_frac: f64,   // band = max(band_usd, band_frac x |target|)
    pub hedge_pauses: Vec<PauseCfg>,
    pub hedge_symbols: Vec<String>,
    pub markets_only: bool,
    pub beta: Option<BetaCfg>,
    pub beta_vs: Option<String>,   // instrument key the factor hedge is measured on (beta_vs, else first hedge symbol)
    pub sessions: Vec<SessionCfg>,
    pub events: Vec<EventCfg>,
    pub fee_expiry: Option<String>,
    pub alerts: AlertCfg,
    pub master: Option<AccountCfg>,
    pub accounts: Vec<AccountCfg>,
    pub engines: Vec<EngineCfg>,
}

impl Config {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Config {
            path: path.into(),
            listen: "127.0.0.1:8710".into(),
            db: PathBuf::from("desk.db"),
            simulate: false,
            day_start_min: 0,
            fair_halflife_s: 120.0,
            keep_fine_days: 7.0,
            mark_max_spread_bps: 100.0,
            keep_days: 365.0,
            mm_horizon_s: 60,
            markets: vec![],
            target_ratio: None,
            band_usd: None,
            band_frac: 0.0,
            hedge_pauses: vec![],
            hedge_symbols: vec![],
            markets_only: false,
            beta: None,
            beta_vs: None,
            sessions: vec![],
            events: vec![],
            fee_expiry: None,
            alerts: AlertCfg::default(),
            master: None,
            accounts: vec![],
            engines: vec![],
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Config::new("")
    }
}

/// "HH:MM" -> minutes. Config strings are checked by `load`; panics on a malformed one elsewhere.
pub fn hhmm(s: &str) -> i64 {
    try_hhmm(s).unwrap_or_else(|e| panic!("{e}"))
}

pub fn try_hhmm(s: &str) -> Result<i64> {
    let (h, m) = s.split_once(':').ok_or_else(|| anyhow!("bad time {s:?}, want HH:MM"))?;
    let p = |x: &str| x.trim().parse::<i64>().map_err(|_| anyhow!("bad time {s:?}, want HH:MM"));
    Ok(p(h)? * 60 + p(m)?)
}

pub fn expanduser(p: &str) -> PathBuf {
    if (p == "~" || p.starts_with("~/"))
        && let Some(home) = std::env::var_os("HOME")
    {
        return Path::new(&home).join(p.trim_start_matches('~').trim_start_matches('/'));
    }
    PathBuf::from(p)
}

pub fn load_env_file(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || !line.contains('=') {
            continue;
        }
        let (k, v) = line.strip_prefix("export ").unwrap_or(line).split_once('=').unwrap();
        let mut v = v.trim();
        let b = v.as_bytes();
        if b.len() >= 2 && b[0] == b[b.len() - 1] && (b[0] == b'"' || b[0] == b'\'') {
            v = &v[1..v.len() - 1];
        }
        let k = k.trim();
        if std::env::var_os(k).is_none() {
            // SAFETY: called while loading the config, before any other thread reads the environment.
            unsafe { std::env::set_var(k, v) };
        }
    }
}

fn empty() -> &'static Table {
    static E: std::sync::OnceLock<Table> = std::sync::OnceLock::new();
    E.get_or_init(Table::new)
}

fn table<'a>(t: &'a Table, k: &str) -> Result<&'a Table> {
    match t.get(k) {
        None => Ok(empty()),
        Some(Value::Table(x)) => Ok(x),
        Some(_) => bail!("{k}: expected a table"),
    }
}

fn array<'a>(t: &'a Table, k: &str) -> Result<&'a [Value]> {
    match t.get(k) {
        None => Ok(&[]),
        Some(Value::Array(x)) => Ok(x),
        Some(_) => bail!("{k}: expected an array"),
    }
}

fn s<'a>(t: &'a Table, k: &str, d: &'a str) -> Result<&'a str> {
    match t.get(k) {
        None => Ok(d),
        Some(Value::String(x)) => Ok(x),
        Some(_) => bail!("{k}: expected a string"),
    }
}

fn opt_s<'a>(t: &'a Table, k: &str) -> Result<Option<&'a str>> {
    t.get(k).map(|_| s(t, k, "")).transpose()
}

fn opt_f(t: &Table, k: &str) -> Result<Option<f64>> {
    match t.get(k) {
        None => Ok(None),
        Some(Value::Float(x)) => Ok(Some(*x)),
        Some(Value::Integer(x)) => Ok(Some(*x as f64)),
        Some(Value::String(x)) => x.trim().parse().map(Some).map_err(|_| anyhow!("{k}: not a number")),
        Some(_) => bail!("{k}: expected a number"),
    }
}

fn f(t: &Table, k: &str, d: f64) -> Result<f64> {
    Ok(opt_f(t, k)?.unwrap_or(d))
}

fn b(t: &Table, k: &str, d: bool) -> Result<bool> {
    match t.get(k) {
        None => Ok(d),
        Some(Value::Boolean(x)) => Ok(*x),
        Some(Value::Integer(x)) => Ok(*x != 0),
        Some(Value::String(x)) => Ok(!x.is_empty()),
        Some(_) => bail!("{k}: expected a bool"),
    }
}

fn venue(t: &Table, k: &str, d: &str) -> Result<Venue> {
    s(t, k, d)?.parse().map_err(|e: String| anyhow!(e))
}

fn sub_tables<'a>(t: &'a Table, k: &str) -> Result<Vec<&'a Table>> {
    array(t, k)?
        .iter()
        .map(|v| v.as_table().ok_or_else(|| anyhow!("{k}: expected tables")))
        .collect()
}

fn account(d: &Table, role: Role, default_id: &str) -> Result<AccountCfg> {
    let aid = s(d, "id", default_id)?;
    Ok(AccountCfg {
        id: aid.into(),
        label: s(d, "label", aid)?.into(),
        email: s(d, "email", "")?.into(),
        role,
        futures: b(d, "futures", false)?,
        api_key_env: s(d, "api_key_env", "")?.into(),
        secret_env: s(d, "secret_env", "")?.into(),
        private_key_env: s(d, "private_key_env", "")?.into(),
        show: b(d, "show", true)?,
    })
}

/// beta_vs, else the first hedge symbol (empty strings count as unset).
fn vs_symbol(exp: &Table) -> Result<Option<String>> {
    if let Some(v) = opt_s(exp, "beta_vs")?.filter(|v| !v.is_empty()) {
        return Ok(Some(v.to_uppercase()));
    }
    Ok(match array(exp, "hedge_symbols")?.first() {
        Some(Value::String(h)) if !h.is_empty() => Some(h.to_uppercase()),
        _ => None,
    })
}

fn beta(exp: &Table) -> Result<Option<BetaCfg>> {
    if s(exp, "beta", "fixed")? != "estimate" {
        return Ok(None);
    }
    let Some(vs) = vs_symbol(exp)? else {
        bail!("[exposure] beta = \"estimate\" needs beta_vs or hedge_symbols");
    };
    let venue = s(exp, "beta_vs_venue", "usdm")?;
    Ok(Some(BetaCfg {
        vs: format!("{venue}:{vs}"),
        prior: f(exp, "beta_prior", 1.0)?,
        halflife_h: f(exp, "beta_halflife_h", 8.0)?,
        prior_samples: f(exp, "beta_prior_samples", 1440.0)?,
        sample_s: f(exp, "beta_sample_s", 10.0)?,
        clip: f(exp, "beta_clip", 1.5)?,
        priors: Default::default(),
    }))
}

fn beta_vs(exp: &Table) -> Result<Option<String>> {
    Ok(vs_symbol(exp)?.map(|vs| format!("{}:{vs}", s(exp, "beta_vs_venue", "usdm").unwrap_or("usdm"))))
}

fn typed<T: serde::de::DeserializeOwned>(v: &Value, what: &str) -> Result<T> {
    v.clone().try_into().with_context(|| format!("[{what}]"))
}

/// Checks what sessions.rs would otherwise trip over at run time.
fn validate(c: &Config) -> Result<()> {
    use crate::sessions::{day_time, parse_days, zone};
    for x in &c.sessions {
        zone(&x.tz)?;
        parse_days(&x.days)?;
        try_hhmm(&x.start)?;
        try_hhmm(&x.end)?;
    }
    for x in &c.events {
        zone(&x.tz)?;
        parse_days(&x.days)?;
        try_hhmm(&x.at)?;
    }
    for x in &c.hedge_pauses {
        zone(&x.tz)?;
        day_time(&x.start)?;
        day_time(&x.end)?;
    }
    Ok(())
}

pub fn load(path: impl AsRef<Path>) -> Result<Config> {
    let p = expanduser(&path.as_ref().to_string_lossy());
    let path = std::fs::canonicalize(&p).with_context(|| format!("config {}", p.display()))?;
    let text = std::fs::read_to_string(&path).with_context(|| format!("config {}", path.display()))?;
    let raw: Table = toml::from_str(&text).with_context(|| format!("config {}", path.display()))?;
    let base = path.parent().unwrap_or(Path::new("/")).to_path_buf();
    if let Some(env_file) = opt_s(&raw, "env_file")?.filter(|e| !e.is_empty()) {
        let p = expanduser(env_file);
        load_env_file(&if p.is_absolute() { p } else { base.join(p) });
    }
    let srv = table(&raw, "server")?;
    let exp = table(&raw, "exposure")?;
    let db = expanduser(s(srv, "db", "desk.db")?);
    let mut markets = vec![];
    for m in sub_tables(&raw, "markets")? {
        let symbol = s(m, "symbol", "")?;
        if symbol.is_empty() {
            bail!("[[markets]] entry without symbol");
        }
        let reference = match m.get("reference") {
            None => None,
            Some(Value::Table(r)) => Some(Ref { symbol: s(r, "symbol", "")?.to_uppercase(), venue: venue(r, "venue", "usdm")? }),
            Some(_) => bail!("[[markets]] {symbol}: reference must be a table"),
        };
        markets.push(MarketCfg {
            symbol: symbol.to_uppercase(),
            venue: venue(m, "venue", "spot")?,
            reference,
            beta: f(m, "beta", 1.0)?,
            beta_prior: opt_f(m, "beta_prior")?,
        });
    }
    let mut beta = beta(exp)?;
    if let Some(b) = beta.as_mut() {
        b.priors = markets
            .iter()
            .filter_map(|m| m.beta_prior.map(|p| (format!("{}:{}", m.venue, m.symbol), p)))
            .collect();
    }
    let master = match raw.get("master") {
        None => None,
        Some(Value::Table(t)) => Some(account(t, Role::Master, "master")?),
        Some(_) => bail!("[master]: expected a table"),
    };
    let accounts = sub_tables(&raw, "accounts")?
        .into_iter()
        .enumerate()
        .map(|(i, a)| account(a, Role::Sub, &format!("sub-{}", i + 1)))
        .collect::<Result<_>>()?;
    let engines = sub_tables(&raw, "engines")?
        .into_iter()
        .map(|e| {
            let get = |k: &str| match e.get(k) {
                Some(Value::String(x)) => Ok(x.clone()),
                _ => Err(anyhow!("[[engines]] needs {k}")),
            };
            Ok(EngineCfg { name: get("name")?, url: get("url")? })
        })
        .collect::<Result<_>>()?;
    let c = Config {
        path: path.clone(),
        listen: s(srv, "listen", "127.0.0.1:8710")?.into(),
        db: if db.is_absolute() { db } else { base.join(db) },
        simulate: b(srv, "simulate", false)?,
        day_start_min: try_hhmm(s(srv, "day_start", "00:00")?)?,
        fair_halflife_s: f(srv, "fair_halflife_s", 120.0)?,
        keep_fine_days: f(srv, "keep_fine_days", 7.0)?,
        mark_max_spread_bps: f(srv, "mark_max_spread_bps", 100.0)?,
        keep_days: f(srv, "keep_days", 365.0)?,
        mm_horizon_s: {
            let h = f(srv, "mm_horizon_s", 60.0)? as i64;
            if !crate::fills::HK.contains(&h.to_string().as_str()) {
                bail!("mm_horizon_s: one of the markout horizons 1, 10, 60, 300");
            }
            h
        },
        markets,
        target_ratio: opt_f(exp, "target_ratio")?,
        band_usd: opt_f(exp, "band_usd")?,
        band_frac: f(exp, "band_frac", 0.0)?,
        hedge_pauses: array(exp, "pauses")?.iter().map(|w| typed(w, "exposure.pauses")).collect::<Result<_>>()?,
        hedge_symbols: array(exp, "hedge_symbols")?
            .iter()
            .map(|h| h.as_str().map(str::to_uppercase).ok_or_else(|| anyhow!("hedge_symbols: expected strings")))
            .collect::<Result<_>>()?,
        markets_only: b(exp, "markets_only", false)?,
        beta,
        beta_vs: beta_vs(exp)?,
        sessions: array(&raw, "sessions")?.iter().map(|x| typed(x, "sessions")).collect::<Result<_>>()?,
        events: array(&raw, "events")?.iter().map(|x| typed(x, "events")).collect::<Result<_>>()?,
        fee_expiry: opt_s(table(&raw, "fees")?, "expiry")?.map(String::from),
        alerts: match raw.get("alerts") {
            None => AlertCfg::default(),
            Some(v) => typed(v, "alerts")?,
        },
        master,
        accounts,
        engines,
    };
    validate(&c)?;
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beta::Betas;

    fn write(dir: &tempfile::TempDir, text: &str) -> PathBuf {
        let p = dir.path().join("d.toml");
        std::fs::write(&p, text).unwrap();
        p
    }

    #[test]
    fn master_show_flag() {
        let d = tempfile::tempdir().unwrap();
        let c = load(write(&d, "[master]\nshow = false\napi_key_env = \"X\"\n[[accounts]]\nid = \"a\"\n")).unwrap();
        assert!(!c.master.as_ref().unwrap().show && c.accounts[0].show);
        assert_eq!(c.accounts[0].label, "a");
        assert_eq!(c.master.unwrap().id, "master");
    }

    #[test]
    fn per_market_beta_prior() {
        let d = tempfile::tempdir().unwrap();
        let p = write(
            &d,
            "[exposure]\nbeta = \"estimate\"\nbeta_vs = \"XUSDT\"\nbeta_prior = 0.4\n\
             [[markets]]\nsymbol = \"AUSDT\"\n[[markets]]\nsymbol = \"BUSDT\"\nbeta_prior = -0.4\n",
        );
        let b = Betas::new(load(p).unwrap().beta.unwrap());
        assert_eq!(b.beta("spot:AUSDT"), 0.4);
        assert_eq!(b.beta("spot:BUSDT"), -0.4);
    }

    #[test]
    fn exposure_keys() {
        let d = tempfile::tempdir().unwrap();
        let c = load(write(
            &d,
            "[exposure]\ntarget_ratio = 1.0\nband_usd = 200\nband_frac = 0.25\nhedge_symbols = [\"HUSDT\"]\n\
             [[exposure.pauses]]\nname = \"hedge off\"\ntz = \"Europe/London\"\nstart = \"fri 21:00\"\nend = \"sun 21:00\"\n\
             [[markets]]\nsymbol = \"AAAUSDT\"\nbeta = 1.0\n",
        ))
        .unwrap();
        assert_eq!((c.target_ratio, c.band_usd, c.band_frac), (Some(1.0), Some(200.0), 0.25));
        assert_eq!(c.hedge_symbols, ["HUSDT"]);
        assert_eq!(c.hedge_pauses, [PauseCfg::new("hedge off", "Europe/London", "fri 21:00", "sun 21:00")]);
        assert_eq!(c.beta_vs.as_deref(), Some("usdm:HUSDT"));
        assert!(c.beta.is_none());
        assert_eq!(c.db, std::fs::canonicalize(d.path()).unwrap().join("desk.db"));
    }

    #[test]
    fn bad_keys_are_refused() {
        let d = tempfile::tempdir().unwrap();
        assert!(load(write(&d, "[alerts]\nnope = 1\n")).is_err());
        assert!(load(write(&d, "[[sessions]]\nname = \"x\"\ntz = \"Nowhere/X\"\nstart = \"08:00\"\nend = \"09:00\"\n")).is_err());
        assert!(load(write(&d, "[exposure]\nbeta = \"estimate\"\n")).is_err());
    }

    #[test]
    fn loads_repo_configs() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let c = load(root.join("desk.example.toml")).unwrap();
        assert_eq!(c.listen, "127.0.0.1:8710");
        assert_eq!(c.markets[0], MarketCfg {
            symbol: "ETHUSDT".into(),
            venue: Venue::Spot,
            reference: Some(Ref { symbol: "ETHUSDT".into(), venue: Venue::Usdm }),
            beta: 1.0,
            beta_prior: None,
        });
        assert_eq!(c.alerts, AlertCfg::default());
        assert_eq!(c.accounts.len(), 2);
        assert!(c.accounts[0].futures && !c.accounts[1].futures);
        assert_eq!(c.master.as_ref().unwrap().private_key_env, "DESK_MASTER_PRIVATE_KEY");
        assert_eq!(c.fee_expiry, None);
    }
}
