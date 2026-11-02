//! desk.toml: accounts, markets, exposure, sessions, alerts.
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use toml::{Table, Value};

use crate::beta::BetaCfg;
use crate::market::Numeraire;
use crate::protocol::{InstRole, Role, Roles, Venue};

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
    pub role: Option<InstRole>,    // overrides [roles] for this instrument
}

impl MarketCfg {
    pub fn new(symbol: impl Into<String>, venue: Venue) -> Self {
        MarketCfg { symbol: symbol.into(), venue, reference: None, beta: 1.0, beta_prior: None, role: None }
    }
}

/// The exchange of a config that names none.
pub const DEFAULT_EXCHANGE: &str = "binance";

/// The exchange's perp market, where something says none.
pub fn perp_of(exchange: &str) -> Venue {
    Venue::of(exchange).find(|v| !v.is_spot()).unwrap_or(Venue::USDM)
}

#[derive(Debug, Clone, PartialEq)]
pub struct AccountCfg {
    pub id: String,
    pub label: String,
    pub email: String,
    pub role: Role,
    /// The connector that reads it.
    pub exchange: String,
    /// The markets it is read on, in `Venue` order: `futures = true` is the exchange's spot and perp.
    pub markets: Vec<Venue>,
    pub api_key_env: String,
    pub secret_env: String,
    pub private_key_env: String,
    /// Where reading takes no key: the environment variable holding the account's address.
    pub address_env: String,
    pub show: bool,   // false: used for transfers and sub-account reads, kept off the desk
}

impl AccountCfg {
    pub fn new(id: &str, label: &str, email: &str, role: Role) -> Self {
        AccountCfg {
            id: id.into(),
            label: label.into(),
            email: email.into(),
            role,
            exchange: DEFAULT_EXCHANGE.into(),
            markets: vec![Venue::SPOT],
            api_key_env: String::new(),
            secret_env: String::new(),
            private_key_env: String::new(),
            address_env: String::new(),
            show: true,
        }
    }

    /// It has a perp market, which is what `futures = true` said.
    pub fn futures(&self) -> bool {
        self.markets.iter().any(|v| !v.is_spot())
    }

    /// The market its positions are on.
    pub fn perp(&self) -> Venue {
        self.markets.iter().copied().find(|v| !v.is_spot()).unwrap_or_else(|| perp_of(&self.exchange))
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
    /// One spot asset's inventory value above this warns; none (the default): no per-asset cap.
    pub asset_cap_usd: Option<f64>,
    pub markout_floor_bps: f64,
    pub stale_quote_s: f64,
    pub futures_margin_min_usd: f64,
    pub drop_1h_usd: f64,
    pub quote_idle_usd: f64,
    pub quote_idle_s: f64,
    pub latency_p99_us: f64,
    /// |day PnL − Π − hedge legs| above this for 5 min: a fill, transfer or asset the desk does not see
    pub reconcile_usd: f64,
    /// exposure_gap: |gap| over the band this long (a hedge that rebalances slowly is still at work before it)
    pub gap_hold_s: f64,
    /// exposure_gap also after a minute over this many bands (0: off)
    pub gap_wide_bands: f64,
}

impl Default for AlertCfg {
    fn default() -> Self {
        AlertCfg {
            day_drawdown_usd: 100.0,
            drop_15m_usd: 40.0,
            inventory_cap_usd: 10000.0,
            asset_cap_usd: None,
            markout_floor_bps: -1.0,
            stale_quote_s: 60.0,
            futures_margin_min_usd: 100.0,
            drop_1h_usd: 100.0,
            quote_idle_usd: 10.0,
            quote_idle_s: 600.0,
            latency_p99_us: 2000.0,
            reconcile_usd: 1.0,
            gap_hold_s: 60.0,
            gap_wide_bands: 0.0,
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
    /// The name money figures carry.
    pub currency: String,
    /// What they are valued in.
    pub numeraire: Numeraire,
    /// Split Trading PnL into market making and inventory on the pages (the store keeps both either way).
    pub market_making: bool,
    pub markets: Vec<MarketCfg>,
    pub target_ratio: Option<f64>,
    pub band_usd: Option<f64>,
    pub band_frac: f64,   // band = max(band_usd, band_frac x |target|)
    pub max_notional: Option<f64>,   // the target clamped to ±this
    pub hedge_pauses: Vec<PauseCfg>,
    pub hedge_symbols: Vec<String>,
    /// What each instrument is for, from `[roles]`, `[[markets]] role` and `hedge_symbols`.
    pub roles: Roles,
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
    /// The exchanges it reads, the first's clock its own: those its accounts name, then those of markets it only watches.
    pub exchanges: Vec<String>,
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
            currency: Numeraire::default().asset,
            numeraire: Numeraire::default(),
            market_making: true,
            markets: vec![],
            target_ratio: None,
            band_usd: None,
            band_frac: 0.0,
            max_notional: None,
            hedge_pauses: vec![],
            hedge_symbols: vec![],
            roles: Roles::default(),
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
            exchanges: vec![DEFAULT_EXCHANGE.into()],
        }
    }

