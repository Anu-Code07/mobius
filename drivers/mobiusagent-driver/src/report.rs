//! Performance report: the data model shared by Android and iOS, budgets, and a self-contained HTML rendering.

use serde_json::{json, Value};

/// One sample during the session.
pub struct Sample { pub t_ms: u64, pub cpu: Option<f64>, pub mem_mb: Option<f64>, pub threads: Option<u64> }

pub fn summarize(samples: &[Sample]) -> Value {
    let stat = |v: Vec<f64>| -> Value {
        if v.is_empty() { return Value::Null; }
        let mut s = v.clone();
        s.retain(|v| v.is_finite()); // a NaN sample from the device must not panic the server
        if s.is_empty() { return Value::Null; }
        s.sort_by(f64::total_cmp);
        let avg = s.iter().sum::<f64>() / s.len() as f64;
        let p = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
        json!({ "avg": r1(avg), "p90": r1(p(0.9)), "max": r1(*s.last().unwrap()), "min": r1(s[0]) })
    };
    let mem: Vec<f64> = samples.iter().filter_map(|s| s.mem_mb).collect();
    // Memory trend: MB per minute from a least-squares fit (a steady climb hints at a leak).
    let trend = {
        let pts: Vec<(f64, f64)> = samples.iter().filter_map(|s| s.mem_mb.map(|m| (s.t_ms as f64 / 60_000.0, m))).collect();
        if pts.len() < 3 { Value::Null } else {
            let n = pts.len() as f64;
            let (sx, sy) = (pts.iter().map(|p| p.0).sum::<f64>(), pts.iter().map(|p| p.1).sum::<f64>());
            let sxy = pts.iter().map(|p| p.0 * p.1).sum::<f64>();
            let sxx = pts.iter().map(|p| p.0 * p.0).sum::<f64>();
            let d = n * sxx - sx * sx;
            if d.abs() < 1e-9 { Value::Null } else { json!(r1((n * sxy - sx * sy) / d)) }
        }
    };
    json!({
        "cpu_percent": stat(samples.iter().filter_map(|s| s.cpu).collect()),
        "memory_mb": stat(mem),
        "memory_trend_mb_per_min": trend,
        "threads_max": samples.iter().filter_map(|s| s.threads).max(),
        "samples": samples.len(),
    })
}

pub fn r1(v: f64) -> f64 { (v * 10.0).round() / 10.0 }

/// Budgets like {"launch_cold_ms": 2000, "jank_percent": 5, "cpu_avg": 40, "memory_max_mb": 400}: pass/fail per metric.
pub fn check_budgets(report: &Value, budgets: &Value) -> Value {
    let get = |path: &[&str]| path.iter().try_fold(report, |v, k| v.get(*k)).and_then(|v| v.as_f64());
    let mut out = vec![];
    for (k, limit) in budgets.as_object().into_iter().flatten() {
        let Some(limit) = limit.as_f64() else { continue };
        let actual = match k.as_str() {
            "launch_cold_ms" => get(&["launch", "cold_ms"]),
            "launch_warm_ms" => get(&["launch", "warm_ms"]),
            "jank_percent" => get(&["frames", "janky_percent"]),
            "cpu_avg" => get(&["summary", "cpu_percent", "avg"]),
            "cpu_max" => get(&["summary", "cpu_percent", "max"]),
            "memory_max_mb" => get(&["summary", "memory_mb", "max"]),
            "memory_trend_mb_per_min" => get(&["summary", "memory_trend_mb_per_min"]),
            "crashes" => report.get("crashes").and_then(|c| c.as_array()).map(|a| a.len() as f64),
            _ => None,
        };
        out.push(json!({ "metric": k, "limit": limit, "actual": actual, "pass": actual.is_some_and(|a| a <= limit) }));
    }
    let pass = out.iter().all(|b| b["pass"] == true);
    json!({ "pass": pass, "checks": out })
}

fn chart(title: &str, unit: &str, pts: &[(f64, f64)], color: &str) -> String {
    if pts.len() < 2 { return String::new(); }
    let (w, h) = (640.0, 160.0);
    let tmax = pts.last().unwrap().0.max(1.0);
    let vmax = pts.iter().map(|p| p.1).fold(0.0_f64, f64::max).max(1.0) * 1.15;
    let path: Vec<String> = pts.iter().map(|(t, v)| format!("{:.1},{:.1}", t / tmax * w, h - v / vmax * h)).collect();
    format!(r#"<figure><figcaption>{title} <span>max {:.1} {unit}</span></figcaption>
<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none"><polyline points="{}" fill="none" stroke="{color}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></figure>"#,
        pts.iter().map(|p| p.1).fold(0.0_f64, f64::max), path.join(" "))
}

