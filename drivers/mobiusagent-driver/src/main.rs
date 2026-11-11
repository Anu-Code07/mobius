//! mobiusagent-driver: drives Android devices for Mobius over stock adb. One request per stdin line, one response per stdout line.
//!
//!   {"id":1,"op":"devices"}
//!   {"id":2,"op":"dump","device":"emulator-5554"}
//!   {"id":3,"op":"tap","device":"…","x":540,"y":1000,"mode":"single|long|double"}
//!   {"id":4,"op":"swipe","device":"…","x1":540,"y1":1500,"x2":540,"y2":800,"ms":300}
//!   {"id":5,"op":"text","device":"…","text":"hello","submit":false}
//!   {"id":6,"op":"key","device":"…","key":"back|home|recents|enter"}
//!   {"id":7,"op":"launch","device":"…","app":"com.android.settings"}
//!   {"id":8,"op":"url","device":"…","url":"https://…"}
//!   {"id":9,"op":"apps","device":"…"}
//!   {"id":10,"op":"screenshot","device":"…","max":768} → {"data": base64, "mimeType": "image/jpeg"} (no max: full PNG)
//!   {"id":12,"op":"size","device":"…"}
//!   {"id":11,"op":"foreground","device":"…"}
//!
//! → {"id":1,"ok":true,"data":…}  or  {"id":1,"ok":false,"error":"…"}
//!
//! Built only on public Android tooling (adb, uiautomator, input, screencap, am, cmd package). No output-size cap:
//! a screen tree of any size is read in full.

mod ios;
mod report;

use base64::Engine;
use quick_xml::events::Event;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::collections::HashMap;
use std::io::BufReader;
use std::net::TcpStream;
use std::process::Command;
use std::sync::Mutex;

/// The on-device helper (android-agent/): keeps one UiAutomation connection open so a screen read takes milliseconds.
const AGENT_DEX: &[u8] = include_bytes!("../android-agent/mobius-agent.dex");
static AGENTS: Mutex<Option<HashMap<String, BufReader<TcpStream>>>> = Mutex::new(None);

type R<T> = Result<T, String>;

fn adb(args: &[&str]) -> R<Vec<u8>> {
    let out = Command::new(std::env::var("ADB").unwrap_or_else(|_| "adb".into()))
        .args(args)
        .output()
        .map_err(|e| format!("adb not runnable: {e}"))?;
    if !out.status.success() {
        return Err(format!("adb {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(out.stdout)
}
fn shell(dev: &str, cmd: &str) -> R<String> {
    Ok(String::from_utf8_lossy(&adb(&["-s", dev, "shell", cmd])?).into_owned())
}
/// Quote one argument for the device's /system/bin/sh.
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn devices() -> R<Value> {
    let out = String::from_utf8_lossy(&adb(&["devices"])?).into_owned();
    let mut list = vec![];
    for line in out.lines().skip(1) {
        let mut it = line.split_whitespace();
        let (Some(serial), Some(state)) = (it.next(), it.next()) else { continue };
        let online = state == "device";
        let prop = |p: &str| if online { shell(serial, &format!("getprop {p}")).map(|s| s.trim().to_string()).unwrap_or_default() } else { String::new() };
        let avd = prop("ro.boot.qemu.avd_name");
        let model = prop("ro.product.model");
        let virt = !avd.is_empty() || serial.starts_with("emulator-") || prop("ro.kernel.qemu") == "1";
        list.push(json!({
            "id": serial, "platform": "android", "type": if virt { "emulator" } else { "real" },
            "name": if avd.is_empty() { model.clone() } else { avd.replace('_', " ") }, "avd": avd,
            "model": model, "version": prop("ro.build.version.release"), "state": if online { "online" } else { state },
        }));
    }
    Ok(json!({ "devices": list }))
}

/// "[x1,y1][x2,y2]" → {x,y,width,height}
fn bounds(s: &str) -> Value {
    let n: Vec<i64> = s.split(|c: char| !c.is_ascii_digit() && c != '-').filter(|t| !t.is_empty()).filter_map(|t| t.parse().ok()).collect();
    if n.len() != 4 { return json!({"x":0,"y":0,"width":0,"height":0}); }
    json!({ "x": n[0], "y": n[1], "width": (n[2] - n[0]).max(0), "height": (n[3] - n[1]).max(0) })
}

/// uiautomator XML → nested nodes in the shape Mobius's normalizer reads (class, text, content-desc, resource-id, rect),
/// plus the real `password` flag uiautomator reports.
fn parse_tree(xml: &str) -> R<(Value, i64)> {
    let mut rd = quick_xml::Reader::from_str(xml);
    let mut stack: Vec<Map<String, Value>> = vec![];
    let mut roots: Vec<Value> = vec![];
    let mut rotation = 0;
    let node = |e: &quick_xml::events::BytesStart| -> Map<String, Value> {
        let mut m = Map::new();
        for a in e.attributes().flatten() {
            let k = String::from_utf8_lossy(a.key.as_ref()).into_owned();
            let v = a.unescape_value().map(|v| v.into_owned()).unwrap_or_default();
            match k.as_str() {
                "class" | "text" | "resource-id" | "content-desc" | "package" | "hint" => { m.insert(k, Value::String(v)); }
                "bounds" => { m.insert("rect".into(), bounds(&v)); }
                "clickable" | "long-clickable" | "checkable" | "checked" | "enabled" | "focused" | "scrollable" | "selected" | "password" | "focusable" => {
                    m.insert(k.replace("long-clickable", "longClickable"), Value::Bool(v == "true"));
                }
                _ => {}
            }
        }
        m
    };
    let close = |stack: &mut Vec<Map<String, Value>>, roots: &mut Vec<Value>, mut n: Map<String, Value>| {
        n.entry("children").or_insert_with(|| Value::Array(vec![]));
        match stack.last_mut() {
            Some(p) => p.entry("children").or_insert_with(|| Value::Array(vec![])).as_array_mut().expect("children is an array").push(Value::Object(n)),
            None => roots.push(Value::Object(n)),
        }
    };
    loop {
        match rd.read_event().map_err(|e| format!("bad UI XML: {e}"))? {
            Event::Start(e) if e.name().as_ref() == b"hierarchy" => {
                for a in e.attributes().flatten() { if a.key.as_ref() == b"rotation" { rotation = String::from_utf8_lossy(&a.value).parse().unwrap_or(0); } }
            }
            Event::Start(e) if e.name().as_ref() == b"node" => stack.push(node(&e)),
            Event::Empty(e) if e.name().as_ref() == b"node" => { let n = node(&e); close(&mut stack, &mut roots, n); }
            Event::End(e) if e.name().as_ref() == b"node" => { if let Some(n) = stack.pop() { close(&mut stack, &mut roots, n); } }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok((json!({ "hierarchy": roots }), rotation))
}

fn foreground(dev: &str) -> R<Option<String>> {
    let out = shell(dev, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'")?;
    // e.g. "mCurrentFocus=Window{abc u0 com.android.settings/com.android.settings.Settings}"
    for line in out.lines() {
        if let Some(i) = line.find(" u0 ").or_else(|| line.find(" u10 ")) {
            let rest = &line[i + 4..];
            let pkg: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '.' || *c == '_').collect();
            if pkg.contains('.') { return Ok(Some(pkg)); }
        }
    }
    Ok(None)
}

fn screen_size(dev: &str) -> R<(i64, i64)> {
    let out = shell(dev, "wm size")?;
    let pick = |label: &str| out.lines().find(|l| l.contains(label)).and_then(|l| l.rsplit(' ').next()).and_then(|wh| {
        let (w, h) = wh.trim().split_once('x')?;
        Some((w.parse().ok()?, h.parse().ok()?))
    });
    pick("Override size").or_else(|| pick("Physical size")).ok_or_else(|| format!("unexpected `wm size` output: {out}"))
}

/// Small per-device cache on disk (helper port, screen size), so a fresh CLI process skips adb round-trips.
fn cache_path(dev: &str) -> std::path::PathBuf {
    let home = std::env::var("MOBIUS_HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".mobius"));
    home.join("driver").join(format!("{}.json", dev.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '.', "_")))
}
fn cache_get(dev: &str) -> Value { std::fs::read(cache_path(dev)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(json!({})) }
fn cache_set(dev: &str, k: &str, v: Value) {
    let mut c = cache_get(dev);
    c[k] = v;
    let p = cache_path(dev);
    let _ = std::fs::create_dir_all(p.parent().unwrap());
    let _ = std::fs::write(p, c.to_string());
}

/// Start (or reuse) the helper on `dev` and return a connection to it.
fn agent_conn(dev: &str, fast: bool) -> R<BufReader<TcpStream>> {
    // The helper echoes the build hash it was started with, so an older copy left running on the phone gets replaced.
    let version = format!("{:016x}", AGENT_DEX.iter().fold(0xcbf29ce484222325u64, |h, b| (h ^ *b as u64).wrapping_mul(0x100000001b3)));
    let want = format!("pong {version}");
    let ping = |c: &mut BufReader<TcpStream>| -> bool {
        let ok = c.get_mut().write_all(b"ping\n").is_ok() && { let mut l = String::new(); c.read_line(&mut l).is_ok() && l.trim() == want };
        if ok { cache_set(dev, "agent_version", json!(version)); }
        ok
    };
    let open = |port: u16| -> R<BufReader<TcpStream>> {
        let s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(10))).ok();
        s.set_nodelay(true).ok();
        Ok(BufReader::new(s))
    };
    let connect = || -> R<BufReader<TcpStream>> {
        let port = String::from_utf8_lossy(&adb(&["-s", dev, "forward", "tcp:0", "localabstract:mobius-agent"])?).trim().to_string();
        let port = port.parse::<u16>().map_err(|_| format!("bad forward port {port}"))?;
        cache_set(dev, "agent_port", json!(port));
        open(port)
    };
    // Fast path for a fresh process: the forward from last time is usually still there. No ping: if the helper behind it
    // is gone or outdated, the first command fails and agent_call reconnects through the checked path below.
    if fast && cache_get(dev)["agent_version"].as_str() == Some(version.as_str()) {
        if let Some(port) = cache_get(dev)["agent_port"].as_u64() {
            if let Ok(c) = open(port as u16) { return Ok(c); }
        }
    }
    if let Ok(mut c) = connect() { if ping(&mut c) { return Ok(c); } }
    // Not running (or an old one): install this build's helper and start it. Bracket pattern so pkill can't match its own shell.
    let tmp = std::env::temp_dir().join(format!("mobius-agent-{}.dex", std::process::id()));
    std::fs::write(&tmp, AGENT_DEX).map_err(|e| e.to_string())?;
    adb(&["-s", dev, "push", tmp.to_str().unwrap(), "/data/local/tmp/mobius-agent.dex"])?;
    let _ = std::fs::remove_file(&tmp);
    shell(dev, "pkill -f '[d]ev.mobius.agent.Server'; true")?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    shell(dev, &format!("CLASSPATH=/data/local/tmp/mobius-agent.dex nohup app_process / dev.mobius.agent.Server {version} >/data/local/tmp/mobius-agent.log 2>&1 &"))?;
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if let Ok(mut c) = connect() { if ping(&mut c) { return Ok(c); } }
    }
    Err(format!("helper did not start: {}", shell(dev, "cat /data/local/tmp/mobius-agent.log").unwrap_or_default().trim()))
}

/// One request to the helper on `dev` (started on first use; a broken connection is dropped and rebuilt next time).
fn agent_call(dev: &str, cmd: &str) -> R<Value> {
    let mut guard = AGENTS.lock().unwrap();
    let agents = guard.get_or_insert_with(HashMap::new);
    let send = |conn: &mut BufReader<TcpStream>| -> R<String> {
        conn.get_mut().write_all(format!("{cmd}\n").as_bytes()).map_err(|e| e.to_string())?;
        let mut line = String::new();
        conn.read_line(&mut line).map_err(|e| e.to_string())?;
        if line.trim().is_empty() || line.contains("unknown command") { return Err("helper missing or outdated".into()); }
        Ok(line)
    };
    let (mut conn, line) = match agents.remove(dev).map(Ok).unwrap_or_else(|| agent_conn(dev, true)) {
        Ok(mut c) => match send(&mut c) { Ok(l) => (c, l), Err(_) => { let mut c = agent_conn(dev, false)?; let l = send(&mut c)?; (c, l) } },
        Err(_) => { let mut c = agent_conn(dev, false)?; let l = send(&mut c)?; (c, l) }
    };
    let _ = &mut conn;
    agents.insert(dev.to_string(), conn);
    let v: Value = serde_json::from_str(&line).map_err(|e| format!("helper reply: {e}"))?;
    if let Some(e) = v.get("error") { return Err(format!("helper: {}", e.as_str().unwrap_or("error"))); }
    Ok(v)
}

/// Mask 4-8 digit codes next to OTP-ish words (and any standalone 6-digit code): notifications often carry login codes.
fn mask_codes(s: &str) -> String {
    let lower = s.to_lowercase();
    let otp = ["otp", "code", "pin", "verification", "password", "one-time", "one time"].iter().any(|k| lower.contains(k));
    let mut out = String::new();
    let mut digits = String::new();
    for c in s.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() { digits.push(c); continue; }
        if !digits.is_empty() { if (otp && (4..=8).contains(&digits.len())) || digits.len() == 6 { out.push_str("[REDACTED]") } else { out.push_str(&digits) }; digits.clear(); }
        out.push(c);
    }
    out.pop();
    out
}

fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn helper_ok() -> bool { std::env::var("MOBIUS_NO_AGENT").is_err() }

fn agent_dump(dev: &str) -> R<Value> {
    let mut v = agent_call(dev, "dump")?;
    let (w, h) = (v["width"].as_i64().unwrap_or(0), v["height"].as_i64().unwrap_or(0));
    let (pw, ph) = physical_size(dev)?;
    let rotation = if (w > h) != (pw > ph) { 1 } else { 0 };
    Ok(json!({ "tree": { "hierarchy": v["windows"].take() }, "width": w, "height": h, "rotation": rotation, "foregroundApp": v["foregroundApp"].take(), "via": "agent" }))
}

static SIZES: Mutex<Option<HashMap<String, (i64, i64)>>> = Mutex::new(None);
fn physical_size(dev: &str) -> R<(i64, i64)> {
    let mut g = SIZES.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    if let Some(s) = m.get(dev) { return Ok(*s); }
    let c = cache_get(dev)["size"].clone();
    let s = match (c[0].as_i64(), c[1].as_i64()) {
        (Some(w), Some(h)) => (w, h),
        _ => { let s = screen_size(dev)?; cache_set(dev, "size", json!([s.0, s.1])); s }
    };
    m.insert(dev.to_string(), s);
    Ok(s)
}

fn dump(dev: &str) -> R<Value> {
    if std::env::var("MOBIUS_NO_AGENT").is_err() {
        match agent_dump(dev) {
            Ok(v) => return Ok(v),
            Err(e) => eprintln!("mobiusagent-driver: helper unavailable on {dev} ({e}); falling back to uiautomator"),
        }
    }
    uiautomator_dump(dev)
}

fn uiautomator_dump(dev: &str) -> R<Value> {
    // uiautomator fails while the UI is animating ("could not get idle state"): retry briefly.
    let mut last = String::new();
    for _ in 0..4 {
        let raw = String::from_utf8_lossy(&adb(&["-s", dev, "exec-out", "uiautomator", "dump", "/dev/tty"])?).into_owned();
        if let (Some(a), Some(b)) = (raw.find("<?xml"), raw.rfind("</hierarchy>")) {
            let (tree, rotation) = parse_tree(&raw[a..b + "</hierarchy>".len()])?;
            let (w, h) = screen_size(dev)?;
            let (w, h) = if rotation % 2 == 1 { (h, w) } else { (w, h) };
            return Ok(json!({ "tree": tree, "width": w, "height": h, "rotation": rotation, "foregroundApp": foreground(dev)? }));
        }
        last = raw.trim().chars().take(200).collect();
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    Err(format!("no UI tree (screen off, locked, or never idle): {last}"))
}

/// `input text` takes ASCII only and treats spaces/shell characters specially.
fn input_text(dev: &str, text: &str) -> R<()> {
    if !text.is_ascii() {
        // Hindi, emoji…: the helper sets it on the focused field through accessibility.
        agent_call(dev, &format!("text {}", base64::engine::general_purpose::STANDARD.encode(text.replace('\n', " "))))?;
        return Ok(());
    }
    let flat = text.split('\n').collect::<Vec<_>>().join(" ");
    // The same key events `input text` sends, injected by the helper (no shell process per call).
    if helper_ok() && agent_call(dev, &format!("keys {}", base64::engine::general_purpose::STANDARD.encode(&flat))).is_ok() { return Ok(()); }
    for chunk in flat.as_bytes().chunks(200) {
        let s = std::str::from_utf8(chunk).unwrap().replace(' ', "%s");
        shell(dev, &format!("input text {}", q(&s)))?;
    }
    Ok(())
}

/// Run in an app's sandbox (`run-as`, debuggable apps) when the request names one.
fn with_app(req: &Value, cmd: &str) -> R<String> {
    let dev = str_(req, "device")?;
    match req.get("app").and_then(|v| v.as_str()) {
        Some(_) => shell(dev, &format!("run-as {} {cmd}", pkg(req)?)),
        None => shell(dev, cmd),
    }
}

fn keycode(k: &str) -> R<String> {
    let k = k.to_ascii_lowercase();
    let named = match k.as_str() {
        "ctrl" | "control" => "CTRL_LEFT", "shift" => "SHIFT_LEFT", "alt" => "ALT_LEFT", "meta" | "cmd" => "META_LEFT",
        "enter" | "return" => "ENTER", "back" => "BACK", "home" => "HOME", "recents" | "app_switch" => "APP_SWITCH",
        "tab" => "TAB", "esc" | "escape" => "ESCAPE", "del" | "backspace" | "delete" => "DEL", "space" => "SPACE",
        "volume_up" => "VOLUME_UP", "volume_down" => "VOLUME_DOWN", "mute" => "VOLUME_MUTE", "power" => "POWER",
        "menu" => "MENU", "search" => "SEARCH", "camera" => "CAMERA", "up" => "DPAD_UP", "down" => "DPAD_DOWN",
        "left" => "DPAD_LEFT", "right" => "DPAD_RIGHT", "notifications" => "NOTIFICATION",
        s if s.len() == 1 && s.chars().all(|c| c.is_ascii_alphanumeric()) => return Ok(format!("KEYCODE_{}", s.to_ascii_uppercase())),
        s if s.starts_with("keycode_") && s[8..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => return Ok(s.to_ascii_uppercase()),
        _ => return Err(format!("unknown key `{k}`")),
    };
    Ok(format!("KEYCODE_{named}"))
}

fn pkg(req: &Value) -> R<&str> {
    let app = str_(req, "app")?;
    if app.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '_') { Ok(app) } else { Err("invalid package name".into()) }
}

fn num(v: &Value, k: &str) -> R<i64> {
    v.get(k).and_then(|x| x.as_f64()).map(|f| f.round() as i64).ok_or_else(|| format!("missing number `{k}`"))
}
fn str_<'a>(v: &'a Value, k: &str) -> R<&'a str> {
    v.get(k).and_then(|x| x.as_str()).ok_or_else(|| format!("missing string `{k}`"))
}

/// Screenshot bytes → JPEG no larger than `max` on its longest side (what an LLM needs); 0 → the original PNG.
fn shrink(png: &[u8], max: u32) -> R<Value> {
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    if max == 0 { return Ok(json!({ "data": b64(png), "mimeType": "image/png" })); }
    let img = image::load_from_memory(png).map_err(|e| format!("screenshot decode: {e}"))?;
    let img = if img.width().max(img.height()) > max { img.resize(max, max, image::imageops::FilterType::Triangle) } else { img };
    let mut jpg = std::io::Cursor::new(vec![]);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 80).encode_image(&img.to_rgb8()).map_err(|e| format!("jpeg: {e}"))?;
    Ok(json!({ "data": b64(jpg.get_ref()), "mimeType": "image/jpeg" }))
}

