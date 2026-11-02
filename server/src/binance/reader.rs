//! An account read once with its own key, for `desk repair-day`.
use futures_util::FutureExt;
use serde_json::Value;

use crate::connector::{AccountReader, Balances, PerpTrade, Reply};
use crate::params;

use super::json::{f, to_i};
use super::rest::{Params, Rest};

pub struct Reader(pub Rest);

fn time_of(x: &Value, k: &str) -> anyhow::Result<i64> {
    to_i(x.get(k).ok_or_else(|| anyhow::anyhow!("no {k}"))?)
}

impl AccountReader for Reader {
    fn balances(&self) -> Reply<'_, Balances> {
        async move {
            let r: Value = self.0.get("/api/v3/account", &params! {"omitZeroBalances" => "true"}, 20, true).await?;
            let mut rows = vec![];
            for b in r.get("balances").and_then(Value::as_array).into_iter().flatten() {
                let a = b.get("asset").and_then(Value::as_str).unwrap_or_default().to_string();
                rows.push((a, f(b, "free")? + f(b, "locked")?));
            }
            Ok(Balances { updated: r.get("updateTime").and_then(Value::as_i64), rows })
        }
        .boxed_local()
    }

    fn perp_positions(&self) -> Reply<'_, Vec<(String, f64)>> {
        async move {
            let r: Value = self.0.get("/fapi/v3/positionRisk", &[], 5, true).await?;
            let mut out = vec![];
            for p in r.as_array().into_iter().flatten() {
                out.push((p.get("symbol").and_then(Value::as_str).unwrap_or_default().to_string(), f(p, "positionAmt")?));
            }
            Ok(out)
        }
        .boxed_local()
    }

    fn perp_trades<'a>(&'a self, symbol: &'a str, from: i64) -> Reply<'a, Vec<PerpTrade>> {
        async move {
            let mut out = vec![];
            let mut frm: Option<i64> = None;
            loop {
                let mut q: Params = params! {"symbol" => symbol, "limit" => 1000};
                match frm {
                    Some(id) => q.push(("fromId".into(), id.to_string())),
                    None => q.push(("startTime".into(), from.to_string())),
                }
                let rows: Value = self.0.get("/fapi/v1/userTrades", &q, 5, true).await?;
                let rows = rows.as_array().cloned().unwrap_or_default();
                for x in &rows {
                    let qty = f(x, "qty")?;
                    out.push(PerpTrade {
                        ts: time_of(x, "time")?,
                        sq: if x.get("side").and_then(Value::as_str) == Some("BUY") { qty } else { -qty },
                        price: f(x, "price")?,
                        fee: f(x, "commission")?,
                        fee_asset: x.get("commissionAsset").and_then(Value::as_str).unwrap_or("USDT").to_string(),
                    });
                }
                match rows.last() {
                    Some(l) if rows.len() >= 1000 => frm = Some(time_of(l, "id")? + 1),
                    _ => break,
                }
            }
            Ok(out)
        }
        .boxed_local()
    }

    fn perp_funding<'a>(&'a self, symbol: &'a str, from: i64, to: i64) -> Reply<'a, Vec<(i64, f64)>> {
        async move {
            let q = params! {"symbol" => symbol, "incomeType" => "FUNDING_FEE", "startTime" => from, "endTime" => to, "limit" => 1000};
            let rows: Value = self.0.get("/fapi/v1/income", &q, 30, true).await?;
            let mut out = vec![];
            for x in rows.as_array().into_iter().flatten() {
                out.push((time_of(x, "time")?, f(x, "income")?));
            }
            Ok(out)
        }
        .boxed_local()
    }
}