    /// The markets of the desk's exchanges.
    pub fn venues(&self) -> impl Iterator<Item = Venue> + '_ {
        Venue::all().filter(|v| self.exchanges.iter().any(|e| v.on(e)))
    }

    /// The asset the desk's cash is quoted in: its first exchange's.
    pub fn quote(&self) -> &'static str {
        first_quote(&self.exchanges)
    }
}

impl Default for Config {
    fn default() -> Self {
        Config::new("")
    }
}

/// The first exchange's quote.
fn first_quote(exchanges: &[String]) -> &'static str {
    exchanges.first().and_then(|e| Venue::of(e).next()).map_or(Venue::SPOT.market().quote, |v| v.market().quote)
}

/// `[desk] currency` as the name on figures and what they are valued in. Unset, or "USD", which no market lists, is the
/// first exchange's quote; any other is an asset, and everything is converted to it. A desk on Binance alone that names
/// none keeps what it has always done (`Numeraire::par`).
fn numeraire(currency: Option<&str>, exchanges: &[String]) -> Result<(String, Numeraire)> {
    let quote = first_quote(exchanges);
    if let Some(c) = currency
        && (c.is_empty() || !c.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
    {
        bail!("desk.currency: {c:?} is not an asset's name: capitals, as a market lists it (USDT, USDC, EUR, BTC)");
    }
    let named = currency.is_some_and(|c| c != "USD");
    let binance_alone = exchanges.iter().all(|e| e.eq_ignore_ascii_case(DEFAULT_EXCHANGE));
    let asset = currency.filter(|_| named).unwrap_or(quote);
    Ok((currency.unwrap_or(quote).to_string(), Numeraire { asset: asset.to_string(), par: binance_alone && !named }))
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

/// An account's markets: `markets`, or `futures` as it always read. Both must agree, and they are the exchange's.
fn account_markets(d: &Table, aid: &str, exchange: &str) -> Result<Vec<Venue>> {
    let futures = b(d, "futures", false)?;
    let mut markets = vec![Venue::of(exchange).find(|v| v.is_spot()).unwrap_or(Venue::SPOT)];
    if d.contains_key("markets") {
        markets = array(d, "markets")?
            .iter()
            .map(|v| v.as_str().ok_or_else(|| anyhow!("account {aid}: markets: expected strings"))?.parse().map_err(|e: String| anyhow!("account {aid}: {e}")))
            .collect::<Result<_>>()?;
        markets.sort();
        markets.dedup();
        if d.contains_key("futures") && futures != markets.iter().any(|v| !v.is_spot()) {
            bail!("account {aid}: futures = {futures} and markets = {markets:?} say different things");
        }
        if let Some(w) = Venue::of(exchange).find(|v| v.market().wallet)
            && !markets.contains(&w)
        {
            bail!("account {aid}: markets need its {w} market: the account's balances are read there");
        }
    } else if Venue::of(exchange).any(|v| v.market().wallet) {
        if futures {
            markets.push(perp_of(exchange));
        }
    } else {
        markets = Venue::of(exchange).collect();
    }
    if let Some(v) = markets.iter().find(|v| !v.on(exchange)) {
        bail!("account {aid}: market {v} is not on exchange {exchange:?}");
    }
    Ok(markets)
}

fn account(d: &Table, role: Role, default_id: &str) -> Result<AccountCfg> {
    let aid = s(d, "id", default_id)?;
    let exchange = s(d, "exchange", DEFAULT_EXCHANGE)?;
    if Venue::of(exchange).next().is_none() {
        bail!("account {aid}: no connector for exchange {exchange:?}");
    }
    let keyless = Venue::of(exchange).any(|v| v.market().keyless);
    if keyless {
        // a desk that reads never holds what could trade
        if let Some(k) = ["api_key_env", "secret_env", "private_key_env"].iter().find(|k| d.contains_key(**k)) {
            bail!("account {aid}: {k}: reading an account on {exchange} takes its address (address_env) and no key, so this desk will not take one");
        }
        if role == Role::Master {
            bail!("[master]: {exchange} has no master account to read others through: each is an [[accounts]] entry of its own");
        }
    } else if d.contains_key("address_env") {
        bail!("account {aid}: address_env: {exchange} reads an account with a key");
    }
    Ok(AccountCfg {
        id: aid.into(),
        label: s(d, "label", aid)?.into(),
        email: s(d, "email", "")?.into(),
        role,
        markets: account_markets(d, aid, exchange)?,
        exchange: exchange.into(),
        api_key_env: s(d, "api_key_env", "")?.into(),
        secret_env: s(d, "secret_env", "")?.into(),
        private_key_env: s(d, "private_key_env", "")?.into(),
        address_env: s(d, "address_env", "")?.into(),
        show: b(d, "show", true)?,
    })
}

/// `[roles]`, then `[[markets]] role`, then `hedge_symbols`: a perp named there hedges whatever its market's default.
fn roles(t: &Table, markets: &[MarketCfg], hedge_symbols: &[String], exchanges: &[String]) -> Result<Roles> {
    let mut out = Roles::default();
    for (k, v) in t {
        let venue: Venue = k.parse().map_err(|e: String| anyhow!("[roles] {e}"))?;
        let role = v.as_str().ok_or_else(|| anyhow!("[roles] {k}: expected \"traded\" or \"hedge\""))?;
        out.set_market(venue, role.parse().map_err(|e: String| anyhow!("[roles] {k}: {e}"))?);
    }
    for m in markets {
        if let Some(role) = m.role
            && out.set(&m.symbol, m.venue, role).is_some_and(|r| r != role)
        {
            bail!("[[markets]] {}: two roles on {}{}", m.symbol, m.venue, if m.venue.is_spot() { ": a spot balance has one, whichever pair it trades on" } else { "" });
        }
    }
    for sym in hedge_symbols {
        for venue in Venue::all().filter(|v| !v.is_spot() && exchanges.iter().any(|e| v.on(e))) {
            if markets.iter().any(|m| m.symbol == *sym && m.venue == venue && m.role == Some(InstRole::Traded)) {
                bail!("[[markets]] {sym}: role = \"traded\", and [exposure] hedge_symbols names it");
            }
            out.set(sym, venue, InstRole::Hedge);
        }
    }
    Ok(out)
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

fn beta(exp: &Table, first_exchange: &str) -> Result<Option<BetaCfg>> {
    if s(exp, "beta", "fixed")? != "estimate" {
        return Ok(None);
    }
    let Some(vs) = vs_symbol(exp)? else {
        bail!("[exposure] beta = \"estimate\" needs beta_vs or hedge_symbols");
    };
    let venue = beta_venue(exp, first_exchange)?;
    let sample_s = f(exp, "beta_sample_s", 10.0)?;
    Ok(Some(BetaCfg {
        vs: format!("{venue}:{vs}"),
        prior: f(exp, "beta_prior", 1.0)?,
        halflife_h: f(exp, "beta_halflife_h", 8.0)?,
        prior_samples: f(exp, "beta_prior_samples", 1440.0)?,
        sample_s,
        horizon_s: opt_f(exp, "beta_horizon_s")?.unwrap_or(sample_s),   // one sample: non-overlapping returns
        clip: f(exp, "beta_clip", 1.5)?,
        priors: Default::default(),
    }))
}

/// beta_vs_venue as instrument keys name it: an alias reads as its market. Unset, the desk's first exchange's perps.
fn beta_venue<'a>(exp: &'a Table, first_exchange: &str) -> Result<&'a str> {
    let v = s(exp, "beta_vs_venue", perp_of(first_exchange).as_str())?;
    Ok(match v.parse::<Venue>() {
        Ok(venue) => venue.as_str(),
        Err(_) => v,
    })
}

fn beta_vs(exp: &Table, first_exchange: &str) -> Result<Option<String>> {
    Ok(vs_symbol(exp)?.map(|vs| format!("{}:{vs}", beta_venue(exp, first_exchange).unwrap_or(perp_of(first_exchange).as_str()))))
}

fn typed<T: serde::de::DeserializeOwned>(v: &Value, what: &str) -> Result<T> {
    v.clone().try_into().with_context(|| format!("[{what}]"))
}

/// What the desk reads: the exchanges its accounts name, in order, then those of the markets it is told to watch. A desk
/// that names nothing reads the default one.
fn exchanges_of<'a>(accounts: impl Iterator<Item = &'a AccountCfg>, markets: &[MarketCfg], exp: &Table) -> Result<Vec<String>> {
    let mut out: Vec<String> = vec![];
    let mut add = |e: String| {
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&e)) {
            out.push(e);
        }
    };
    for a in accounts {
        add(a.exchange.to_lowercase());
    }
    for m in markets {
        add(m.venue.exchange());
        if let Some(r) = &m.reference {
            add(r.venue.exchange());
        }
    }
    if let Some(v) = opt_s(exp, "beta_vs_venue")?.and_then(|v| v.parse::<Venue>().ok()) {
        add(v.exchange());
    }
    if out.is_empty() {
        out.push(DEFAULT_EXCHANGE.into());
    }
    Ok(out)
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
        let own = venue(m, "venue", "spot")?;
        let reference = match m.get("reference") {
            None => None,
            // unset, the perp market of its own exchange
            Some(Value::Table(r)) => Some(Ref { symbol: s(r, "symbol", "")?.to_uppercase(), venue: venue(r, "venue", perp_of(&own.exchange()).as_str())? }),
            Some(_) => bail!("[[markets]] {symbol}: reference must be a table"),
        };
        markets.push(MarketCfg {
            symbol: symbol.to_uppercase(),
            venue: own,
            reference,
            beta: f(m, "beta", 1.0)?,
            beta_prior: opt_f(m, "beta_prior")?,
            role: opt_s(m, "role")?.map(|r| r.parse().map_err(|e: String| anyhow!("[[markets]] {symbol}: {e}"))).transpose()?,
        });
    }
    let hedge_symbols: Vec<String> = array(exp, "hedge_symbols")?
        .iter()
        .map(|h| h.as_str().map(str::to_uppercase).ok_or_else(|| anyhow!("hedge_symbols: expected strings")))
        .collect::<Result<_>>()?;
    let master = match raw.get("master") {
        None => None,
        Some(Value::Table(t)) => Some(account(t, Role::Master, "master")?),
        Some(_) => bail!("[master]: expected a table"),
    };
    let accounts: Vec<AccountCfg> = sub_tables(&raw, "accounts")?
        .into_iter()
        .enumerate()
        .map(|(i, a)| account(a, Role::Sub, &format!("sub-{}", i + 1)))
        .collect::<Result<_>>()?;
    let exchanges = exchanges_of(master.iter().chain(&accounts), &markets, exp)?;
    let roles = roles(table(&raw, "roles")?, &markets, &hedge_symbols, &exchanges)?;
    let mut beta = beta(exp, &exchanges[0])?;
    if let Some(b) = beta.as_mut() {
        b.priors = markets
            .iter()
            .filter_map(|m| m.beta_prior.map(|p| (format!("{}:{}", m.venue, m.symbol), p)))
            .collect();
    }
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
    let (currency, numeraire) = numeraire(opt_s(table(&raw, "desk")?, "currency")?, &exchanges)?;
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
        max_notional: opt_f(exp, "max_notional")?.filter(|x| *x > 0.0),
        hedge_pauses: array(exp, "pauses")?.iter().map(|w| typed(w, "exposure.pauses")).collect::<Result<_>>()?,
        hedge_symbols,
        roles,
        markets_only: b(exp, "markets_only", false)?,
        beta,
        beta_vs: beta_vs(exp, &exchanges[0])?,
        sessions: array(&raw, "sessions")?.iter().map(|x| typed(x, "sessions")).collect::<Result<_>>()?,
        events: array(&raw, "events")?.iter().map(|x| typed(x, "events")).collect::<Result<_>>()?,
        currency,
        numeraire,
        market_making: b(table(&raw, "desk")?, "market_making", true)?,
        fee_expiry: opt_s(table(&raw, "fees")?, "expiry")?.map(String::from),
        alerts: match raw.get("alerts") {
            None => AlertCfg::default(),
            Some(v) => typed(v, "alerts")?,
        },
        master,
        accounts,
        engines,
        exchanges,
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
    fn a_market_goes_by_its_alias_too() {
        let d = tempfile::tempdir().unwrap();
        let c = load(write(
            &d,
            "[exposure]\nbeta_vs = \"HUSDT\"\nbeta_vs_venue = \"binance:usdm\"\n\
             [[markets]]\nsymbol = \"AUSDT\"\nvenue = \"binance:spot\"\nreference = { symbol = \"AUSDT\", venue = \"binance:usdm\" }\n",
        ))
        .unwrap();
        assert_eq!((c.markets[0].venue, c.markets[0].reference.as_ref().unwrap().venue), (Venue::SPOT, Venue::USDM));
        assert_eq!(c.beta_vs.as_deref(), Some("usdm:HUSDT"));
        assert!(load(write(&d, "[[markets]]\nsymbol = \"AUSDT\"\nvenue = \"coinm\"\n")).is_err());
    }

    #[test]
    fn an_accounts_markets_and_exchange() {
        let d = tempfile::tempdir().unwrap();
        let one = |t: &str| load(write(&d, &format!("[[accounts]]\nid = \"a\"\n{t}\n")));
        // markets say what futures = true says, whichever the names and order
        for t in ["futures = true", "markets = [\"usdm\", \"spot\"]", "markets = [\"binance:spot\", \"binance:usdm\"]",
                  "exchange = \"binance\"\nfutures = true\nmarkets = [\"spot\", \"usdm\"]"] {
            let c = one(t).unwrap();
            assert_eq!((c.accounts[0].markets.as_slice(), c.accounts[0].perp()), ([Venue::SPOT, Venue::USDM].as_slice(), Venue::USDM), "{t}");
        }
        assert_eq!(one("markets = [\"spot\"]").unwrap().accounts[0].markets, [Venue::SPOT]);
        assert!(one("futures = false\nmarkets = [\"spot\", \"usdm\"]").unwrap_err().to_string().contains("different things"));
        assert!(one("markets = [\"usdm\"]").unwrap_err().to_string().contains("spot market"));
        assert!(one("markets = [\"coinm\"]").is_err());
        assert!(one("exchange = \"elsewhere\"").unwrap_err().to_string().contains("no connector"));
    }

    #[test]
    fn a_desk_on_hyperliquid_alone_or_beside_binance() {
        let d = tempfile::tempdir().unwrap();
        let hl = "exchange = \"hyperliquid\"\naddress_env = \"X\"";
        // every market of the exchange by default, a perp alone if said: no spot market is needed to read balances
        let c = load(write(&d, &format!("[[accounts]]\nid = \"h\"\n{hl}\n"))).unwrap();
        assert_eq!((c.accounts[0].markets.as_slice(), c.exchanges.as_slice()), ([Venue::HL, Venue::HL_SPOT].as_slice(), ["hyperliquid".to_string()].as_slice()));
        assert_eq!((c.accounts[0].perp(), c.quote(), c.currency.as_str()), (Venue::HL, "USDC", "USDC"));
        let c = load(write(&d, &format!("[[accounts]]\nid = \"h\"\n{hl}\nmarkets = [\"hl\"]\n"))).unwrap();
        assert_eq!(c.accounts[0].markets, [Venue::HL]);
        assert_eq!(load(write(&d, &format!("[[accounts]]\nid = \"h\"\n{hl}\nmarkets = [\"hlspot\"]\n"))).unwrap().accounts[0].perp(), Venue::HL);
        assert!(load(write(&d, &format!("[[accounts]]\nid = \"h\"\n{hl}\nmarkets = [\"usdm\"]\n"))).unwrap_err().to_string().contains("not on exchange"));
        // beside Binance: the first account's exchange leads, and a market it only watches brings its exchange
        let c = load(write(&d, &format!("[[accounts]]\nid = \"b\"\nfutures = true\n[[accounts]]\nid = \"h\"\n{hl}\n"))).unwrap();
        assert_eq!(c.exchanges, ["binance", "hyperliquid"]);
        assert_eq!(c.venues().collect::<Vec<_>>(), [Venue::SPOT, Venue::USDM, Venue::HL, Venue::HL_SPOT]);
        assert_eq!((c.quote(), c.currency.as_str()), ("USDT", "USDT"));
        let c = load(write(&d, "[[markets]]\nsymbol = \"BTC\"\nvenue = \"hl\"\n")).unwrap();
        assert_eq!(c.exchanges, ["hyperliquid"]);
        let c = load(write(&d, "[[accounts]]\nid = \"b\"\n[[markets]]\nsymbol = \"BTC\"\nvenue = \"hl\"\n")).unwrap();
        assert_eq!(c.exchanges, ["binance", "hyperliquid"]);
        // a reference names its own exchange's perps by default; hedge_symbols reach this desk's markets and no others
        let c = load(write(&d, "[exposure]\nhedge_symbols = [\"BTC\"]\n[[markets]]\nsymbol = \"HYPEUSDC\"\nvenue = \"hlspot\"\nreference = { symbol = \"HYPE\" }\n")).unwrap();
        assert_eq!(c.markets[0].reference.as_ref().unwrap().venue, Venue::HL);
        assert_eq!(c.beta_vs.as_deref(), Some("hl:BTC"));
        assert_eq!(serde_json::to_value(&c.roles).unwrap()["instruments"], serde_json::json!({"hl:BTC": "hedge"}));
        // a role on any exchange's spot is its base asset's
        let c = load(write(&d, "[[markets]]\nsymbol = \"HYPEUSDC\"\nvenue = \"hlspot\"\nrole = \"hedge\"\n")).unwrap();
        assert_eq!((c.roles.asset("HYPE"), c.roles.asset("BTC")), (InstRole::Hedge, InstRole::Traded));
        let c = load(write(&d, "[exposure]\nhedge_symbols = [\"AUSDT\"]\n")).unwrap();
        assert_eq!(serde_json::to_value(&c.roles).unwrap()["instruments"], serde_json::json!({"usdm:AUSDT": "hedge"}));
    }

    #[test]
    fn hyperliquid_refuses_a_key_outright() {
        let d = tempfile::tempdir().unwrap();
        let one = |t: &str| load(write(&d, t)).unwrap_err().to_string();
        for k in ["api_key_env", "secret_env", "private_key_env"] {
            let e = one(&format!("[[accounts]]\nid = \"h\"\nexchange = \"hyperliquid\"\n{k} = \"X\"\n"));
            assert!(e.contains("no key"), "{k}: {e}");
        }
        assert!(one("[master]\nexchange = \"hyperliquid\"\n").contains("no master"));
        assert!(one("[[accounts]]\nid = \"b\"\naddress_env = \"X\"\n").contains("reads an account with a key"));
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
            venue: Venue::SPOT,
            reference: Some(Ref { symbol: "ETHUSDT".into(), venue: Venue::USDM }),
            beta: 1.0,
            beta_prior: None,
            role: None,
        });
        assert_eq!(c.roles, Roles::default());
        assert_eq!(c.alerts, AlertCfg::default());
        assert_eq!(c.accounts.len(), 2);
        assert!(c.accounts[0].futures() && !c.accounts[1].futures());
        assert_eq!(c.accounts[0].markets, [Venue::SPOT, Venue::USDM]);
        assert_eq!(c.accounts[1].markets, [Venue::SPOT]);
        assert_eq!(c.exchanges, ["binance"]);
        assert_eq!(c.master.as_ref().unwrap().private_key_env, "DESK_MASTER_PRIVATE_KEY");
        assert_eq!(c.fee_expiry, None);
        assert_eq!((c.currency.as_str(), c.market_making), ("USDT", true));
    }

    #[test]
    fn an_instruments_role_is_its_own_then_its_markets_then_its_kinds() {
        let one = |body: &str| {
            let dir = tempfile_dir("roles");
            let p = dir.join("desk.toml");
            std::fs::write(&p, body).unwrap();
            load(&p)
        };
        use crate::protocol::InstRole::{Hedge, Traded};
        // nothing set: spot is traded, a perp hedges
        let r = one("").unwrap().roles;
        assert_eq!(r, Roles::default());
        assert_eq!((r.of("BTCUSDT", Venue::SPOT), r.of("BTCUSDT", Venue::USDM)), (Traded, Hedge));
        // a desk that makes markets on perps and hedges with one of them and a spot asset
        let c = one(r#"
            [roles]
            usdm = "traded"
            [exposure]
            hedge_symbols = ["BTCUSDT"]
            [[markets]]
            symbol = "ETHUSDT"
            venue = "usdm"
            role = "hedge"
            [[markets]]
            symbol = "SOLUSDT"
            role = "hedge"
        "#).unwrap();
        let r = &c.roles;
        assert_eq!(r.of("XRPUSDT", Venue::USDM), Traded);
        assert_eq!(r.of("BTCUSDT", Venue::USDM), Hedge);
        assert_eq!(r.of("ETHUSDT", Venue::USDM), Hedge);
        assert_eq!(r.of("BTCUSDT", Venue::SPOT), Traded);
        assert_eq!((r.of("SOLUSDT", Venue::SPOT), r.of("SOLUSDC", Venue::SPOT), r.asset("SOL")), (Hedge, Hedge, Hedge));
        assert_eq!(serde_json::to_value(r).unwrap(), serde_json::json!({
            "markets": {"usdm": "traded"},
            "instruments": {"usdm:BTCUSDT": "hedge", "usdm:ETHUSDT": "hedge", "spot:SOL": "hedge"},
        }));
        // an alias names the market; hedge_symbols says what it always did for a desk with no [roles]
        assert_eq!(one("[roles]\n\"binance:usdm\" = \"traded\"").unwrap().roles.market(Venue::USDM), Traded);
        // what cannot be meant
        for (body, want) in [
            ("[roles]\nusdm = \"maker\"", "bad role"),
            ("[roles]\nnope = \"traded\"", "bad Venue"),
            ("[roles]\nusdm = 1", "expected"),
            ("[[markets]]\nsymbol = \"AUSDT\"\nrole = \"x\"", "bad role"),
            ("[[markets]]\nsymbol = \"AUSDT\"\nvenue = \"usdm\"\nrole = \"traded\"\n[exposure]\nhedge_symbols = [\"AUSDT\"]", "hedge_symbols"),
            ("[[markets]]\nsymbol = \"AUSDT\"\nrole = \"traded\"\n[[markets]]\nsymbol = \"AUSDC\"\nrole = \"hedge\"", "two roles"),
        ] {
            let e = format!("{:#}", one(body).unwrap_err());
            assert!(e.contains(want), "{body}: {e}");
        }
    }

    #[test]
    fn a_currency_is_what_figures_are_valued_in() {
        let d = tempfile::tempdir().unwrap();
        let num = |text: &str| load(write(&d, text)).map(|c| (c.currency.clone(), c.numeraire.asset.clone(), c.numeraire.par));
        // named by nothing, or by USD which no market lists: the first exchange's quote, as a desk on Binance has it
        assert_eq!(num("").unwrap(), ("USDT".to_string(), "USDT".to_string(), true));
        assert_eq!(num("[desk]\ncurrency = \"USD\"\nmarket_making = false\n").unwrap(), ("USD".to_string(), "USDT".to_string(), true));
        // an asset is an asset, whichever
        assert_eq!(num("[desk]\ncurrency = \"USDT\"\n").unwrap(), ("USDT".to_string(), "USDT".to_string(), false));
        assert_eq!(num("[desk]\ncurrency = \"EUR\"\n").unwrap(), ("EUR".to_string(), "EUR".to_string(), false));
        // beside another exchange nothing is at par
        let hl = "[[accounts]]\nid = \"h\"\nexchange = \"hyperliquid\"\naddress_env = \"X\"\n";
        assert_eq!(num(hl).unwrap(), ("USDC".to_string(), "USDC".to_string(), false));
        assert_eq!(num(&format!("[[accounts]]\nid = \"b\"\napi_key_env = \"Y\"\n{hl}")).unwrap(), ("USDT".to_string(), "USDT".to_string(), false));
        assert!(num("[desk]\ncurrency = \"eur\"\n").unwrap_err().to_string().contains("not an asset"));
    }

    fn tempfile_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("desk-config-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
