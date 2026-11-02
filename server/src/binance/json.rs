//! Reading Binance's JSON: numbers come as strings or numbers; a missing required field is an error.
use anyhow::{Result, anyhow, bail};
use serde_json::Value;

use crate::protocol::Side;

pub(super) fn get<'a>(v: &'a Value, k: &str) -> Result<&'a Value> {
    v.get(k).ok_or_else(|| anyhow!("KeyError: {k}"))
}

pub(super) fn to_f(v: &Value) -> Result<f64> {
    match v {
        Value::String(s) => s.trim().parse().map_err(|_| anyhow!("ValueError: could not convert {s:?} to float")),
        Value::Number(n) => n.as_f64().ok_or_else(|| anyhow!("ValueError: {n}")),
        Value::Bool(b) => Ok(f64::from(u8::from(*b))),
        _ => bail!("ValueError: not a number: {v}"),
    }
}

pub(super) fn to_i(v: &Value) -> Result<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|x| x as i64)).ok_or_else(|| anyhow!("ValueError: {n}")),
        Value::String(s) => s.trim().parse().map_err(|_| anyhow!("ValueError: invalid int {s:?}")),
        Value::Bool(b) => Ok(i64::from(*b)),
        _ => bail!("ValueError: not an int: {v}"),
    }
}

pub(super) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python `float(v[k])`.
pub(super) fn f(v: &Value, k: &str) -> Result<f64> {
    to_f(get(v, k)?)
}

/// Python `v.get(k) or ...`: the first truthy value among `keys`.
pub(super) fn first<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().filter_map(|k| v.get(*k)).find(|x| truthy(x))
}

/// Python `int(v.get(a) or v.get(b) or default)`.
pub(super) fn int_or(v: &Value, keys: &[&str], default: i64) -> Result<i64> {
    first(v, keys).map_or(Ok(default), to_i)
}

/// Python `float(v.get(k) or 0)`.
pub(super) fn f_or0(v: &Value, k: &str) -> Result<f64> {
    first(v, &[k]).map_or(Ok(0.0), to_f)
}

pub(super) fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    get(v, k)?.as_str().ok_or_else(|| anyhow!("{k}: not a string"))
}

/// An id as Python's `str()` / f-string shows it.
pub(super) fn id_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        other => other.to_string(),
    }
}

pub(super) fn side_of(s: &str) -> Side {
    if s.eq_ignore_ascii_case("buy") { Side::Buy } else { Side::Sell }
}