/// Text recognition (macOS Vision, compiled once to ~/.mobius/bin/mobius-ocr): reads text drawn on screen, labelled or not.
const OCR_SWIFT: &str = r#"
import Foundation
import Vision
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
req.recognitionLanguages = ["en-US", "hi-IN"]
let h = VNImageRequestHandler(url: url)
try? h.perform([req])
var out: [[String: Any]] = []
for o in (req.results ?? []) {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    out.append(["text": c.string, "confidence": c.confidence, "x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height])
}
let d = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(d)
"#;

fn ocr_bin() -> R<std::path::PathBuf> {
    let dir = cache_path("x").parent().unwrap().parent().unwrap().join("bin");
    let bin = dir.join("mobius-ocr");
    if bin.exists() { return Ok(bin); }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let src = dir.join("mobius-ocr.swift");
    std::fs::write(&src, OCR_SWIFT).map_err(|e| e.to_string())?;
    let o = Command::new("swiftc").args(["-O", src.to_str().unwrap(), "-o", bin.to_str().unwrap()]).output().map_err(|e| format!("swiftc (Xcode) is needed for OCR: {e}"))?;
    if !o.status.success() { return Err(format!("building OCR helper: {}", String::from_utf8_lossy(&o.stderr))); }
    Ok(bin)
}

/// Every piece of text on screen, with boxes in screen coordinates (points on iOS, pixels on Android).
fn ocr(dev: &str) -> R<Value> {
    let (img, k) = screen_image(dev)?;
    let tmp = std::env::temp_dir().join(format!("mobius-ocr-{}.png", std::process::id()));
    img.save(&tmp).map_err(|e| e.to_string())?;
    let out = Command::new(ocr_bin()?).arg(&tmp).output().map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&tmp);
    let items: Vec<Value> = serde_json::from_slice(&out.stdout).map_err(|e| format!("OCR output: {e}"))?;
    let (w, h) = (img.width() as f64 / k, img.height() as f64 / k);
    let text: Vec<Value> = items.into_iter().map(|i| {
        let f = |key: &str| i[key].as_f64().unwrap_or(0.0);
        json!({ "text": i["text"], "confidence": (f("confidence") * 100.0).round() / 100.0, "box": [(f("x") * w).round(), (f("y") * h).round(), (f("w") * w).round(), (f("h") * h).round()] })
    }).collect();
    Ok(json!({ "text": text }))
}

/// Tap the element showing `text`: from the accessibility tree first, then from what's drawn on screen (OCR), so
/// unlabeled buttons work too. `exact` for an exact match; `index` for the n-th match.
fn tap_text(dev: &str, req: &Value) -> R<Value> {
    let want = str_(req, "text")?.to_lowercase();
    let exact = req.get("exact").and_then(|v| v.as_bool()).unwrap_or(false);
    let idx = req.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let m = |t: &str| { let t = t.to_lowercase(); if exact { t == want } else { t.contains(&want) } };
    let d = handle(&json!({ "op": "dump", "device": dev }))?;
    let (sw, sh) = (d["width"].as_f64().unwrap_or(1e9), d["height"].as_f64().unwrap_or(1e9));
    let mut hits: Vec<_> = elements(&d).into_iter().filter(|e| e.5 > 0.0 && e.6 > 0.0 && e.3 < sw && e.4 < sh && e.3 + e.5 > 0.0 && e.4 + e.6 > 0.0 && m(&e.1)).collect();
    hits.sort_by_key(|e| !e.2); // clickable first
    if let Some(e) = hits.get(idx) {
        let (x, y) = (e.3.max(0.0) + e.5.min(sw) / 2.0, e.4.max(0.0) + e.6.min(sh) / 2.0);
        handle(&json!({ "op": "tap", "device": dev, "x": x, "y": y }))?;
        return Ok(json!({ "tapped": e.1, "via": "accessibility", "x": x.round(), "y": y.round() }));
    }
    let found = ocr(dev)?;
    let ocr_hits: Vec<&Value> = found["text"].as_array().into_iter().flatten().filter(|t| m(t["text"].as_str().unwrap_or(""))).collect();
    let t = ocr_hits.get(idx).ok_or(format!("\"{want}\" is not on screen (accessibility tree or drawn text)"))?;
    let b = &t["box"];
    let (x, y) = (b[0].as_f64().unwrap_or(0.0) + b[2].as_f64().unwrap_or(0.0) / 2.0, b[1].as_f64().unwrap_or(0.0) + b[3].as_f64().unwrap_or(0.0) / 2.0);
    handle(&json!({ "op": "tap", "device": dev, "x": x, "y": y }))?;
    Ok(json!({ "tapped": t["text"], "via": "ocr", "x": x.round(), "y": y.round() }))
}

/// One shareable HTML bug report: screenshot, what's on screen, device, app, logs, crashes, performance, accessibility.
fn bug_report(dev: &str, req: &Value) -> R<Value> {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let app = req.get("app").and_then(|v| v.as_str()).map(String::from)
        .or_else(|| handle(&json!({ "op": "foreground", "device": dev })).ok().and_then(|v| v["app"].as_str().map(String::from))).unwrap_or_default();
    let shot = handle(&json!({ "op": "screenshot", "device": dev, "max": 900 })).ok();
    let snap = snapshot(dev).ok().and_then(|v| v["snapshot"].as_str().map(String::from)).unwrap_or_default();
    let info = handle(&json!({ "op": "info", "device": dev })).unwrap_or(Value::Null);
    let logs = handle(&json!({ "op": "logs", "device": dev, "lines": 300, "seconds": 3, "app": if ios::is_ios(dev) { Value::Null } else { json!(app) } }))
        .or_else(|_| handle(&json!({ "op": "logs", "device": dev, "lines": 300, "seconds": 3 })))
        .ok().and_then(|v| v["lines"].as_array().cloned()).unwrap_or_default();
    let crashes: Vec<Value> = handle(&json!({ "op": "crashes", "device": dev })).ok().and_then(|v| v["crashes"].as_array().cloned()).unwrap_or_default()
        .into_iter().filter(|c| app.is_empty() || c["process"].as_str().is_some_and(|p| app.contains(p) || p.contains(&app) || app.ends_with(p))).take(5).collect();
    let crash_text = crashes.first().and_then(|c| handle(&json!({ "op": "crash", "device": dev, "id": c["id"] })).ok()).and_then(|v| v["text"].as_str().map(String::from)).unwrap_or_default();
    let perf = if ios::is_ios(dev) || app.is_empty() { Value::Null } else { handle(&json!({ "op": "perf", "device": dev, "app": app })).unwrap_or(Value::Null) };
    let a11y = a11y_audit(dev).unwrap_or(Value::Null);
    let title = req.get("title").and_then(|v| v.as_str()).unwrap_or("Bug report");
    let img = shot.as_ref().map(|s| format!("<img src='data:{};base64,{}'>", s["mimeType"].as_str().unwrap_or("image/jpeg"), s["data"].as_str().unwrap_or(""))).unwrap_or_default();
    let html = format!(r#"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>{t}</title>
<style>:root{{--bg:#0b0d1a;--fg:#e8e9f3;--mut:#9aa0c3;--card:#151833}}body{{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}}
main{{max-width:980px;margin:0 auto;padding:24px 16px}}h1{{font-size:22px;margin:0}}h2{{font-size:15px;margin:22px 0 8px}}.sub{{color:var(--mut)}}
.grid{{display:grid;grid-template-columns:minmax(0,300px) minmax(0,1fr);gap:16px}}@media(max-width:700px){{.grid{{grid-template-columns:1fr}}}}
img{{width:100%;border-radius:16px}}pre{{background:var(--card);padding:12px;border-radius:10px;overflow:auto;max-height:340px;font-size:12px;white-space:pre-wrap}}</style></head><body><main>
<h1>{t}</h1><p class=sub>{app} · {model} · {when} · Mobius</p><div class=grid><div>{img}</div><div><h2>On screen</h2><pre>{snap}</pre></div></div>
<h2>Device</h2><pre>{info}</pre><h2>Performance</h2><pre>{perf}</pre><h2>Accessibility</h2><pre>{a11y}</pre>
<h2>Recent crashes</h2><pre>{crashes}</pre>{crash_text}<h2>Logs</h2><pre>{logs}</pre></main></body></html>"#,
        t = esc(title), app = esc(&app), model = esc(info["model"].as_str().unwrap_or("")), when = now_ms(), img = img, snap = esc(&snap),
        info = esc(&serde_json::to_string_pretty(&info).unwrap_or_default()), perf = esc(&serde_json::to_string_pretty(&perf).unwrap_or_default()),
        a11y = esc(&serde_json::to_string_pretty(&a11y).unwrap_or_default()), crashes = esc(&serde_json::to_string_pretty(&crashes).unwrap_or_default()),
        crash_text = if crash_text.is_empty() { String::new() } else { format!("<h2>Latest crash</h2><pre>{}</pre>", esc(&crash_text.chars().take(20000).collect::<String>())) },
        logs = esc(&logs.iter().filter_map(|l| l.as_str()).map(mask_codes).collect::<Vec<_>>().join("\n")));
    let out = req.get("output").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| format!("mobius-bug-report-{}.html", now_ms()));
    std::fs::write(&out, html).map_err(|e| e.to_string())?;
    Ok(json!({ "saved": out, "app": app, "crashes": crashes.len(), "log_lines": logs.len() }))
}

/// Watch for crashes for `seconds`; each new crash (of `app`, if given) is written up as a bug report in `dir`.
fn watch_crashes(dev: &str, req: &Value) -> R<Value> {
    let secs = req.get("seconds").and_then(|v| v.as_u64()).unwrap_or(300);
    let app = req.get("app").and_then(|v| v.as_str()).map(String::from);
    let dir = req.get("dir").and_then(|v| v.as_str()).unwrap_or(".").to_string();
    let ids = || -> std::collections::HashSet<String> {
        handle(&json!({ "op": "crashes", "device": dev })).ok().and_then(|v| v["crashes"].as_array().cloned()).unwrap_or_default().into_iter()
            .filter(|c| app.as_deref().is_none_or(|a| c["process"].as_str().is_some_and(|p| a.contains(p) || p.contains(a))))
            .filter_map(|c| c["id"].as_str().map(String::from)).collect()
    };
    let seen = ids();
    let t = std::time::Instant::now();
    let mut reports = vec![];
    while t.elapsed().as_secs() < secs {
        std::thread::sleep(std::time::Duration::from_secs(2));
        for id in ids().difference(&seen).cloned().collect::<Vec<_>>() {
            let out = format!("{}/crash-{}.html", dir.trim_end_matches('/'), now_ms());
            let r = bug_report(dev, &json!({ "app": app, "output": out, "title": format!("Crash: {id}") }))?;
            eprintln!("mobiusagent-driver: crash detected ({id}) → {}", r["saved"]);
            reports.push(json!({ "crash": id, "report": r["saved"] }));
            return Ok(json!({ "crashed": true, "reports": reports, "after_s": t.elapsed().as_secs() }));
        }
    }
    Ok(json!({ "crashed": false, "watched_s": secs }))
}

/// Replay a recorded flow (flow_record_stop output) with its original timing (`speed` 2 = twice as fast, 0 = no waits).
fn replay(dev: &str, req: &Value) -> R<Value> {
    let flow: Value = match req.get("file").and_then(|v| v.as_str()) {
        Some(f) => serde_json::from_slice(&std::fs::read(f).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?,
        None => req.get("flow").cloned().ok_or("give `file` or `flow`")?,
    };
    let speed = req.get("speed").and_then(|v| v.as_f64()).unwrap_or(1.0);
    let t = std::time::Instant::now();
    let mut done = 0;
    for st in flow["steps"].as_array().into_iter().flatten() {
        if speed > 0.0 {
            let due = (st["at_ms"].as_f64().unwrap_or(0.0) / speed) as u128;
            let el = t.elapsed().as_millis();
            if due > el { std::thread::sleep(std::time::Duration::from_millis((due - el) as u64)); }
        }
        let mut step = st.clone();
        step["device"] = json!(dev);
        handle(&step)?;
        done += 1;
    }
    Ok(json!({ "steps": done, "ms": t.elapsed().as_millis() as u64 }))
}

fn devtools_port(dev: &str, sock: &str) -> R<u16> {
    let key = format!("devtools_{sock}");
    if let Some(p) = cache_get(dev)[&key].as_u64() { if http_get_json(p as u16, "/json/version").is_ok() { return Ok(p as u16); } }
    let port = String::from_utf8_lossy(&adb(&["-s", dev, "forward", "tcp:0", &format!("localabstract:{sock}")])?).trim().parse::<u16>().map_err(|_| "forward failed")?;
    cache_set(dev, &key, json!(port));
    Ok(port)
}

fn http_get_json(port: u16, path: &str) -> R<Value> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = vec![];
    use std::io::Read;
    let _ = s.read_to_end(&mut raw);
    let i = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad devtools reply")?;
    serde_json::from_slice(&raw[i + 4..]).map_err(|e| format!("devtools reply: {e}"))
}

fn b64d(s: &str) -> Vec<u8> { base64::engine::general_purpose::STANDARD.decode(s).unwrap_or_default() }

/// Full-resolution screenshot as an image, plus the pixels-per-point scale (iOS screenshots are in pixels, trees in points).
fn screen_image(dev: &str) -> R<(image::DynamicImage, f64)> {
    let shot = handle(&json!({ "op": "screenshot", "device": dev, "max": 0 }))?;
    let img = image::load_from_memory(&b64d(shot["data"].as_str().unwrap_or(""))).map_err(|e| format!("screenshot: {e}"))?;
    let w = handle(&json!({ "op": "size", "device": dev }))?["width"].as_f64().unwrap_or(img.width() as f64);
    Ok((img.clone(), img.width() as f64 / w.max(1.0)))
}

/// Screenshot of one element: `ref` from the last snapshot, or a box [x, y, w, h] in screen coordinates.
fn element_screenshot(dev: &str, req: &Value) -> R<Value> {
    let bx: Vec<f64> = if let Some(r) = req.get("ref").and_then(|v| v.as_str()) {
        snapshot(dev)?; // refresh so the ref's box is current
        let b = cache_get(dev)["boxes"][r.trim_start_matches('@')].clone();
        b.as_array().ok_or(format!("unknown ref {r}"))?.iter().filter_map(|v| v.as_f64()).collect()
    } else { req.get("box").and_then(|v| v.as_array()).ok_or("give `ref` or `box`")?.iter().filter_map(|v| v.as_f64()).collect() };
    if bx.len() != 4 { return Err("box must be [x, y, width, height]".into()); }
    let (img, k) = screen_image(dev)?;
    let (x, y) = ((bx[0] * k).max(0.0) as u32, (bx[1] * k).max(0.0) as u32);
    let (w, h) = (((bx[2] * k) as u32).min(img.width().saturating_sub(x)).max(1), ((bx[3] * k) as u32).min(img.height().saturating_sub(y)).max(1));
    let crop = img.crop_imm(x, y, w, h);
    let mut out = std::io::Cursor::new(vec![]);
    crop.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    if let Some(path) = req.get("output").and_then(|v| v.as_str()) {
        std::fs::write(path, out.get_ref()).map_err(|e| e.to_string())?;
        return Ok(json!({ "saved": path, "width": w, "height": h }));
    }
    Ok(json!({ "data": base64::engine::general_purpose::STANDARD.encode(out.get_ref()), "mimeType": "image/png", "width": w, "height": h }))
}

/// Visual regression: compare the screen with a saved baseline (`name`), ignoring the status bar. First run saves the baseline.
fn visual_check(dev: &str, req: &Value) -> R<Value> {
    let name = str_(req, "name")?;
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err("name: letters, digits, - and _".into()); }
    let dir = req.get("dir").and_then(|v| v.as_str()).map(std::path::PathBuf::from)
        .unwrap_or_else(|| cache_path(dev).parent().unwrap().parent().unwrap().join("baselines"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let threshold = req.get("threshold").and_then(|v| v.as_f64()).unwrap_or(0.5); // % of pixels allowed to differ
    let (img, _) = screen_image(dev)?;
    let small = img.resize(360, 10_000, image::imageops::FilterType::Triangle).to_rgb8();
    let base_path = dir.join(format!("{name}.png"));
    if !base_path.exists() || req.get("update").and_then(|v| v.as_bool()).unwrap_or(false) {
        small.save(&base_path).map_err(|e| e.to_string())?;
        return Ok(json!({ "baseline_saved": base_path, "pass": true }));
    }
    let base = image::open(&base_path).map_err(|e| e.to_string())?.to_rgb8();
    if base.dimensions() != small.dimensions() { return Ok(json!({ "pass": false, "reason": "screen size changed", "baseline": base_path })); }
    let skip = (small.height() as f64 * 0.06) as u32; // status bar: clock, battery
    let mut diff = small.clone();
    let (mut changed, mut total) = (0u64, 0u64);
    for (x, y, p) in small.enumerate_pixels() {
        if y < skip { continue; }
        total += 1;
        let q = base.get_pixel(x, y);
        let d: i32 = (0..3).map(|i| (p[i] as i32 - q[i] as i32).abs()).sum();
        if d > 60 { changed += 1; diff.put_pixel(x, y, image::Rgb([255, 40, 60])); }
        else { let g = ((p[0] as u32 + p[1] as u32 + p[2] as u32) / 6) as u8; diff.put_pixel(x, y, image::Rgb([g, g, g])); }
    }
    let pct = if total == 0 { 0.0 } else { changed as f64 * 100.0 / total as f64 };
    let diff_path = dir.join(format!("{name}.diff.png"));
    diff.save(&diff_path).map_err(|e| e.to_string())?;
    Ok(json!({ "pass": pct <= threshold, "changed_percent": (pct * 100.0).round() / 100.0, "threshold_percent": threshold, "baseline": base_path, "diff_image": diff_path }))
}

/// Deep-link test: open the link, wait for the screen to settle, check the app in front and the expected text.
fn deeplink(dev: &str, req: &Value) -> R<Value> {
    let url = str_(req, "url")?;
    let before = handle(&json!({ "op": "foreground", "device": dev })).ok().and_then(|v| v["app"].as_str().map(String::from));
    let t = std::time::Instant::now();
    handle(&json!({ "op": "url", "device": dev, "url": url }))?;
    // A cold app takes a moment to come to the front: wait for the switch (if any), then for the screen to settle.
    while t.elapsed().as_millis() < 8000 {
        let now = handle(&json!({ "op": "foreground", "device": dev })).ok().and_then(|v| v["app"].as_str().map(String::from));
        if now != before { break; }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let idle = wait_idle(dev, 8000)?;
    let snap = snapshot(dev)?;
    let app = snap["app"].as_str().unwrap_or("").to_string();
    let text = snap["snapshot"].as_str().unwrap_or("").to_lowercase();
    let app_ok = req.get("expect_app").and_then(|v| v.as_str()).map(|a| a == app);
    let text_ok = req.get("expect_text").and_then(|v| v.as_str()).map(|e| text.contains(&e.to_lowercase()));
    Ok(json!({ "pass": app_ok.unwrap_or(true) && text_ok.unwrap_or(true), "landed_app": app, "app_ok": app_ok, "text_ok": text_ok,
        "settled_ms": t.elapsed().as_millis() as u64, "idle": idle["idle"] }))
}

/// GPS route playback for ride/delivery flows: moves the device along waypoints at `speed_kmh`, one fix per `interval_s`.
fn gps_route(dev: &str, req: &Value) -> R<Value> {
    let pts: Vec<(f64, f64)> = match req.get("points") {
        Some(Value::String(s)) => s.split(';').filter_map(|p| { let (a, b) = p.split_once(',')?; Some((a.trim().parse().ok()?, b.trim().parse().ok()?)) }).collect(),
        Some(Value::Array(a)) => a.iter().filter_map(|p| Some((p[0].as_f64()?, p[1].as_f64()?))).collect(),
        _ => vec![],
    };
    if pts.len() < 2 { return Err("points: at least two \"lat,lon;lat,lon\" waypoints".into()); }
    let speed = req.get("speed_kmh").and_then(|v| v.as_f64()).unwrap_or(30.0).max(1.0);
    let step = req.get("interval_s").and_then(|v| v.as_f64()).unwrap_or(1.0).max(0.2);
    let hav = |a: (f64, f64), b: (f64, f64)| { let (r, d) = (6_371_000.0_f64, std::f64::consts::PI / 180.0);
        let (dl, dn) = ((b.0 - a.0) * d, (b.1 - a.1) * d);
        let h = (dl / 2.0).sin().powi(2) + (a.0 * d).cos() * (b.0 * d).cos() * (dn / 2.0).sin().powi(2); 2.0 * r * h.sqrt().asin() };
    let mps = speed / 3.6;
    let mut fixes = 0;
    let t0 = std::time::Instant::now();
    for w in pts.windows(2) {
        let n = ((hav(w[0], w[1]) / mps / step).ceil() as usize).max(1);
        for i in 0..n {
            let k = i as f64 / n as f64;
            let (lat, lon) = (w[0].0 + (w[1].0 - w[0].0) * k, w[0].1 + (w[1].1 - w[0].1) * k);
            handle(&json!({ "op": "location", "device": dev, "lat": lat, "lon": lon }))?;
            fixes += 1;
            std::thread::sleep(std::time::Duration::from_secs_f64(step));
            if t0.elapsed().as_secs() > 3600 { break; }
        }
    }
    let last = pts.last().unwrap();
    handle(&json!({ "op": "location", "device": dev, "lat": last.0, "lon": last.1 }))?;
    Ok(json!({ "fixes": fixes + 1, "seconds": t0.elapsed().as_secs(), "distance_m": pts.windows(2).map(|w| hav(w[0], w[1])).sum::<f64>().round() }))
}

/// Full performance report for an app: launch times, CPU/memory/threads over the session, frames, crashes, battery,
/// with optional budgets. Writes JSON (and HTML when `output` ends in .html).
fn perf_report(dev: &str, req: &Value) -> R<Value> {
    let secs = req.get("seconds").and_then(|v| v.as_u64()).unwrap_or(30).clamp(3, 1800);
    let mut rep = if ios::is_ios(dev) { ios::perf_session(dev, req, secs)? } else { android_perf(dev, req, secs)? };
    if let Some(b) = req.get("budget").or(req.get("budgets")) {
        let b = if let Some(s) = b.as_str() { serde_json::from_str(s).map_err(|e| format!("budget JSON: {e}"))? } else { b.clone() };
        rep.0["budgets"] = report::check_budgets(&rep.0, &b);
    }
    if let Some(out) = req.get("output").and_then(|v| v.as_str()) {
        let body = if out.ends_with(".html") { report::html(&rep.0, &rep.1) } else { serde_json::to_string_pretty(&rep.0).unwrap_or_default() };
        std::fs::write(out, body).map_err(|e| e.to_string())?;
        rep.0["saved"] = json!(out);
    }
    Ok(rep.0)
}

fn android_perf(dev: &str, req: &Value, secs: u64) -> R<(Value, Vec<report::Sample>)> {
    let app = pkg(req)?.to_string();
    let comp = shell(dev, &format!("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER {app}"))?
        .lines().last().unwrap_or("").trim().to_string();
    if !comp.contains('/') { return Err(format!("{app} is not installed or has no launcher activity")); }
    let crash_ids = |dev: &str| -> std::collections::HashSet<String> {
        handle(&json!({ "op": "crashes", "device": dev })).ok().and_then(|v| v["crashes"].as_array().cloned()).unwrap_or_default()
            .into_iter().filter(|c| c["process"].as_str() == Some(&app)).filter_map(|c| c["id"].as_str().map(String::from)).collect()
    };
    let before = crash_ids(dev);
    // Launch: cold (process killed) then warm (app backgrounded, process alive). `am start -W` reports TotalTime.
    let launch = |extra: &str| -> Option<u64> {
        shell(dev, &format!("{extra}am start -W -n {comp}")).ok()?.lines().find_map(|l| l.trim().strip_prefix("TotalTime:").and_then(|v| v.trim().parse().ok()))
    };
    let cold = launch(&format!("am force-stop {app}; sleep 1; "));
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let _ = shell(dev, "input keyevent 3");
    std::thread::sleep(std::time::Duration::from_millis(800));
    let warm = launch("");
    let _ = shell(dev, &format!("dumpsys gfxinfo {app} reset"));
    let battery_at = |dev: &str| shell(dev, "dumpsys battery").unwrap_or_default();
    let bat0 = battery_at(dev);
    let pid = shell(dev, &format!("pidof -s {app}"))?.trim().to_string();
    if pid.is_empty() { return Err(format!("{app} did not start")); }
    // One cheap read per second: /proc ticks (CPU), RSS, threads.
    let read = |dev: &str| -> Option<(u64, u64, f64, u64)> {
        let o = shell(dev, &format!("head -1 /proc/stat; cat /proc/{pid}/stat; grep -E '^(VmRSS|Threads):' /proc/{pid}/status")).ok()?;
        let mut l = o.lines();
        let total: u64 = l.next()?.split_whitespace().skip(1).filter_map(|v| v.parse::<u64>().ok()).sum();
        let st = l.next()?;
        let after = st.rsplit_once(')')?.1; // fields after "(comm)"
        let f: Vec<&str> = after.split_whitespace().collect();
        let proc_ticks = f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?;
        let mut rss_kb = 0.0; let mut threads = 0;
        for line in l { let v = line.split_whitespace().nth(1).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
            if line.starts_with("VmRSS") { rss_kb = v } else if line.starts_with("Threads") { threads = v as u64 } }
        Some((total, proc_ticks, rss_kb / 1024.0, threads))
    };
    let cores = shell(dev, "nproc").ok().and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(1.0);
    let t0 = std::time::Instant::now();
    let mut samples = vec![];
    let mut prev = read(dev);
    while t0.elapsed().as_secs() < secs {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let Some(cur) = read(dev) else { break }; // app died: crash check below
        let cpu = prev.map(|p| if cur.0 > p.0 { (cur.1 - p.1) as f64 / (cur.0 - p.0) as f64 * 100.0 * cores } else { 0.0 });
        samples.push(report::Sample { t_ms: t0.elapsed().as_millis() as u64, cpu: cpu.map(report::r1), mem_mb: Some(report::r1(cur.2)), threads: Some(cur.3) });
        prev = Some(cur);
    }
    let gfx = shell(dev, &format!("dumpsys gfxinfo {app}")).unwrap_or_default();
    let grab = |k: &str| gfx.lines().find(|l| l.trim_start().starts_with(k)).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string());
    let num = |s: Option<String>| s.and_then(|v| v.split(|c: char| !c.is_ascii_digit() && c != '.').find(|t| !t.is_empty()).and_then(|t| t.parse::<f64>().ok()));
    let janky_pct = grab("Janky frames").and_then(|v| v.split('(').nth(1).and_then(|p| p.trim_end_matches(|c| c == ')' || c == '%').trim_end_matches('%').parse::<f64>().ok()));
    let pss = shell(dev, &format!("dumpsys meminfo {app}")).unwrap_or_default().lines().find(|l| l.trim_start().starts_with("TOTAL"))
        .and_then(|l| l.split_whitespace().find_map(|t| t.parse::<f64>().ok())).map(|k| report::r1(k / 1024.0));
    let bat1 = battery_at(dev);
    let bat = |b: &str, k: &str| b.lines().find(|l| l.trim_start().starts_with(k)).and_then(|l| l.split(':').nth(1)).and_then(|v| v.trim().parse::<f64>().ok());
    let new_crashes: Vec<String> = crash_ids(dev).difference(&before).cloned().collect();
    let model = shell(dev, "getprop ro.product.model").unwrap_or_default().trim().to_string();
    let version = shell(dev, "getprop ro.build.version.release").unwrap_or_default().trim().to_string();
    let rep = json!({
        "app": app, "platform": "Android", "seconds": secs,
        "device": { "model": model, "android": version, "cores": cores },
        "launch": { "cold_ms": cold, "warm_ms": warm },
        "summary": report::summarize(&samples),
        "frames": { "total": num(grab("Total frames rendered")), "janky_percent": janky_pct, "p50_ms": num(grab("50th percentile")),
            "p90_ms": num(grab("90th percentile")), "p99_ms": num(grab("99th percentile")), "slow_ui_thread": num(grab("Number Slow UI thread")),
            "missed_vsync": num(grab("Number Missed Vsync")), "frozen_frames": num(grab("Number Frame deadline missed")) },
        "memory_pss_mb_end": pss,
        "battery": { "level_start": bat(&bat0, "level"), "level_end": bat(&bat1, "level"),
            "temperature_c_end": bat(&bat1, "temperature").map(|t| t / 10.0) },
        "crashes": new_crashes,
    });
    Ok((rep, samples))
}

/// Flatten a dump into (role, text, clickable, x, y, w, h) for either platform.
fn elements(d: &Value) -> Vec<(String, String, bool, f64, f64, f64, f64)> {
    let mut out = vec![];
    fn walk(n: &Value, out: &mut Vec<(String, String, bool, f64, f64, f64, f64)>) {
        let ios = n.get("elementType").is_some();
        let (x, y, w, h) = if ios { let f = &n["frame"]; (f["X"].as_f64().unwrap_or(0.0), f["Y"].as_f64().unwrap_or(0.0), f["Width"].as_f64().unwrap_or(0.0), f["Height"].as_f64().unwrap_or(0.0)) }
            else { let r = &n["rect"]; (r["x"].as_f64().unwrap_or(0.0), r["y"].as_f64().unwrap_or(0.0), r["width"].as_f64().unwrap_or(0.0), r["height"].as_f64().unwrap_or(0.0)) };
        let et = n["elementType"].as_u64().unwrap_or(0);
        let role = if ios { format!("type{et}") } else { n["class"].as_str().unwrap_or("").rsplit('.').next().unwrap_or("").to_string() };
        let text = if ios { n["label"].as_str().filter(|s| !s.is_empty()).or(n["value"].as_str()).unwrap_or("") } else { n["text"].as_str().filter(|s| !s.is_empty()).or(n["content-desc"].as_str()).unwrap_or("") };
        let clickable = if ios { matches!(et, 9 | 10 | 12 | 40 | 41 | 42 | 45 | 49 | 50 | 52 | 75 | 80) } else { n["clickable"].as_bool().unwrap_or(false) };
        out.push((role, text.trim().to_string(), clickable, x, y, w, h));
        for c in n["children"].as_array().into_iter().flatten() { walk(c, out); }
    }
    for r in d["tree"]["hierarchy"].as_array().into_iter().flatten() { walk(r, &mut out); }
    out
}

/// Accessibility audit of the current screen: what a screen-reader user (and an AI agent) can't use.
fn a11y_audit(dev: &str) -> R<Value> {
    let d = handle(&json!({ "op": "dump", "device": dev }))?;
    let ios = ios::is_ios(dev);
    let (sw, sh) = (d["width"].as_f64().unwrap_or(1e9), d["height"].as_f64().unwrap_or(1e9));
    // Minimum touch target: 44x44 pt on iOS; 48x48 dp on Android (px = dp * density / 160).
    let min = if ios { 44.0 } else {
        let dens = shell(dev, "wm density").ok().and_then(|s| s.rsplit(' ').next().and_then(|v| v.trim().parse::<f64>().ok())).unwrap_or(420.0);
        48.0 * dens / 160.0
    };
    let els: Vec<_> = elements(&d).into_iter().filter(|e| e.5 > 0.0 && e.6 > 0.0 && e.3 < sw && e.4 < sh && e.3 + e.5 > 0.0 && e.4 + e.6 > 0.0).collect();
    let mut issues = vec![];
    let mut labels: std::collections::HashMap<String, usize> = Default::default();
    for (i, e) in els.iter().enumerate() {
        if !e.2 { continue; }
        // A control's name can live on a child text view (Android rows): look inside its bounds.
        let named = !e.1.is_empty() || els.iter().any(|o| !o.1.is_empty() && o.3 >= e.3 && o.4 >= e.4 && o.3 + o.5 <= e.3 + e.5 && o.4 + o.6 <= e.4 + e.6);
        let at = json!([e.3.round(), e.4.round(), e.5.round(), e.6.round()]);
        if !named { issues.push(json!({ "issue": "unlabeled_control", "severity": "high", "role": e.0, "box": at, "fix": "add an accessibility label / contentDescription" })); }
        if (e.5 < min || e.6 < min) && named {
            issues.push(json!({ "issue": "small_touch_target", "severity": "medium", "label": e.1, "box": at, "fix": format!("make it at least {:.0} x {:.0}", min, min) }));
        }
        if !e.1.is_empty() { *labels.entry(e.1.to_lowercase()).or_default() += 1; }
        let _ = i;
    }
    for (l, n) in labels.iter().filter(|(_, n)| **n > 1) {
        issues.push(json!({ "issue": "duplicate_label", "severity": "low", "label": l, "count": n, "fix": "give each control a distinct label" }));
    }
    let controls = els.iter().filter(|e| e.2).count();
    let high = issues.iter().filter(|i| i["severity"] == "high").count();
    let score = if controls == 0 { 100 } else { (100.0 * (1.0 - (high as f64 / controls as f64))).round() as i64 };
    Ok(json!({ "app": d["foregroundApp"], "controls": controls, "score": score, "issues": issues }))
}

/// What changed on screen since the previous snapshot/diff (added and removed lines, refs ignored): agents read the change, not the whole tree.
fn diff(dev: &str) -> R<Value> {
    let prev: Vec<String> = cache_get(dev)["last_snapshot"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
    let now = snapshot(dev)?;
    let strip = |l: &str| { let t = l.trim_start(); t.split_once(' ').map(|(_, rest)| rest.to_string()).unwrap_or_default() };
    let cur: Vec<String> = now["snapshot"].as_str().unwrap_or("").lines().map(|l| l.to_string()).collect();
    let cur_keys: std::collections::HashSet<String> = cur.iter().map(|l| strip(l)).collect();
    let prev_keys: std::collections::HashSet<String> = prev.iter().map(|l| strip(l)).collect();
    let added: Vec<&String> = cur.iter().filter(|l| !prev_keys.contains(&strip(l))).collect();
    let removed: Vec<String> = prev.iter().filter(|l| !cur_keys.contains(&strip(l))).map(|l| strip(l)).collect();
    Ok(json!({ "app": now["app"], "first": prev.is_empty(), "added": added, "removed": removed, "unchanged": cur.len() - added.len() }))
}

/// Wait until the screen stops changing (two identical reads in a row).
fn wait_idle(dev: &str, timeout_ms: u64) -> R<Value> {
    let t = std::time::Instant::now();
    let mut last = String::new();
    while t.elapsed().as_millis() < timeout_ms as u128 {
        let d = handle(&json!({ "op": "dump", "device": dev }))?;
        let h = format!("{:?}", elements(&d).iter().map(|e| (e.1.clone(), e.3 as i64, e.4 as i64, e.5 as i64)).collect::<Vec<_>>());
        if h == last { return Ok(json!({ "idle": true, "ms": t.elapsed().as_millis() as u64 })); }
        last = h;
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
    Ok(json!({ "idle": false, "ms": t.elapsed().as_millis() as u64 }))
}

/// A compact text view of the screen, one line per meaningful element, each with a ref (`@e5`) that `tap @e5` accepts.
fn snapshot(dev: &str) -> R<Value> {
    let d = handle(&json!({ "op": "dump", "device": dev }))?;
    let (w, h) = (d["width"].as_f64().unwrap_or(1e9), d["height"].as_f64().unwrap_or(1e9));
    let mut lines = vec![];
    let mut refs = serde_json::Map::new();
    fn walk(n: &Value, depth: usize, w: f64, h: f64, lines: &mut Vec<String>, refs: &mut serde_json::Map<String, Value>) {
        // Android (class/text/content-desc/resource-id/rect) or iOS (elementType/label/value/identifier/frame).
        let ios = n.get("elementType").is_some();
        let (x, y, bw, bh) = if ios {
            let f = &n["frame"]; (f["X"].as_f64().unwrap_or(0.0), f["Y"].as_f64().unwrap_or(0.0), f["Width"].as_f64().unwrap_or(0.0), f["Height"].as_f64().unwrap_or(0.0))
        } else {
            let r = &n["rect"]; (r["x"].as_f64().unwrap_or(0.0), r["y"].as_f64().unwrap_or(0.0), r["width"].as_f64().unwrap_or(0.0), r["height"].as_f64().unwrap_or(0.0))
        };
        let role = if ios {
            const T: &[(u64, &str)] = &[(9, "Button"), (48, "Text"), (49, "TextField"), (50, "SecureField"), (52, "TextView"), (45, "SearchField"), (75, "Cell"), (43, "Image"), (40, "Switch"), (42, "Link"), (80, "Tab"), (21, "NavBar"), (19, "Keyboard")];
            T.iter().find(|(c, _)| Some(*c) == n["elementType"].as_u64()).map(|(_, r)| r.to_string()).unwrap_or_default()
        } else {
            n["class"].as_str().unwrap_or("").rsplit('.').next().unwrap_or("").to_string()
        };
        let text = if ios { n["label"].as_str().filter(|s| !s.is_empty()).or(n["value"].as_str()).unwrap_or("") } else { n["text"].as_str().filter(|s| !s.is_empty()).or(n["content-desc"].as_str()).unwrap_or("") };
        let id = if ios { n["identifier"].as_str().unwrap_or("") } else { n["resource-id"].as_str().unwrap_or("").rsplit('/').next().unwrap_or("") };
        let clickable = !ios && n["clickable"].as_bool().unwrap_or(false) || ios && matches!(role.as_str(), "Button" | "Cell" | "TextField" | "SecureField" | "SearchField" | "Switch" | "Link" | "Tab");
        let on_screen = bw > 0.0 && bh > 0.0 && x < w && y < h && x + bw > 0.0 && y + bh > 0.0;
        if on_screen && (!text.trim().is_empty() || clickable) && role != "Keyboard" {
            let r = format!("e{}", refs.len() + 1);
            refs.insert(r.clone(), json!([x + bw / 2.0, y + bh / 2.0, x, y, bw, bh]));
            let t: String = text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(80).collect();
            lines.push(format!("{}@{r} [{role}]{}{}", "  ".repeat(depth.min(6)), if t.is_empty() { String::new() } else { format!(" \"{t}\"") }, if id.is_empty() { String::new() } else { format!(" #{id}") }));
        }
        for c in n["children"].as_array().into_iter().flatten() { walk(c, depth + 1, w, h, lines, refs); }
    }
    for root in d["tree"]["hierarchy"].as_array().into_iter().flatten() { walk(root, 0, w, h, &mut lines, &mut refs); }
    let boxes: serde_json::Map<String, Value> = refs.iter().map(|(k, v)| (k.clone(), json!([v[2], v[3], v[4], v[5]]))).collect();
    cache_set(dev, "boxes", Value::Object(boxes));
    cache_set(dev, "refs", Value::Object(refs));
    cache_set(dev, "last_snapshot", json!(lines));
    Ok(json!({ "app": d["foregroundApp"], "snapshot": lines.join("\n") }))
}

fn handle(req: &Value) -> R<Value> {
    let op = str_(req, "op")?;
    if op == "boot" {
        if let Some(avd) = req.get("avd").and_then(|v| v.as_str()) {
            if !avd.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') { return Err("invalid AVD name".into()); }
            let sdk = std::env::var("ANDROID_HOME").unwrap_or_else(|_| format!("{}/Library/Android/sdk", std::env::var("HOME").unwrap_or_default()));
            use std::os::unix::process::CommandExt;
            Command::new(format!("{sdk}/emulator/emulator")).args(["-avd", avd, "-no-snapshot-save"]).stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null()).process_group(0).spawn().map_err(|e| format!("emulator: {e}"))?;
            return Ok(json!({ "booting": avd }));
        }
        if let Some(sim) = req.get("simulator").and_then(|v| v.as_str()) { return ios::simctl(&["boot", sim]); }
        return Err("boot --avd <android emulator> | --simulator <iOS simulator udid>".into());
    }
    if op == "devices" {
        let mut v = devices()?;
        if let Some(list) = v["devices"].as_array_mut() { list.extend(ios::devices()); }
        return Ok(v);
    }
    let dev = str_(req, "device")?;
    if op == "snapshot" { return snapshot(dev); }
    if op == "diff" { return diff(dev); }
    if op == "wait_idle" { return wait_idle(dev, req.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(5000)); }
    if op == "a11y_audit" { return a11y_audit(dev); }
    if op == "perf_report" { return perf_report(dev, req); }
    if op == "element_screenshot" { return element_screenshot(dev, req); }
    if op == "visual_check" { return visual_check(dev, req); }
    if op == "deeplink" { return deeplink(dev, req); }
    if op == "gps_route" { return gps_route(dev, req); }
    if op == "ocr" { return ocr(dev); }
    if op == "tap_text" { return tap_text(dev, req); }
    if op == "bug_report" { return bug_report(dev, req); }
    if op == "watch_crashes" { return watch_crashes(dev, req); }
    if op == "replay" { return replay(dev, req); }
    // `tap @e5` / {"ref": "@e5"}: a ref from the last snapshot of this device.
    if let Some(r) = req.get("ref").and_then(|v| v.as_str()) {
        let p = cache_get(dev)["refs"][r.trim_start_matches('@')].clone();
        let (Some(x), Some(y)) = (p[0].as_f64(), p[1].as_f64()) else { return Err(format!("unknown ref {r}: take a snapshot first")) };
        let mut req = req.clone();
        req["x"] = json!(x); req["y"] = json!(y);
        if let Some(o) = req.as_object_mut() { o.remove("ref"); }
        return handle(&req);
    }
    if ios::is_ios(dev) { return ios::handle(op, dev, req, shrink); }
    match op {
        "dump" => dump(dev),
        "foreground" => Ok(json!({ "app": foreground(dev)? })),
        "tap" => {
            let (x, y) = (num(req, "x")?, num(req, "y")?);
            let mode = req.get("mode").and_then(|m| m.as_str()).unwrap_or("single");
            if helper_ok() {
                let hold = if mode == "long" { 800 } else { 0 };
                if agent_call(dev, &format!("tap {x} {y} {hold}")).is_ok() && (mode != "double" || agent_call(dev, &format!("tap {x} {y} 0")).is_ok()) {
                    return Ok(json!({}));
                }
            }
            let cmd = match mode {
                "long" => format!("input swipe {x} {y} {x} {y} 800"),
                "double" => format!("input tap {x} {y} && input tap {x} {y}"),
                _ => format!("input tap {x} {y}"),
            };
            shell(dev, &cmd).map(|_| json!({}))
        }
        "swipe" => {
            let ms = req.get("ms").and_then(|m| m.as_i64()).unwrap_or(300);
            if helper_ok() && agent_call(dev, &format!("swipe {} {} {} {} {ms}", num(req, "x1")?, num(req, "y1")?, num(req, "x2")?, num(req, "y2")?)).is_ok() {
                return Ok(json!({}));
            }
            shell(dev, &format!("input swipe {} {} {} {} {ms}", num(req, "x1")?, num(req, "y1")?, num(req, "x2")?, num(req, "y2")?)).map(|_| json!({}))
        }
        "text" => {
            input_text(dev, str_(req, "text")?)?;
            if req.get("submit").and_then(|s| s.as_bool()).unwrap_or(false) { shell(dev, "input keyevent 66")?; }
            Ok(json!({}))
        }
        "key" => {
            let code = match str_(req, "key")? { "back" => 4, "home" => 3, "recents" => 187, "enter" => 66, k => return Err(format!("unsupported key `{k}`")) };
            if helper_ok() && agent_call(dev, &format!("key {code}")).is_ok() { return Ok(json!({})); }
            shell(dev, &format!("input keyevent {code}")).map(|_| json!({}))
        }
        "launch" => {
            // Start the app's launcher activity by component (brings the app's own screen forward even if another
            // package's activity sits on top of its task, e.g. Settings' search). monkey only resumes the task.
            let app = pkg(req)?;
            let missing = || format!("{app} is not installed or has no launcher activity");
            let comp = shell(dev, &format!("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER {app}"))
                .map_err(|_| missing())?.lines().last().unwrap_or("").trim().to_string();
            if !comp.contains('/') { return Err(missing()); }
            let out = shell(dev, &format!("am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n {comp}"))?;
            if out.contains("Error") { return Err(out.trim().to_string()); }
            Ok(json!({ "activity": comp }))
        }
        "url" => shell(dev, &format!("am start -a android.intent.action.VIEW -d {}", q(str_(req, "url")?))).map(|_| json!({})),
        "apps" => {
            let out = shell(dev, "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER")?;
            let mut apps: Vec<String> = out.lines().filter_map(|l| l.trim().split_once('/').map(|(p, _)| p.to_string())).filter(|p| p.contains('.')).collect();
            apps.sort(); apps.dedup();
            Ok(json!({ "apps": apps }))
        }
        "screenshot" => {
            let max = req.get("max").and_then(|m| m.as_u64()).unwrap_or(0) as u32;
            // Scaled JPEG straight from the on-device helper (the phone's PNG encoder is what makes `screencap -p` slow);
            // full-size PNG, or no helper: screencap.
            if max > 0 && std::env::var("MOBIUS_NO_AGENT").is_err() {
                if let Ok(v) = agent_call(dev, &format!("shot {max}")) { return Ok(v); }
            }
            shrink(&adb(&["-s", dev, "exec-out", "screencap", "-p"])?, max)
        }
        "size" => { let (w, h) = screen_size(dev)?; Ok(json!({ "width": w, "height": h })) }
        "terminate" => { let app = pkg(req)?; shell(dev, &format!("am force-stop {app}")).map(|_| json!({})) }
        "clear_data" => { let app = pkg(req)?; let o = shell(dev, &format!("pm clear {app}"))?; if o.contains("Success") { Ok(json!({})) } else { Err(o.trim().to_string()) } }
        "install" => {
            let path = str_(req, "path")?;
            let o = String::from_utf8_lossy(&adb(&["-s", dev, "install", "-r", "-g", path])?).into_owned();
            if o.contains("Success") { Ok(json!({})) } else { Err(o.trim().to_string()) }
        }
        "uninstall" => { let app = pkg(req)?; let o = String::from_utf8_lossy(&adb(&["-s", dev, "uninstall", app])?).into_owned(); if o.contains("Success") { Ok(json!({})) } else { Err(o.trim().to_string()) } }
        "fill" => {
            // Replace the focused field's text (any language).
            agent_call(dev, &format!("fill {}", base64::engine::general_purpose::STANDARD.encode(str_(req, "text")?)))?;
            Ok(json!({}))
        }
        "orientation" => match req.get("set").and_then(|v| v.as_str()) {
            None => {
                let r = shell(dev, "settings get system user_rotation")?.trim().parse::<i64>().unwrap_or(0);
                Ok(json!({ "orientation": if r % 2 == 1 { "landscape" } else { "portrait" } }))
            }
            Some(o) => {
                let rot = match o { "portrait" => 0, "landscape" => 1, _ => return Err("orientation: portrait|landscape".into()) };
                shell(dev, &format!("settings put system accelerometer_rotation 0; settings put system user_rotation {rot}")).map(|_| json!({}))
            }
        },
        "info" => {
            let p = |k: &str| shell(dev, &format!("getprop {k}")).map(|s| s.trim().to_string()).unwrap_or_default();
            let (w, h) = screen_size(dev)?;
            let battery = shell(dev, "dumpsys battery | grep -m1 ' level:'").ok().and_then(|s| s.split(':').nth(1).and_then(|v| v.trim().parse::<i64>().ok()));
            Ok(json!({ "id": dev, "platform": "android", "model": p("ro.product.model"), "manufacturer": p("ro.product.manufacturer"),
                "version": p("ro.build.version.release"), "sdk": p("ro.build.version.sdk"), "width": w, "height": h, "battery": battery,
                "density": shell(dev, "wm density").ok().and_then(|s| s.rsplit(' ').next().map(|v| v.trim().to_string())) }))
        }
        "reboot" => adb(&["-s", dev, "reboot"]).map(|_| json!({})),
        "fs_ls" => {
            let path = str_(req, "path").unwrap_or("/sdcard");
            let out = with_app(req, &format!("ls -la {}", q(path)))?;
            let entries: Vec<Value> = out.lines().filter(|l| !l.starts_with("total") && l.split_whitespace().count() >= 7).filter_map(|l| {
                let f: Vec<&str> = l.split_whitespace().collect();
                let name = f[7..].join(" ");
                (name != "." && name != "..").then(|| json!({ "name": name, "dir": l.starts_with('d'), "size": f[4].parse::<u64>().unwrap_or(0) }))
            }).collect();
            Ok(json!({ "path": path, "entries": entries }))
        }
        "fs_pull" => {
            let (remote, local) = (str_(req, "path")?, str_(req, "output")?);
            if let Some(app) = req.get("app").and_then(|v| v.as_str()) {
                // App sandbox (debuggable apps): stream through run-as.
                let a = pkg(&json!({ "app": app }))?.to_string();
                let bytes = adb(&["-s", dev, "exec-out", "run-as", &a, "cat", remote])?;
                std::fs::write(local, &bytes).map_err(|e| e.to_string())?;
                return Ok(json!({ "saved": local, "bytes": bytes.len() }));
            }
            adb(&["-s", dev, "pull", remote, local])?;
            Ok(json!({ "saved": local, "bytes": std::fs::metadata(local).map(|m| m.len()).unwrap_or(0) }))
        }
        "fs_push" => {
            let (local, remote) = (str_(req, "file")?, str_(req, "path")?);
            adb(&["-s", dev, "push", local, remote])?;
            Ok(json!({ "pushed": remote }))
        }
        "app_path" => {
            let app = pkg(req)?;
            let paths: Vec<String> = shell(dev, &format!("pm path {app}"))?.lines().filter_map(|l| l.strip_prefix("package:").map(String::from)).collect();
            if paths.is_empty() { return Err(format!("{app} is not installed")); }
            let data = shell(dev, &format!("run-as {app} pwd 2>/dev/null")).map(|s| s.trim().to_string()).unwrap_or_default();
            Ok(json!({ "app": app, "apks": paths, "data_dir": if data.starts_with('/') { json!(data) } else { json!(format!("/data/data/{app}")) } }))
        }
        "settings" => {
            let ns = req.get("namespace").and_then(|v| v.as_str()).unwrap_or("system");
            if !matches!(ns, "system" | "secure" | "global") { return Err("namespace: system | secure | global".into()); }
            let key = str_(req, "key")?;
            if !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') { return Err("invalid settings key".into()); }
            match req.get("set").and_then(|v| v.as_str()) {
                Some(v) => shell(dev, &format!("settings put {ns} {key} {}", q(v))).map(|_| json!({})),
                None => Ok(json!({ "value": shell(dev, &format!("settings get {ns} {key}"))?.trim() })),
            }
        }
        "keys" => {
            // "volume_up", "power", "tab", or combinations like "ctrl+a"
            let combo = str_(req, "keys")?;
            let codes: R<Vec<String>> = combo.split('+').map(|k| keycode(k.trim())).collect();
            let codes = codes?;
            let cmd = if codes.len() == 1 { format!("input keyevent {}", codes[0]) } else { format!("input keycombination {}", codes.join(" ")) };
            shell(dev, &cmd).map(|_| json!({}))
        }
        "pinch" => {
            // scale > 1 zooms in (fingers apart), < 1 zooms out.
            let (x, y) = (num(req, "x")?, num(req, "y")?);
            let scale = req.get("scale").and_then(|v| v.as_f64()).unwrap_or(2.0).clamp(0.1, 10.0);
            let (w, _) = physical_size(dev)?;
            let base = (w as f64 * 0.25).max(80.0);
            let (d0, d1) = if scale >= 1.0 { (base, (base * scale).min(w as f64 * 0.9)) } else { (base / scale.max(0.1), base) };
            let (d0, d1) = if scale >= 1.0 { (d0, d1) } else { (d0.min(w as f64 * 0.9), d1) };
            agent_call(dev, &format!("pinch {x} {y} {} {} {}", d0 as i64, d1 as i64, req.get("ms").and_then(|v| v.as_i64()).unwrap_or(400))).map(|_| json!({}))
        }
        "boot" => {
            // Android emulators by AVD name: `boot --avd Pixel_8` (no device needed).
            Err("use: mobiusagent-driver boot --avd <name>".into())
        }
        "shutdown" => {
            if !dev.starts_with("emulator-") { return Err("only emulators can be shut down".into()); }
            adb(&["-s", dev, "emu", "kill"]).map(|_| json!({}))
        }
        "webviews" => {
            // Web pages inside apps (Chrome, and WebViews with debugging enabled), via their DevTools sockets.
            let unix = shell(dev, "cat /proc/net/unix")?;
            let mut socks: Vec<String> = unix.lines().filter_map(|l| l.split_whitespace().last()).filter(|n| n.starts_with('@') && n.contains("devtools_remote"))
                .map(|n| n.trim_start_matches('@').to_string()).collect();
            socks.sort(); socks.dedup();
            let mut pages = vec![];
            for sock in socks {
                let app = sock.rsplit('_').next().and_then(|pid| pid.parse::<u64>().ok())
                    .and_then(|pid| shell(dev, &format!("cat /proc/{pid}/cmdline")).ok()).map(|c| c.trim_matches('\0').split('\0').next().unwrap_or("").to_string())
                    .unwrap_or_else(|| if sock.starts_with("chrome") { "com.android.chrome".into() } else { String::new() });
                let Ok(port) = devtools_port(dev, &sock) else { continue };
                let Ok(list) = http_get_json(port, "/json/list") else { continue };
                for p in list.as_array().into_iter().flatten().filter(|p| p["type"] == "page") {
                    pages.push(json!({ "socket": sock, "app": app, "id": p["id"], "title": p["title"], "url": p["url"] }));
                }
            }
            Ok(json!({ "pages": pages }))
        }
        "webview_eval" | "webview_dom" => {
            let sock = str_(req, "socket")?;
            if !sock.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') { return Err("invalid socket".into()); }
            let port = devtools_port(dev, sock)?;
            let list = http_get_json(port, "/json/list")?;
            let page = match req.get("id").and_then(|v| v.as_str()) {
                Some(id) => list.as_array().into_iter().flatten().find(|p| p["id"] == id),
                None => list.as_array().into_iter().flatten().find(|p| p["type"] == "page"),
            }.ok_or("no such page")?.clone();
            let ws = page["webSocketDebuggerUrl"].as_str().ok_or("page has no debugger URL (already attached?)")?.replace("localhost", "127.0.0.1");
            let ws = ws.split_once("/devtools/").map(|(_, p)| format!("ws://127.0.0.1:{port}/devtools/{p}")).unwrap_or(ws);
            let expr = if op == "webview_dom" { "document.documentElement.outerHTML".to_string() } else { str_(req, "js")?.to_string() };
            let (mut sock, _) = tungstenite::connect(ws.as_str()).map_err(|e| format!("devtools: {e}"))?;
            sock.send(tungstenite::Message::text(json!({ "id": 1, "method": "Runtime.evaluate", "params": { "expression": expr, "returnByValue": true, "awaitPromise": true } }).to_string())).map_err(|e| e.to_string())?;
            loop {
                let m = sock.read().map_err(|e| e.to_string())?;
                let Ok(v) = serde_json::from_str::<Value>(m.to_text().unwrap_or("")) else { continue };
                if v["id"] != 1 { continue; }
                if let Some(ex) = v["result"]["exceptionDetails"].as_object() { return Err(format!("js: {}", ex.get("text").and_then(|t| t.as_str()).unwrap_or("exception"))); }
                let val = v["result"]["result"]["value"].clone();
                let val = if op == "webview_dom" { json!(val.as_str().unwrap_or("").chars().take(req.get("max_chars").and_then(|m| m.as_u64()).unwrap_or(200_000) as usize).collect::<String>()) } else { val };
                return Ok(json!({ "url": page["url"], "title": page["title"], "value": val }));
            }
        }
        "flow_record_start" => {
            // Capture a human's touches from the input devices until flow_record_stop.
            shell(dev, "pkill -f '[g]etevent -lt'; rm -f /data/local/tmp/mobius-events.txt; true")?;
            shell(dev, "nohup getevent -lt > /data/local/tmp/mobius-events.txt 2>/dev/null &")?;
            cache_set(dev, "flow_started", json!(now_ms()));
            Ok(json!({ "recording": true, "hint": "use the phone, then run flow_record_stop" }))
        }
        "flow_record_stop" => {
            shell(dev, "pkill -f '[g]etevent -lt'; true")?;
            let raw = shell(dev, "cat /data/local/tmp/mobius-events.txt")?;
            let _ = shell(dev, "rm -f /data/local/tmp/mobius-events.txt");
            // Raw ranges per device → screen pixels.
            let mut maxes: std::collections::HashMap<String, (f64, f64)> = Default::default();
            let mut cur = String::new();
            for l in shell(dev, "getevent -lp")?.lines() {
                if let Some(d) = l.strip_prefix("add device ").and_then(|r| r.split_once(": ")).map(|(_, p)| p.trim().to_string()) { cur = d; }
                let max = || l.split("max ").nth(1).and_then(|r| r.split(',').next()).and_then(|v| v.trim().parse::<f64>().ok());
                if l.contains("ABS_MT_POSITION_X") { if let Some(m) = max() { maxes.entry(cur.clone()).or_insert((m, m)).0 = m; } }
                if l.contains("ABS_MT_POSITION_Y") { if let Some(m) = max() { maxes.entry(cur.clone()).or_insert((m, m)).1 = m; } }
            }
            let (sw, sh) = physical_size(dev)?;
            // Frames end at SYN_REPORT; the kernel only reports axes that changed, so positions carry over per device
            // (and across recordings, from the cache).
            let mut pos: std::collections::HashMap<String, (f64, f64)> = serde_json::from_value(cache_get(dev)["touch_pos"].clone()).unwrap_or_default();
            let mut steps = vec![];
            let mut t0: Option<f64> = None;
            let (mut finger, mut lift) = (None::<bool>, false);
            let mut down: Option<(f64, String)> = None; // (time, device)
            let mut path: Vec<(f64, f64)> = vec![];
            for l in raw.lines() {
                let Some(ts) = l.trim_start().strip_prefix('[').and_then(|r| r.split(']').next()).and_then(|v| v.trim().parse::<f64>().ok()) else { continue };
                let Some((devp, ev)) = l.split(']').nth(1).and_then(|r| r.split_once(':')) else { continue };
                let devp = devp.trim().to_string();
                let (mx, my) = maxes.get(&devp).copied().unwrap_or((sw as f64, sh as f64));
                let f: Vec<&str> = ev.split_whitespace().collect();
                if f.len() < 3 { continue; }
                let val = |s: &str| i64::from_str_radix(s, 16).unwrap_or(0) as f64;
                let p = pos.entry(devp.clone()).or_insert((0.0, 0.0));
                match (f[1], f[2]) {
                    ("ABS_MT_POSITION_X", v) => p.0 = (val(v) / mx * sw as f64).round(),
                    ("ABS_MT_POSITION_Y", v) => p.1 = (val(v) / my * sh as f64).round(),
                    ("BTN_TOUCH", "UP") | ("ABS_MT_TRACKING_ID", "ffffffff") => lift = true,
                    ("BTN_TOUCH", "DOWN") | ("ABS_MT_TRACKING_ID", _) => finger = Some(true),
                    ("SYN_REPORT", _) => {
                        let at = *p;
                        if finger.take().is_some() && down.is_none() { t0.get_or_insert(ts); down = Some((ts, devp.clone())); path = vec![at]; }
                        else if down.is_some() { path.push(at); }
                        if std::mem::take(&mut lift) {
                            if let Some((td, _)) = down.take() {
                                let (start, end) = (path[0], *path.last().unwrap());
                                let at_ms = ((td - t0.unwrap_or(td)) * 1000.0).round() as u64;
                                let held = ((ts - td) * 1000.0).round() as u64;
                                let moved = ((end.0 - start.0).powi(2) + (end.1 - start.1).powi(2)).sqrt();
                                steps.push(if moved > 30.0 { json!({ "op": "swipe", "x1": start.0, "y1": start.1, "x2": end.0, "y2": end.1, "ms": held.max(80), "at_ms": at_ms }) }
                                    else if held > 600 { json!({ "op": "tap", "mode": "long", "x": start.0, "y": start.1, "at_ms": at_ms }) }
                                    else { json!({ "op": "tap", "x": start.0, "y": start.1, "at_ms": at_ms }) });
                            }
                        }
                    }
                    _ => {}
                }
            }
            cache_set(dev, "touch_pos", serde_json::to_value(&pos).unwrap_or_default());
            let flow = json!({ "platform": "android", "screen": [sw, sh], "steps": steps });
            if let Some(out) = req.get("output").and_then(|v| v.as_str()) { std::fs::write(out, serde_json::to_string_pretty(&flow).unwrap()).map_err(|e| e.to_string())?; }
            Ok(flow)
        }
        "notifications" => {
            // Posted notifications (title, text, app). Codes that look like OTPs are masked: the model never needs them.
            let out = shell(dev, "dumpsys notification --noredact")?;
            let mut list = vec![];
            for block in out.split("NotificationRecord(").skip(1) {
                let pkg = block.split("pkg=").nth(1).and_then(|r| r.split_whitespace().next()).unwrap_or("").to_string();
                let field = |k: &str| block.lines().find(|l| l.trim_start().starts_with(k)).and_then(|l| l.split_once("=")).map(|(_, v)| {
                    let v = v.trim(); let v = v.split_once('(').map(|(_, r)| r.trim_end_matches(')')).unwrap_or(v); v.trim().to_string() });
                let (title, text) = (field("android.title="), field("android.text="));
                if title.is_none() && text.is_none() { continue; }
                list.push(json!({ "app": pkg, "title": title.map(|t| mask_codes(&t)), "text": text.map(|t| mask_codes(&t)) }));
            }
            Ok(json!({ "notifications": list }))
        }
        "biometric" => {
            // Emulators: fingerprint touch. match → an enrolled finger (id 1), fail → an unknown one.
            if !dev.starts_with("emulator-") { return Err("biometric simulation works on emulators (real phones need a real finger)".into()); }
            let ok = req.get("match").and_then(|v| v.as_bool()).unwrap_or(true);
            adb(&["-s", dev, "emu", "finger", "touch", if ok { "1" } else { "99" }]).map(|_| json!({ "matched": ok }))
        }
        "perf" => {
            // App performance right now: memory (PSS), CPU, and frame rendering (janky frames) since the last reset.
            let app = pkg(req)?;
            let mem = shell(dev, &format!("dumpsys meminfo {app}"))?;
            if mem.contains("No process found") { return Err(format!("{app} is not running")); }
            // "TOTAL PSS:  123456 ..." (newer) or "TOTAL   123456 ..." (older)
            let mem_kb = mem.lines().find(|l| l.trim_start().starts_with("TOTAL")).and_then(|l| l.split_whitespace().find_map(|t| t.parse::<u64>().ok()));
            let cpu = shell(dev, &format!("top -b -n 1 | grep -m1 ' {app}$'"))?.split_whitespace().nth(8).and_then(|v| v.parse::<f64>().ok());
            let gfx = shell(dev, &format!("dumpsys gfxinfo {app}"))?;
            let grab = |k: &str| gfx.lines().find(|l| l.trim_start().starts_with(k)).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string());
            if req.get("reset").and_then(|v| v.as_bool()).unwrap_or(false) { let _ = shell(dev, &format!("dumpsys gfxinfo {app} reset")); }
            Ok(json!({ "app": app, "memory_mb": mem_kb.map(|k| (k as f64 / 1024.0 * 10.0).round() / 10.0), "cpu_percent": cpu,
                "frames": grab("Total frames rendered"), "janky_frames": grab("Janky frames"), "p90_ms": grab("90th percentile"), "p99_ms": grab("99th percentile") }))
        }
        "dark_mode" => match req.get("on").and_then(|v| v.as_bool()) {
            Some(on) => shell(dev, &format!("cmd uimode night {}", if on { "yes" } else { "no" })).map(|_| json!({})),
            None => Ok(json!({ "on": shell(dev, "cmd uimode night")?.contains("yes") })),
        },
        "font_scale" => {
            let v = req.get("scale").and_then(|v| v.as_f64()).ok_or("missing `scale` (e.g. 1.3)")?.clamp(0.5, 2.0);
            shell(dev, &format!("settings put system font_scale {v}")).map(|_| json!({}))
        }
        "app_locale" => {
            let app = pkg(req)?;
            let loc = str_(req, "locale")?;
            if !loc.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ',') { return Err("invalid locale".into()); }
            shell(dev, &format!("cmd locale set-app-locales {app} --locales {loc}")).map(|_| json!({}))
        }
        "battery" => match req.get("level").and_then(|v| v.as_u64()) {
            Some(l) => shell(dev, &format!("dumpsys battery unplug; dumpsys battery set level {}", l.min(100))).map(|_| json!({})),
            None => shell(dev, "dumpsys battery reset").map(|_| json!({ "reset": true })),
        },
        "network" => {
            // Emulator network shaping: full | lte | hsdpa | umts | edge | gprs; airplane on/off works everywhere.
            if let Some(on) = req.get("airplane").and_then(|v| v.as_bool()) {
                return shell(dev, &format!("cmd connectivity airplane-mode {}", if on { "enable" } else { "disable" })).map(|_| json!({}));
            }
            let speed = str_(req, "speed")?;
            if !matches!(speed, "full" | "lte" | "hsdpa" | "umts" | "edge" | "gprs") { return Err("speed: full | lte | hsdpa | umts | edge | gprs".into()); }
            adb(&["-s", dev, "emu", "network", "speed", speed]).map(|_| json!({})).map_err(|_| "network speed: emulators only".to_string())
        }
        "permission" => {
            let app = pkg(req)?;
            let perm = str_(req, "permission")?;
            let perm = if perm.contains('.') { perm.to_string() } else { format!("android.permission.{}", perm.to_ascii_uppercase()) };
            if !perm.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') { return Err("invalid permission".into()); }
            let grant = req.get("grant").and_then(|v| v.as_bool()).unwrap_or(true);
            shell(dev, &format!("pm {} {app} {perm}", if grant { "grant" } else { "revoke" })).map(|o| json!({ "output": o.trim() }))
        }
        "crashes" => {
            // App crashes, native crashes and ANRs the system recorded (dropbox), newest first.
            let mut out = vec![];
            for tag in ["data_app_crash", "data_app_native_crash", "data_app_anr", "system_app_crash"] {
                let text = shell(dev, &format!("dumpsys dropbox --print {tag}"))?;
                for entry in text.split("========================================").filter(|e| !e.trim().is_empty()) {
                    let mut lines = entry.trim().lines();
                    let head = lines.next().unwrap_or("");
                    if !head.contains(tag) { continue; }
                    let when = head.split(tag).next().unwrap_or("").trim().to_string();
                    let body: Vec<&str> = lines.collect();
                    let process = body.iter().find_map(|l| l.strip_prefix("Process: ")).unwrap_or("").to_string();
                    let summary = body.iter().find(|l| l.contains("Exception") || l.contains("Error") || l.starts_with("Subject:") || l.contains("signal")).map(|l| l.trim().to_string()).unwrap_or_default();
                    out.push(json!({ "id": format!("{tag}@{when}"), "type": tag, "time": when, "process": process, "summary": summary }));
                }
            }
            out.sort_by(|a, b| b["time"].as_str().cmp(&a["time"].as_str()));
            Ok(json!({ "crashes": out }))
        }
        "crash" => {
            let id = str_(req, "id")?;
            let (tag, when) = id.split_once('@').ok_or("crash id looks like data_app_crash@2026-11-12 10:00:00")?;
            if !tag.chars().all(|c| c.is_ascii_lowercase() || c == '_') { return Err("invalid crash id".into()); }
            let text = shell(dev, &format!("dumpsys dropbox --print {tag}"))?;
            let entry = text.split("========================================").find(|e| e.trim().starts_with(when)).ok_or("no such crash")?;
            Ok(json!({ "id": id, "text": entry.trim() }))
        }
        "record_start" => {
            let limit = req.get("time_limit").and_then(|v| v.as_u64()).unwrap_or(180).min(180);
            shell(dev, "pkill -INT screenrecord; true")?;
            shell(dev, &format!("nohup screenrecord --time-limit {limit} /sdcard/mobius-recording.mp4 >/dev/null 2>&1 &"))?;
            cache_set(dev, "recording", json!({ "started": now_ms() }));
            Ok(json!({ "recording": true, "time_limit_s": limit }))
        }
        "record_stop" => {
            let output = str_(req, "output").map(String::from).unwrap_or_else(|_| format!("mobius-recording-{}.mp4", now_ms()));
            shell(dev, "pkill -INT screenrecord; true")?;
            // screenrecord finalizes the MP4 after SIGINT: wait for it to exit.
            for _ in 0..50 {
                if shell(dev, "pidof screenrecord").map(|s| s.trim().is_empty()).unwrap_or(true) { break; }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            adb(&["-s", dev, "pull", "/sdcard/mobius-recording.mp4", &output])?;
            let _ = shell(dev, "rm -f /sdcard/mobius-recording.mp4");
            let started = cache_get(dev)["recording"]["started"].as_u64().unwrap_or(0);
            let bytes = std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
            Ok(json!({ "saved": output, "bytes": bytes, "seconds": if started > 0 { (now_ms() - started) / 1000 } else { 0 } }))
        }
        "logs" => {
            // Recent logcat lines, newest last; optional app filter by its process id(s).
            let n = req.get("lines").and_then(|v| v.as_u64()).unwrap_or(200).min(5000);
            let mut cmd = format!("logcat -d -v threadtime -t {n}");
            if let Some(app) = req.get("app").and_then(|v| v.as_str()) {
                if !app.chars().all(|c| c.is_alphanumeric() || c == '.' || c == '_') { return Err("invalid package name".into()); }
                let pids = shell(dev, &format!("pidof {app}"))?.split_whitespace().collect::<Vec<_>>().join(",");
                if pids.is_empty() { return Err(format!("{app} is not running")); }
                cmd = format!("logcat -d -v threadtime -t {n} --pid={}", pids.split(',').next().unwrap());
            }
            Ok(json!({ "lines": shell(dev, &cmd)?.lines().map(String::from).collect::<Vec<_>>() }))
        }
        "hide_keyboard" => {
            let shown = shell(dev, "dumpsys input_method | grep -m1 mInputShown")?.contains("mInputShown=true");
            if shown { shell(dev, "input keyevent 111")?; } // ESCAPE closes the IME without navigating back
            Ok(json!({ "was_shown": shown }))
        }
        "location" => {
            // Emulators only: real Android phones need a mock-location app.
            let (lat, lon) = (req["lat"].as_f64().ok_or("missing `lat`")?, req["lon"].as_f64().ok_or("missing `lon`")?);
            adb(&["-s", dev, "emu", "geo", "fix", &lon.to_string(), &lat.to_string()]).map(|_| json!({})).map_err(|_| "location: only emulators can be moved".to_string())
        }
        "clipboard" => match req.get("set").and_then(|v| v.as_str()) {
            // Through the helper: the system clipboard service (Android has no clipboard shell command on most versions).
            Some(t) => agent_call(dev, &format!("clip_set {}", base64::engine::general_purpose::STANDARD.encode(t))).map(|_| json!({})),
            None => agent_call(dev, "clip_get").map(|v| json!({ "text": v["text"] })),
        },
        _ => Err(format!("unknown op `{op}`")),
    }
}

/// CLI mode, one command per process:
///   mobiusagent-driver devices
///   mobiusagent-driver dump|apps|foreground|size|info|hide_keyboard [--device ID]
///   mobiusagent-driver tap 120,300 [--mode long|double]      swipe 200,600,200,300 [--ms 300]
///   mobiusagent-driver text "hello" [--submit]                fill "नमस्ते"        key back|home|recents|enter
///   mobiusagent-driver launch|terminate|uninstall|clear_data com.app      install app.apk      url https://…
///   mobiusagent-driver screenshot [--max 768] [--output shot.png]       orientation [--set portrait|landscape]
///   mobiusagent-driver location 12.97,77.59      clipboard [--set "text"]      logs [--lines 200] [--app com.app]
/// No arguments: JSON-lines server on stdin/stdout (what Mobius uses).
fn cli(args: Vec<String>) -> i32 {
    let op = args[0].clone();
    let mut req = json!({ "id": 1, "op": op });
    let mut pos = vec![];
    let mut i = 1;
    while i < args.len() {
        if let Some(k) = args[i].strip_prefix("--") {
            let flag = matches!(k, "submit" | "json" | "reset");
            let v = if flag { Value::Bool(true) } else { i += 1; let raw = args.get(i).cloned().unwrap_or_default(); match raw.as_str() { "true" => json!(true), "false" => json!(false),
                _ => raw.parse::<i64>().map(|n| json!(n)).or_else(|_| raw.parse::<f64>().map(|n| json!(n))).unwrap_or(Value::String(raw)) } };
            req[k] = v;
        } else { pos.push(args[i].clone()); }
        i += 1;
    }
    let nums = |s: &str| s.split(',').filter_map(|t| t.trim().parse::<f64>().ok()).collect::<Vec<_>>();
    let first = pos.first().cloned().unwrap_or_default();
    match op.as_str() {
        "tap" => { if first.starts_with('@') { req["ref"] = json!(first); } else { let n = nums(&first); if n.len() == 2 { req["x"] = json!(n[0]); req["y"] = json!(n[1]); } } }
        "swipe" => { let n = nums(&first); if n.len() == 4 { req["x1"] = json!(n[0]); req["y1"] = json!(n[1]); req["x2"] = json!(n[2]); req["y2"] = json!(n[3]); } }
        "location" => { let n = nums(&first); if n.len() == 2 { req["lat"] = json!(n[0]); req["lon"] = json!(n[1]); } }
        "text" | "fill" => req["text"] = json!(first),
        "key" => req["key"] = json!(first),
        "launch" | "terminate" | "uninstall" | "clear_data" => req["app"] = json!(first),
        "install" => req["path"] = json!(first),
        "url" => req["url"] = json!(first),
        _ => {}
    }
    if req.get("device").is_none() && op != "devices" {
        let online: Vec<String> = handle(&json!({ "op": "devices" })).ok().and_then(|v| v["devices"].as_array().cloned()).unwrap_or_default()
            .into_iter().filter(|d| d["state"] == "online").filter_map(|d| d["id"].as_str().map(String::from)).collect();
        if online.len() != 1 { eprintln!("pass --device (online: {})", online.join(", ")); return 2; }
        req["device"] = json!(online[0]);
    }
    let output = req.get("output").and_then(|v| v.as_str()).map(String::from);
    match handle(&req) {
        Ok(data) => {
            if let (Some(path), Some(b64)) = (output, data["data"].as_str()) {
                let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
                if let Err(e) = std::fs::write(&path, bytes) { eprintln!("{e}"); return 1; }
                println!("{}", json!({ "status": "ok", "data": { "saved": path, "mimeType": data["mimeType"] } }));
            } else if op == "snapshot" && req.get("json").is_none() {
                println!("{}", data["snapshot"].as_str().unwrap_or(""));
            } else {
                println!("{}", json!({ "status": "ok", "data": data }));
            }
            0
        }
        Err(e) => { println!("{}", json!({ "status": "error", "error": e })); 1 }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(args.first().map(String::as_str), Some("-h" | "--help" | "help")) {
        println!("mobiusagent-driver: Mobius device driver (Android + iOS). Run with a command (e.g. `devices`, `tap 100,200 --device ID`), or with no arguments for the JSON-lines server.");
        return;
    }
    if args.first().map(String::as_str) == Some("__record") {
        let a = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
        std::process::exit(ios::record(a(1), a(2), a(3).parse().unwrap_or(180)));
    }
    if args.first().map(String::as_str) == Some("__wda-host") {
        std::process::exit(ios::wda_host(args.get(1).map(String::as_str).unwrap_or("")));
    }
    if !args.is_empty() { std::process::exit(cli(args)); }
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let resp = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                match handle(&req) {
                    Ok(data) => json!({ "id": id, "ok": true, "data": data }),
                    Err(e) => json!({ "id": id, "ok": false, "error": e }),
                }
            }
            Err(e) => json!({ "id": null, "ok": false, "error": format!("bad request: {e}") }),
        };
        let _ = writeln!(out, "{resp}");
        let _ = out.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tree_nests_and_keeps_password_flag() {
        let xml = r#"<?xml version='1.0'?><hierarchy rotation="1"><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]" clickable="false"><node class="android.widget.EditText" text="" password="true" resource-id="com.x:id/pin" bounds="[10,20][110,70]" clickable="true" /><node class="android.widget.Button" text="Pay &amp; go" bounds="[0,100][500,200]" clickable="true"></node></node></hierarchy>"#;
        let (t, rot) = parse_tree(xml).unwrap();
        assert_eq!(rot, 1);
        let root = &t["hierarchy"][0];
        assert_eq!(root["children"].as_array().unwrap().len(), 2);
        assert_eq!(root["children"][0]["password"], true);
        assert_eq!(root["children"][0]["rect"], json!({"x":10,"y":20,"width":100,"height":50}));
        assert_eq!(root["children"][1]["text"], "Pay & go");
    }
    #[test]
    fn quoting_survives_shell_metacharacters() {
        assert_eq!(q("it's; rm -rf /"), r"'it'\''s; rm -rf /'");
    }
}