pub fn html(report: &Value, samples: &[Sample]) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let cpu: Vec<(f64, f64)> = samples.iter().filter_map(|s| s.cpu.map(|c| (s.t_ms as f64 / 1000.0, c))).collect();
    let mem: Vec<(f64, f64)> = samples.iter().filter_map(|s| s.mem_mb.map(|m| (s.t_ms as f64 / 1000.0, m))).collect();
    let row = |k: &str, v: &Value| format!("<tr><th>{}</th><td>{}</td></tr>", esc(k), esc(&match v { Value::String(s) => s.clone(), Value::Null => "–".into(), o => o.to_string() }));
    let mut rows = String::new();
    for (section, v) in [("Launch", &report["launch"]), ("Frames", &report["frames"]), ("Summary", &report["summary"]), ("Device", &report["device"])] {
        if let Some(o) = v.as_object() {
            rows.push_str(&format!("<tr class=s><th colspan=2>{section}</th></tr>"));
            for (k, val) in o { rows.push_str(&row(k, val)); }
        }
    }
    let budgets = report.get("budgets").and_then(|b| b["checks"].as_array()).map(|cs| cs.iter().map(|c| format!(
        "<li class={}>{} <b>{}</b> (limit {})</li>", if c["pass"] == true { "ok" } else { "bad" }, esc(c["metric"].as_str().unwrap_or("")), c["actual"], c["limit"])).collect::<String>()).unwrap_or_default();
    let crashes = report["crashes"].as_array().map(|a| a.iter().map(|c| format!("<li>{}</li>", esc(&c.to_string()))).collect::<String>()).unwrap_or_default();
    format!(r#"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Mobius performance report</title>
<style>:root{{--bg:#0b0d1a;--fg:#e8e9f3;--mut:#9aa0c3;--card:#151833;--ok:#34d399;--bad:#f87171}}
body{{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}}main{{max-width:760px;margin:0 auto;padding:24px 16px}}
h1{{font-size:22px;margin:0}}.sub{{color:var(--mut);margin:4px 0 20px}}figure{{background:var(--card);border-radius:12px;padding:12px 14px;margin:0 0 14px}}
figcaption{{display:flex;justify-content:space-between;color:var(--mut);font-size:13px;margin-bottom:6px}}svg{{width:100%;height:160px}}
table{{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden}}th,td{{text-align:left;padding:7px 12px;border-bottom:1px solid #22264a;font-weight:400}}
th{{color:var(--mut);width:45%}}tr.s th{{color:var(--fg);font-weight:600;background:#1c2042}}ul{{padding-left:18px}}li.ok{{color:var(--ok)}}li.bad{{color:var(--bad)}}
.verdict{{display:inline-block;padding:4px 10px;border-radius:999px;font-weight:600;margin-bottom:14px}}</style></head><body><main>
<h1>Performance report: {app}</h1><p class=sub>{platform} · {device} · {secs} s session · Mobius</p>
{verdict}{budgets_html}{cpu}{mem}<table>{rows}</table>{crash_html}</main></body></html>"#,
        app = esc(report["app"].as_str().unwrap_or("")), platform = esc(report["platform"].as_str().unwrap_or("")),
        device = esc(report["device"]["model"].as_str().unwrap_or("")), secs = report["seconds"],
        verdict = match report.get("budgets") { Some(b) if b["pass"] == true => "<span class=verdict style='background:#064e3b'>Within budget</span>".to_string(),
            Some(_) => "<span class=verdict style='background:#7f1d1d'>Over budget</span>".to_string(), None => String::new() },
        budgets_html = if budgets.is_empty() { String::new() } else { format!("<ul>{budgets}</ul>") },
        cpu = chart("CPU", "%", &cpu, "#818cf8"), mem = chart("Memory", "MB", &mem, "#34d399"),
        crash_html = if crashes.is_empty() { "<p class=sub>No crashes during the session.</p>".into() } else { format!("<h2>Crashes</h2><ul>{crashes}</ul>") })
}
