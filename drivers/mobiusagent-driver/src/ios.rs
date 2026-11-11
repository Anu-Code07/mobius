//! iOS backend: WebDriverAgent (Appium, BSD-3) on the phone, reached over USB through macOS's usbmuxd. No Go/Node helpers.
//!
//! WebDriverAgent is built and signed once with `ios-agent/setup.sh`; the runner is then started on demand with
//! `xcodebuild test-without-building` and kept running.

use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

type R<T> = Result<T, String>;
const WDA_PORT: u16 = 8100;

/// iOS simulator ids are UUIDs: 8-4-4-4-12 hex.
pub fn is_sim(id: &str) -> bool {
    id.len() == 36 && id.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() })
}
/// Any iOS target (real iPhone or simulator).
pub fn is_ios(id: &str) -> bool { is_udid(id) || is_sim(id) }

trait Stream: Read + Write {}
impl<T: Read + Write> Stream for T {}

/// A TCP stream to `port` on the phone: through usbmuxd for real iPhones, plain localhost for simulators.
fn connect(udid: &str, port: u16) -> R<Box<dyn Stream>> {
    if is_sim(udid) {
        let s = std::net::TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("simulator WebDriverAgent on :{port}: {e}"))?;
        s.set_read_timeout(Some(Duration::from_secs(60))).ok();
        return Ok(Box::new(s));
    }
    Ok(Box::new(mux_connect(udid, port)?))
}

/// iOS device ids: "00008140-000964E93610401C" (newer) or 40 hex chars (older).
pub fn is_udid(id: &str) -> bool {
    (id.len() == 25 && id.as_bytes().get(8) == Some(&b'-') || id.len() == 40) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

// ---------- usbmuxd ----------

fn mux_send(s: &mut UnixStream, msg: &plist::Dictionary, tag: u32) -> R<()> {
    let mut body = vec![];
    plist::to_writer_xml(&mut body, msg).map_err(|e| e.to_string())?;
    let mut hdr = Vec::with_capacity(16);
    for v in [16 + body.len() as u32, 1, 8, tag] { hdr.extend_from_slice(&v.to_le_bytes()); }
    s.write_all(&hdr).and_then(|_| s.write_all(&body)).map_err(|e| format!("usbmuxd: {e}"))
}
fn mux_recv(s: &mut UnixStream) -> R<plist::Dictionary> {
    let mut hdr = [0u8; 16];
    s.read_exact(&mut hdr).map_err(|e| format!("usbmuxd: {e}"))?;
    let len = u32::from_le_bytes(hdr[0..4].try_into().unwrap()) as usize;
    let mut body = vec![0u8; len.saturating_sub(16)];
    s.read_exact(&mut body).map_err(|e| format!("usbmuxd: {e}"))?;
    plist::from_bytes(&body).map_err(|e| format!("usbmuxd reply: {e}"))
}
fn mux_msg(kind: &str) -> plist::Dictionary {
    let mut d = plist::Dictionary::new();
    d.insert("MessageType".into(), kind.into());
    d.insert("ProgName".into(), "mobiusagent-driver".into());
    d.insert("ClientVersionString".into(), "mobiusagent-driver-0.1".into());
    d
}

static MUX_IDS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// usbmuxd's DeviceID for a UDID, cached (it only changes on re-plug, and then Connect fails and we look it up again).
fn mux_device_id_cached(udid: &str) -> R<u64> {
    if let Some(id) = MUX_IDS.lock().unwrap().get_or_insert_with(HashMap::new).get(udid) { return Ok(*id); }
    let id = mux_device_id(udid)?;
    MUX_IDS.lock().unwrap().get_or_insert_with(HashMap::new).insert(udid.to_string(), id);
    Ok(id)
}

/// usbmuxd's DeviceID for a UDID (USB-attached devices only).
fn mux_device_id(udid: &str) -> R<u64> {
    let mut s = UnixStream::connect("/var/run/usbmuxd").map_err(|e| format!("usbmuxd: {e}"))?;
    mux_send(&mut s, &mux_msg("ListDevices"), 1)?;
    let r = mux_recv(&mut s)?;
    let want = udid.replace('-', "");
    for d in r.get("DeviceList").and_then(|v| v.as_array()).into_iter().flatten() {
        let Some(d) = d.as_dictionary() else { continue };
        let props = d.get("Properties").and_then(|p| p.as_dictionary());
        let serial = props.and_then(|p| p.get("SerialNumber")).and_then(|v| v.as_string()).unwrap_or("").replace('-', "");
        let usb = props.and_then(|p| p.get("ConnectionType")).and_then(|v| v.as_string()) == Some("USB");
        if serial.eq_ignore_ascii_case(&want) && usb {
            return d.get("DeviceID").and_then(|v| v.as_unsigned_integer()).ok_or("usbmuxd: no DeviceID".into());
        }
    }
    Err(format!("{udid} is not connected over USB"))
}

/// A raw TCP stream to `port` on the phone.
fn mux_connect(udid: &str, port: u16) -> R<UnixStream> {
    match mux_connect_id(udid, port, mux_device_id_cached(udid)?) {
        Ok(s) => Ok(s),
        Err(_) => { // re-plugged: fresh DeviceID
            MUX_IDS.lock().unwrap().get_or_insert_with(HashMap::new).remove(udid);
            mux_connect_id(udid, port, mux_device_id_cached(udid)?)
        }
    }
}
fn mux_connect_id(udid: &str, port: u16, id: u64) -> R<UnixStream> {
    let mut s = UnixStream::connect("/var/run/usbmuxd").map_err(|e| format!("usbmuxd: {e}"))?;
    let mut m = mux_msg("Connect");
    m.insert("DeviceID".into(), plist::Value::Integer(id.into()));
    m.insert("PortNumber".into(), plist::Value::Integer((port.swap_bytes() as u64).into())); // network byte order
    mux_send(&mut s, &m, 2)?;
    let r = mux_recv(&mut s)?;
    match r.get("Number").and_then(|v| v.as_unsigned_integer()) {
        Some(0) => { s.set_read_timeout(Some(Duration::from_secs(60))).ok(); Ok(s) }
        n => Err(format!("nothing listening on port {port} of {udid} (usbmuxd result {n:?})")),
    }
}

// ---------- HTTP/1.1 over the tunnel (one request per connection) ----------

fn http(udid: &str, method: &str, path: &str, body: Option<&Value>) -> R<Value> {
    let mut s = connect(udid, WDA_PORT)?;
    let b = body.filter(|b| !b.is_null()).map(|b| b.to_string()).unwrap_or_default();
    let req = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{b}", b.len());
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = vec![];
    s.read_to_end(&mut raw).map_err(|e| format!("WebDriverAgent {path}: {e}"))?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("bad HTTP reply")?;
    let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    let mut payload = raw[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") { payload = dechunk(&payload); }
    let status = head.lines().next().unwrap_or("").to_string();
    let v: Value = serde_json::from_slice(&payload).map_err(|e| format!("WebDriverAgent {method} {path}: {status}: {e}"))?;
    if let Some(err) = v.get("value").and_then(|x| x.get("error")).and_then(|x| x.as_str()) {
        let msg = v["value"]["message"].as_str().unwrap_or("");
        return Err(format!("WebDriverAgent: {err}: {}", msg.lines().next().unwrap_or("")));
    }
    Ok(v)
}
fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    while let Some(i) = b.windows(2).position(|w| w == b"\r\n") {
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[..i]).trim(), 16).unwrap_or(0);
        if n == 0 || b.len() < i + 2 + n { break; }
        out.extend_from_slice(&b[i + 2..i + 2 + n]);
        b = &b[(i + 4 + n).min(b.len())..];
    }
    out
}

// ---------- WebDriverAgent lifecycle ----------

static RUNNERS: Mutex<Option<HashMap<String, Child>>> = Mutex::new(None);
static SESSIONS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn wda_home() -> std::path::PathBuf {
    std::env::var("MOBIUS_WDA_DIR").map(Into::into).unwrap_or_else(|_| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".mobius/wda"))
}

/// Runner app installed by ios-agent/setup.sh ("Mobius Agent").
fn runner_bundle() -> String { std::env::var("MOBIUS_WDA_BUNDLE").map(|b| format!("{b}.xctrunner")).unwrap_or_else(|_| "dev.mobius.wda.xctrunner".into()) }

/// `mobiusagent-driver __wda-host <udid>`: a small background process that starts the installed runner through Apple's
/// test-manager protocol (idevice, MIT) and holds the test session open. ~2 s from cold, against ~5-7 s for
/// `xcodebuild test-without-building`, which re-resolves the project and reinstalls the runner on every start.
pub fn wda_host(udid: &str) -> i32 {
    use idevice::services::dvt::xctest::{TestConfig, XCUITestService};
    use idevice::services::installation_proxy::InstallationProxyClient;
    use idevice::usbmuxd::{UsbmuxdAddr, UsbmuxdConnection};
    use idevice::IdeviceService;
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() { Ok(r) => r, Err(e) => { eprintln!("runtime: {e}"); return 1 } };
    rt.block_on(async {
        let t = Instant::now();
        let run = async {
            let mut mux = UsbmuxdConnection::default().await?;
            let dev = mux.get_device(udid).await?;
            let provider = std::sync::Arc::new(dev.to_provider(UsbmuxdAddr::default(), "mobiusagent-driver"));
            let mut ip = InstallationProxyClient::connect(&*provider).await?;
            let cfg = TestConfig::from_installation_proxy(&mut ip, &runner_bundle(), None).await?;
            let handle = XCUITestService::new(provider.clone()).run_until_wda_ready(cfg, Duration::from_secs(60)).await?;
            eprintln!("mobiusagent-driver: WebDriverAgent ready on {udid} after {:?}", t.elapsed());
            handle.wait().await // hold the test session until the runner ends
        };
        match run.await {
            Ok(()) => 0,
            Err(e) => { eprintln!("mobiusagent-driver: wda host failed after {:?}: {e:?}", t.elapsed()); 1 }
        }
    })
}

/// Make sure WebDriverAgent answers on the phone, starting the runner if needed: first through the direct test-manager
/// host (fast), then through xcodebuild (fallback).
fn ensure_wda(udid: &str) -> R<Value> {
    if let Ok(v) = http(udid, "GET", "/status", None) { return Ok(v); }
    if std::env::var("MOBIUS_WDA_XCODEBUILD").is_err() && !is_sim(udid) {
        if let Ok(v) = start_direct(udid) { return Ok(v); }
    }
    let products = wda_home().join(if is_sim(udid) { "build-sim/Build/Products" } else { "build/Build/Products" });
    let xctestrun = std::fs::read_dir(&products).map_err(|_| "WebDriverAgent is not built: run drivers/mobiusagent-driver/ios-agent/setup.sh".to_string())?
        .flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "xctestrun"))
        .ok_or("WebDriverAgent is not built: run drivers/mobiusagent-driver/ios-agent/setup.sh")?;
    let log = std::fs::File::create(wda_home().join(format!("runner-{udid}.log"))).map_err(|e| e.to_string())?;
    let child = Command::new("xcodebuild")
        // Exact destination (no "multiple matching destinations" probing); skip diagnostics and timeouts we never use.
        .args(["test-without-building", "-xctestrun", xctestrun.to_str().unwrap(), "-destination", &if is_sim(udid) { format!("id={udid}") } else { format!("platform=iOS,arch=arm64,id={udid}") },
            "-test-timeouts-enabled", "NO", "-collect-test-diagnostics", "never", "-disable-concurrent-destination-testing"])
        .stdout(Stdio::from(log.try_clone().unwrap())).stderr(Stdio::from(log)).spawn()
        .map_err(|e| format!("xcodebuild: {e}"))?;
    RUNNERS.lock().unwrap().get_or_insert_with(HashMap::new).insert(udid.to_string(), child);
    let until = Instant::now() + Duration::from_secs(90);
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(150));
        if let Ok(v) = http(udid, "GET", "/status", None) { return Ok(v); }
    }
    Err(format!("WebDriverAgent did not start within 90 s (see {}/runner-{udid}.log; is the phone unlocked and the developer app trusted?)", wda_home().display()))
}

fn start_direct(udid: &str) -> R<Value> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(wda_home()).ok();
    let log = std::fs::File::create(wda_home().join(format!("host-{udid}.log"))).map_err(|e| e.to_string())?;
    let mut child = Command::new(exe).args(["__wda-host", udid])
        .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().unwrap())).stderr(Stdio::from(log))
        .process_group(0) // its own group: outlives this (possibly one-shot CLI) process
        .spawn().map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(45);
    while Instant::now() < until {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(v) = http(udid, "GET", "/status", None) { return Ok(v); }
        if let Ok(Some(_)) = child.try_wait() { return Err("direct WebDriverAgent start failed (see host log)".into()); }
    }
    let _ = child.kill();
    Err("direct WebDriverAgent start timed out".into())
}

fn session(udid: &str) -> R<String> {
    if let Some(s) = SESSIONS.lock().unwrap().get_or_insert_with(HashMap::new).get(udid) { return Ok(s.clone()); }
    // Reuse the session already open on the phone (a new CLI process each command must not pay for a new session;
    // settings like screenshotQuality live in WebDriverAgent and carry over).
    let status = ensure_wda(udid)?;
    if let Some(sid) = status["sessionId"].as_str().filter(|s| !s.is_empty()) {
        SESSIONS.lock().unwrap().get_or_insert_with(HashMap::new).insert(udid.to_string(), sid.to_string());
        return Ok(sid.to_string());
    }
    let r = http(udid, "POST", "/session", Some(&json!({ "capabilities": { "alwaysMatch": { "shouldWaitForQuiescence": false, "waitForQuiescence": false, "shouldUseTestManagerForVisibilityDetection": false } } })))?;
    let sid = r["sessionId"].as_str().or(r["value"]["sessionId"].as_str()).ok_or("WebDriverAgent gave no session")?.to_string();
    // Faster, smaller trees: don't wait for the app to go idle forever, keep depth sane.
    let _ = http(udid, "POST", &format!("/session/{sid}/appium/settings"), Some(&json!({ "settings": { "waitForIdleTimeout": 0, "animationCoolOffTimeout": 0, "reduceMotion": true, "screenshotQuality": 1, "snapshotMaxDepth": 60 } })));
    SESSIONS.lock().unwrap().get_or_insert_with(HashMap::new).insert(udid.to_string(), sid.clone());
    Ok(sid)
}

/// A session-scoped call, re-creating the session once if WebDriverAgent restarted.
fn act(udid: &str, method: &str, tail: &str, body: Value) -> R<Value> {
    let sid = session(udid)?;
    match http(udid, method, &format!("/session/{sid}{tail}"), Some(&body)) {
        Err(e) if e.contains("invalid session") || e.contains("not connected") || e.contains("Session does not exist") => {
            SESSIONS.lock().unwrap().get_or_insert_with(HashMap::new).remove(udid);
            let sid = session(udid)?;
            http(udid, method, &format!("/session/{sid}{tail}"), Some(&body))
        }
        r => r,
    }
}

// ---------- tree mapping ----------

/// XCUIElement.ElementType, in enum order (index = code), as WebDriverAgent names them without the prefix.
const TYPES: &[&str] = &["Any", "Other", "Application", "Group", "Window", "Sheet", "Drawer", "Alert", "Dialog", "Button", "RadioButton",
    "RadioGroup", "CheckBox", "DisclosureTriangle", "PopUpButton", "ComboBox", "MenuButton", "ToolbarButton", "Popover", "Keyboard", "Key",
    "NavigationBar", "TabBar", "TabGroup", "Toolbar", "StatusBar", "Table", "TableRow", "TableColumn", "Outline", "OutlineRow", "Browser",
    "CollectionView", "Slider", "PageIndicator", "ProgressIndicator", "ActivityIndicator", "SegmentedControl", "Picker", "PickerWheel",
    "Switch", "Toggle", "Link", "Image", "Icon", "SearchField", "ScrollView", "ScrollBar", "StaticText", "TextField", "SecureTextField",
    "DatePicker", "TextView", "Menu", "MenuItem", "MenuBar", "MenuBarItem", "Map", "WebView", "IncrementArrow", "DecrementArrow", "Timeline",
    "RatingIndicator", "ValueIndicator", "SplitGroup", "Splitter", "RelevanceIndicator", "ColorWell", "HelpTag", "Matte", "DockItem", "Ruler",
    "RulerMarker", "Grid", "LevelIndicator", "Cell", "LayoutArea", "LayoutItem", "Handle", "Stepper", "Tab", "TouchBar", "StatusItem"];

/// WebDriverAgent JSON source → the XCUITest snapshot shape Mobius's normalizer already reads (elementType + frame).
/// `screen` = (w, h): elements entirely off it are reported with a zero frame (= not visible). Computing visibility here from
/// frames is ~15x cheaper than asking WebDriverAgent for isVisible on every element.
fn map_node(n: &Value, screen: (f64, f64)) -> Value {
    let t = n["type"].as_str().unwrap_or("").trim_start_matches("XCUIElementType");
    let code = TYPES.iter().position(|x| *x == t).unwrap_or(1);
    let r = &n["rect"];
    let (x, y, w, h) = (r["x"].as_f64().unwrap_or(0.0), r["y"].as_f64().unwrap_or(0.0), r["width"].as_f64().unwrap_or(0.0), r["height"].as_f64().unwrap_or(0.0));
    let on_screen = w > 0.0 && h > 0.0 && x + w > 0.0 && y + h > 0.0 && x < screen.0 && y < screen.1;
    let visible = on_screen && !matches!(n.get("isVisible"), Some(Value::String(s)) if s == "0") && n.get("isVisible") != Some(&Value::Bool(false));
    let f = |k: &str| if visible { r[k].as_f64().unwrap_or(0.0) } else { 0.0 };
    let truthy = |k: &str| matches!(n.get(k), Some(Value::String(s)) if s == "1") || n.get(k) == Some(&Value::Bool(true));
    let label = n["label"].as_str().unwrap_or("");
    let name = n["name"].as_str().unwrap_or("");
    json!({
        "elementType": code,
        "label": label,
        "identifier": if name != label { name } else { "" },
        "value": n["value"].as_str().map(Value::from).unwrap_or(Value::Null),
        "placeholderValue": n["placeholderValue"].as_str().unwrap_or(""),
        "frame": { "X": f("x"), "Y": f("y"), "Width": f("width"), "Height": f("height") },
        "enabled": n.get("isEnabled").map(|_| truthy("isEnabled")).unwrap_or(true),
        "selected": truthy("isSelected"),
        "hasFocus": truthy("isFocused") || truthy("hasFocus"),
        "children": n["children"].as_array().map(|c| c.iter().map(|c| map_node(c, screen)).collect::<Vec<_>>()).unwrap_or_default(),
    })
}

fn screen(udid: &str) -> R<(i64, i64)> {
    let r = act(udid, "GET", "/window/size", Value::Null)?;
    Ok((r["value"]["width"].as_f64().unwrap_or(0.0) as i64, r["value"]["height"].as_f64().unwrap_or(0.0) as i64))
}

fn foreground(udid: &str) -> Option<String> {
    http(udid, "GET", "/wda/activeAppInfo", None).ok().and_then(|r| r["value"]["bundleId"].as_str().map(String::from))
}

// ---------- ops ----------

pub fn devices() -> Vec<Value> {
    let tmp = std::env::temp_dir().join(format!("mobius-devicectl-{}.json", std::process::id()));
    let ok = Command::new("xcrun").args(["devicectl", "list", "devices", "--json-output", tmp.to_str().unwrap()])
        .stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    let v: Value = if ok { std::fs::read(&tmp).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null) } else { Value::Null };
    let _ = std::fs::remove_file(&tmp);
    let mut out = vec![];
    // Booted simulators (WebDriverAgent runs on the Mac's localhost for them).
    if let Ok(o) = Command::new("xcrun").args(["simctl", "list", "devices", "booted", "-j"]).output() {
        let j: Value = serde_json::from_slice(&o.stdout).unwrap_or(Value::Null);
        for (runtime, list) in j["devices"].as_object().into_iter().flatten() {
            if !runtime.contains("iOS") { continue; }
            for d in list.as_array().into_iter().flatten() {
                out.push(json!({ "id": d["udid"], "platform": "ios", "type": "simulator", "name": d["name"],
                    "model": d["deviceTypeIdentifier"].as_str().unwrap_or("").rsplit('.').next().unwrap_or(""),
                    "version": runtime.rsplit('.').next().unwrap_or("").replace("iOS-", "").replace('-', "."), "state": "online" }));
            }
        }
    }
    for d in v["result"]["devices"].as_array().into_iter().flatten() {
        let hw = &d["hardwareProperties"];
        if hw["platform"].as_str() != Some("iOS") { continue; }
        let Some(udid) = hw["udid"].as_str() else { continue };
        let usb = mux_device_id(udid).is_ok();
        out.push(json!({
            "id": udid, "platform": "ios", "type": if hw["reality"].as_str() == Some("virtual") { "simulator" } else { "real" },
            "name": d["deviceProperties"]["name"].as_str().unwrap_or("iPhone").trim(), "model": hw["productType"].as_str().unwrap_or(""),
            "version": d["deviceProperties"]["osVersionNumber"].as_str().unwrap_or(""), "state": if usb { "online" } else { "offline" },
        }));
    }
    out
}

pub fn handle(op: &str, udid: &str, req: &Value, max_jpeg: impl Fn(&[u8], u32) -> R<Value>) -> R<Value> {
    let num = |k: &str| req[k].as_f64().ok_or_else(|| format!("missing number `{k}`"));
    if is_sim(udid) { if let Some(r) = sim_op(op, udid, req) { return r; } }
    match op {
        "dump" => {
            // No session needed to read the screen (saves ~1.5 s on a cold start: session creation looks up the active
            // app several times). Actions create one when they need it.
            ensure_wda(udid)?;
            // Foreground app in parallel with the tree; skip WDA's per-element visibility/accessibility checks (the slow part).
            let u = udid.to_string();
            let fg = std::thread::spawn(move || foreground(&u));
            let src = http(udid, "GET", "/source?format=json&excluded_attributes=visible,accessible,index,traits,customActions,nativeFrame,minValue,maxValue,hittable", None)?;
            let root = &src["value"]["rect"];
            let (w, h) = match (root["width"].as_f64(), root["height"].as_f64()) {
                (Some(w), Some(h)) if w > 0.0 && h > 0.0 => (w as i64, h as i64),
                _ => screen(udid)?,
            };
            let tree = map_node(&src["value"], (w as f64, h as f64));
            Ok(json!({ "tree": { "hierarchy": [tree] }, "width": w, "height": h, "rotation": if w > h { 1 } else { 0 }, "foregroundApp": fg.join().ok().flatten(), "via": "wda" }))
        }
        "foreground" => Ok(json!({ "app": foreground(udid) })),
        // Debugging/tuning: GET any WebDriverAgent path ("{sid}" is replaced by the session id).
        "wda_post" => { let sid = session(udid)?; http(udid, "POST", &req["path"].as_str().unwrap_or("/status").replace("{sid}", &sid), Some(&req["body"])) }
        "wda_get" => { let sid = session(udid)?; http(udid, "GET", &req["path"].as_str().unwrap_or("/status").replace("{sid}", &sid), None) }
        "size" => { let (w, h) = screen(udid)?; Ok(json!({ "width": w, "height": h })) }
        "tap" => {
            let (x, y) = (num("x")?, num("y")?);
            match req["mode"].as_str().unwrap_or("single") {
                "long" => act(udid, "POST", "/wda/touchAndHold", json!({ "x": x, "y": y, "duration": 0.8 })),
                "double" => act(udid, "POST", "/wda/doubleTap", json!({ "x": x, "y": y })),
                _ => fast(udid, "/mobius/tap", json!({ "x": x, "y": y }), || touch(udid, &[json!({ "type": "pointerMove", "duration": 0, "x": x, "y": y }),
                    json!({ "type": "pointerDown", "button": 0 }), json!({ "type": "pause", "duration": 40 }), json!({ "type": "pointerUp", "button": 0 })])),
            }.map(|_| json!({}))
        }
        "swipe" => {
            let secs = req["ms"].as_f64().unwrap_or(300.0) / 1000.0;
            let (x1, y1, x2, y2) = (num("x1")?, num("y1")?, num("x2")?, num("y2")?);
            fast(udid, "/mobius/swipe", json!({ "x1": x1, "y1": y1, "x2": x2, "y2": y2, "duration": secs.max(0.05) }), || touch(udid, &[
                json!({ "type": "pointerMove", "duration": 0, "x": x1, "y": y1 }), json!({ "type": "pointerDown", "button": 0 }),
                json!({ "type": "pointerMove", "duration": (secs.max(0.05) * 1000.0) as i64, "x": x2, "y": y2 }), json!({ "type": "pointerUp", "button": 0 })])).map(|_| json!({}))
        }
        "text" => {
            let mut t = req["text"].as_str().ok_or("missing string `text`")?.to_string();
            if req["submit"].as_bool().unwrap_or(false) { t.push('\n'); }
            act(udid, "POST", "/wda/keys", json!({ "value": [t] })).map(|_| json!({}))
        }
        "key" => match req["key"].as_str().unwrap_or("") {
            "home" => act(udid, "POST", "/wda/pressButton", json!({ "name": "home" })).map(|_| json!({})),
            "enter" => act(udid, "POST", "/wda/keys", json!({ "value": ["\n"] })).map(|_| json!({})),
            k => Err(format!("key `{k}` does not exist on iOS")),
        },
        "launch" => act(udid, "POST", "/wda/apps/launch", json!({ "bundleId": req["app"].as_str().ok_or("missing `app`")? })).map(|_| json!({})),
        "url" => act(udid, "POST", "/url", json!({ "url": req["url"].as_str().ok_or("missing `url`")? })).map(|_| json!({})),
        "apps" => {
            let tmp = std::env::temp_dir().join(format!("mobius-apps-{}.json", std::process::id()));
            let ok = Command::new("xcrun").args(["devicectl", "device", "info", "apps", "--device", udid, "--include-all-apps", "--json-output", tmp.to_str().unwrap()])
                .stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
            let v: Value = if ok { std::fs::read(&tmp).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null) } else { Value::Null };
            let _ = std::fs::remove_file(&tmp);
            let mut apps: Vec<String> = v["result"]["apps"].as_array().into_iter().flatten().filter_map(|a| a["bundleIdentifier"].as_str().map(String::from)).collect();
            apps.sort(); apps.dedup();
            if apps.is_empty() { return Err("could not list apps (devicectl)".into()); }
            Ok(json!({ "apps": apps }))
        }
        "screenshot" => {
            session(udid)?; // applies screenshotQuality (JPEG): WebDriverAgent's default is slow uncompressed PNG
            let r = http(udid, "GET", "/screenshot", None)?;
            let png = base64::engine::general_purpose::STANDARD.decode(r["value"].as_str().unwrap_or("").replace(['\n', '\r'], "")).map_err(|e| e.to_string())?;
            max_jpeg(&png, req["max"].as_u64().unwrap_or(0) as u32)
        }
        "terminate" => act(udid, "POST", "/wda/apps/terminate", json!({ "bundleId": req["app"].as_str().ok_or("missing `app`")? })).map(|_| json!({})),
        "install" => devicectl(&["device", "install", "app", "--device", udid, req["path"].as_str().ok_or("missing `path`")?]),
        "uninstall" => devicectl(&["device", "uninstall", "app", "--device", udid, req["app"].as_str().ok_or("missing `app`")?]),
        "clear_data" => Err("iOS has no way to clear one app's data; uninstall and reinstall it".into()),
        "fill" => {
            // Replace the focused field's text: clear the active element, then type.
            let sid = session(udid)?;
            let el = http(udid, "GET", &format!("/session/{sid}/element/active"), None)?;
            let id = el["value"]["ELEMENT"].as_str().or(el["value"]["element-6066-11e4-a52e-4f735466cecf"].as_str()).ok_or("no focused text field")?.to_string();
            act(udid, "POST", &format!("/element/{id}/clear"), json!({}))?;
            act(udid, "POST", "/wda/keys", json!({ "value": [req["text"].as_str().unwrap_or("")] })).map(|_| json!({}))
        }
        "orientation" => match req["set"].as_str() {
            None => { let r = act(udid, "GET", "/orientation", Value::Null)?; Ok(json!({ "orientation": r["value"].as_str().unwrap_or("PORTRAIT").to_lowercase() })) }
            Some(o) => act(udid, "POST", "/orientation", json!({ "orientation": o.to_uppercase() })).map(|_| json!({})),
        },
        "info" => {
            let d = http(udid, "GET", "/wda/device/info", None).map(|r| r["value"].clone()).unwrap_or(Value::Null);
            let b = act(udid, "GET", "/wda/batteryInfo", Value::Null).map(|r| r["value"].clone()).unwrap_or(Value::Null);
            let (w, h) = screen(udid)?;
            Ok(json!({ "id": udid, "platform": "ios", "model": d["model"], "name": d["name"], "version": d["osVersion"] .clone(), "width": w, "height": h,
                "battery": b["level"].as_f64().map(|l| (l * 100.0).round() as i64), "locale": d["locale"] }))
        }
        "reboot" => devicectl(&["device", "reboot", "--device", udid]),
        "hide_keyboard" => act(udid, "POST", "/wda/keyboard/dismiss", json!({})).map(|_| json!({ "was_shown": true })).or_else(|_| Ok(json!({ "was_shown": false }))),
        "logs" => {
            // Live system log for a short window (iOS keeps no readable backlog): up to `lines`, stopping after `seconds`.
            let n = req["lines"].as_u64().unwrap_or(200).min(5000) as usize;
            let secs = req["seconds"].as_f64().unwrap_or(3.0).min(30.0);
            let app = req["app"].as_str().map(String::from);
            block_on(async move {
                use idevice::IdeviceService;
                let p = provider(udid).await?;
                let mut log = idevice::syslog_relay::SyslogRelayClient::connect(&*p).await.map_err(|e| e.to_string())?;
                let end = tokio::time::Instant::now() + Duration::from_secs_f64(secs);
                let mut lines = vec![];
                while lines.len() < n {
                    match tokio::time::timeout_at(end, log.next()).await {
                        Ok(Ok(l)) => { if app.as_deref().is_none_or(|a| l.contains(a)) { lines.push(l.trim_end().to_string()); } }
                        _ => break,
                    }
                }
                Ok(json!({ "lines": lines }))
            })
        }
        "fs_ls" | "fs_pull" | "fs_push" => {
            // An app's container (`app`: its Documents, Library, tmp) through house_arrest, or the media area through AFC.
            let app = req["app"].as_str().map(String::from);
            let path = req["path"].as_str().unwrap_or(if app.is_some() { "/Documents" } else { "/" }).to_string();
            let (file, output) = (req["file"].as_str().map(String::from), req["output"].as_str().map(String::from));
            let op = op.to_string();
            block_on(async move {
                use idevice::IdeviceService;
                let p = provider(udid).await?;
                let mut afc = match &app {
                    Some(a) => idevice::services::house_arrest::HouseArrestClient::connect(&*p).await.map_err(|e| e.to_string())?
                        .vend_container(a.clone()).await.map_err(|e| format!("{a}: {e} (the app must allow file access or be a development build)"))?,
                    None => idevice::services::afc::AfcClient::connect(&*p).await.map_err(|e| e.to_string())?,
                };
                match op.as_str() {
                    "fs_ls" => {
                        let mut entries = vec![];
                        for name in afc.list_dir(path.clone()).await.map_err(|e| e.to_string())? {
                            if name == "." || name == ".." { continue; }
                            let full = format!("{}/{}", path.trim_end_matches('/'), name);
                            let info = afc.get_file_info(full).await.ok();
                            entries.push(json!({ "name": name, "dir": info.as_ref().is_some_and(|i| i.st_ifmt == "S_IFDIR"), "size": info.map(|i| i.size).unwrap_or(0) }));
                        }
                        Ok(json!({ "path": path, "entries": entries }))
                    }
                    "fs_pull" => {
                        let out = output.ok_or("missing `output`")?;
                        let mut f = afc.open(path.clone(), idevice::services::afc::opcode::AfcFopenMode::RdOnly).await.map_err(|e| e.to_string())?;
                        let bytes = f.read_entire().await.map_err(|e| e.to_string())?;
                        std::fs::write(&out, &bytes).map_err(|e| e.to_string())?;
                        Ok(json!({ "saved": out, "bytes": bytes.len() }))
                    }
                    _ => {
                        let src = file.ok_or("missing `file`")?;
                        let bytes = std::fs::read(&src).map_err(|e| e.to_string())?;
                        let mut f = afc.open(path.clone(), idevice::services::afc::opcode::AfcFopenMode::WrOnly).await.map_err(|e| e.to_string())?;
                        f.write_entire(&bytes).await.map_err(|e| e.to_string())?;
                        Ok(json!({ "pushed": path, "bytes": bytes.len() }))
                    }
                }
            })
        }
        "app_path" => {
            let app = req["app"].as_str().ok_or("missing `app`")?.to_string();
            block_on(async move {
                use idevice::IdeviceService;
                let p = provider(udid).await?;
                let mut ip = idevice::services::installation_proxy::InstallationProxyClient::connect(&*p).await.map_err(|e| e.to_string())?;
                let apps = ip.get_apps(None, Some(vec![app.clone()])).await.map_err(|e| e.to_string())?;
                let info = apps.get(&app).and_then(|v| v.as_dictionary()).ok_or(format!("{app} is not installed"))?;
                let get = |k: &str| info.get(k).and_then(|v| v.as_string()).unwrap_or("").to_string();
                Ok(json!({ "app": app, "bundle_path": get("Path"), "data_dir": get("Container"), "version": get("CFBundleShortVersionString") }))
            })
        }
        "settings" => Err("iOS has no settings command interface; open the Settings app and drive it instead".into()),
        "keys" => {
            let combo = req["keys"].as_str().ok_or("missing `keys`")?.to_ascii_lowercase();
            match combo.as_str() {
                "volume_up" | "volumeup" => act(udid, "POST", "/wda/pressButton", json!({ "name": "volumeUp" })),
                "volume_down" | "volumedown" => act(udid, "POST", "/wda/pressButton", json!({ "name": "volumeDown" })),
                "home" => act(udid, "POST", "/wda/pressButton", json!({ "name": "home" })),
                "lock" | "power" => act(udid, "POST", "/wda/lock", json!({})),
                "enter" | "return" => act(udid, "POST", "/wda/keys", json!({ "value": ["\n"] })),
                "tab" => act(udid, "POST", "/wda/keys", json!({ "value": ["\t"] })),
                "del" | "backspace" | "delete" => act(udid, "POST", "/wda/keys", json!({ "value": ["\u{8}"] })),
                k => Err(format!("key `{k}` is not available on iOS (volume_up, volume_down, home, lock, enter, tab, delete)")),
            }.map(|_| json!({}))
        }
        "pinch" => {
            // Two fingers, W3C actions: apart for scale > 1 (zoom in), together for < 1.
            let (x, y) = (num("x")?, num("y")?);
            let scale = req["scale"].as_f64().unwrap_or(2.0).clamp(0.1, 10.0);
            let ms = req["ms"].as_i64().unwrap_or(400);
            let base = 60.0;
            let (d0, d1) = if scale >= 1.0 { (base, (base * scale).min(170.0)) } else { ((base / scale).min(170.0), base) };
            let finger = |id: &str, sign: f64| json!({ "type": "pointer", "id": id, "parameters": { "pointerType": "touch" }, "actions": [
                { "type": "pointerMove", "duration": 0, "x": x + sign * d0, "y": y }, { "type": "pointerDown", "button": 0 },
                { "type": "pointerMove", "duration": ms, "x": x + sign * d1, "y": y }, { "type": "pointerUp", "button": 0 }] });
            act(udid, "POST", "/actions", json!({ "actions": [finger("f1", -1.0), finger("f2", 1.0)] })).map(|_| json!({}))
        }
        "shutdown" => simctl(&["shutdown", udid]),
        "notifications" => Err("iOS does not let tools read other apps' notifications".into()),
        "flow_record_start" | "flow_record_stop" => Err("recording a human's touches is Android-only (iOS exposes no input event stream)".into()),
        "webviews" | "webview_eval" | "webview_dom" => Err("WebView inspection is Android-only today (iOS needs Safari's Web Inspector)".into()),
        "biometric" => {
            // Simulators only: Face ID / Touch ID match or fail.
            let ok = req["match"].as_bool().unwrap_or(true);
            let o = Command::new("xcrun").args(["simctl", "spawn", udid, "notifyutil", "-p", if ok { "com.apple.BiometricKit_Sim.pearl.match" } else { "com.apple.BiometricKit_Sim.pearl.nomatch" }]).output();
            match o { Ok(o) if o.status.success() => Ok(json!({ "matched": ok })), _ => Err("biometric simulation works on iOS simulators (real iPhones need a real face)".into()) }
        }
        "dark_mode" => match req["on"].as_bool() {
            Some(on) => act(udid, "POST", "/wda/device/appearance", json!({ "name": if on { "dark" } else { "light" } })).map(|_| json!({})),
            None => { let r = http(udid, "GET", "/wda/device/info", None)?; Ok(json!({ "on": r["value"]["userInterfaceStyle"] == "dark" })) }
        },
        "perf" | "font_scale" | "app_locale" | "battery" | "network" | "permission" =>
            Err(format!("`{op}` is Android-only today (iOS gives no unprivileged control over it)")),
        "crashes" => block_on(async move {
            use idevice::IdeviceService;
            let p = provider(udid).await?;
            let mut c = idevice::services::crashreportcopymobile::CrashReportCopyMobileClient::connect(&*p).await.map_err(|e| e.to_string())?;
            let mut files: Vec<String> = c.ls(None).await.map_err(|e| e.to_string())?.into_iter().filter(|f| f.ends_with(".ips") || f.ends_with(".crash")).collect();
            files.sort_by(|a, b| b.cmp(a));
            let crashes: Vec<Value> = files.iter().map(|f| {
                // e.g. "Swiggy-2026-11-12-104512.ips" → process + time
                let stem = f.trim_end_matches(".ips").trim_end_matches(".crash");
                let (process, time) = stem.split_once("-20").map(|(p, t)| (p.to_string(), format!("20{t}"))).unwrap_or((stem.to_string(), String::new()));
                json!({ "id": f, "process": process, "time": time })
            }).collect();
            Ok(json!({ "crashes": crashes }))
        }),
        "crash" => {
            let id = req["id"].as_str().ok_or("missing `id`")?.to_string();
            if id.contains("..") || id.contains('/') { return Err("invalid crash id".into()); }
            block_on(async move {
                use idevice::IdeviceService;
                let p = provider(udid).await?;
                let mut c = idevice::services::crashreportcopymobile::CrashReportCopyMobileClient::connect(&*p).await.map_err(|e| e.to_string())?;
                let bytes = c.pull(id.clone()).await.map_err(|e| e.to_string())?;
                Ok(json!({ "id": id, "text": String::from_utf8_lossy(&bytes) }))
            })
        }
        "record_start" => {
            // WebDriverAgent's MJPEG stream (port 9100) → ffmpeg → MP4, in a small background recorder process.
            ensure_wda(udid)?;
            let output = req["output"].as_str().map(String::from).unwrap_or_else(|| format!("mobius-recording-{}.mp4", now_ms()));
            let stop = wda_home().join(format!("record-{udid}.stop"));
            let _ = std::fs::remove_file(&stop);
            use std::os::unix::process::CommandExt;
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let log = std::fs::File::create(wda_home().join(format!("record-{udid}.log"))).map_err(|e| e.to_string())?;
            let child = Command::new(exe).args(["__record", udid, &output, &req["time_limit"].as_u64().unwrap_or(180).min(1800).to_string()])
                .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().unwrap())).stderr(Stdio::from(log)).process_group(0).spawn().map_err(|e| e.to_string())?;
            std::fs::write(wda_home().join(format!("record-{udid}.json")), json!({ "pid": child.id(), "output": output, "started": now_ms() }).to_string()).map_err(|e| e.to_string())?;
            Ok(json!({ "recording": true, "output": output }))
        }
        "record_stop" => {
            let meta: Value = std::fs::read(wda_home().join(format!("record-{udid}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or("no recording in progress")?;
            std::fs::write(wda_home().join(format!("record-{udid}.stop")), b"").map_err(|e| e.to_string())?;
            let pid = meta["pid"].as_u64().unwrap_or(0);
            for _ in 0..100 { // the recorder finalizes the MP4, then exits
                if Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().map(|s| !s.success()).unwrap_or(true) { break; }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = std::fs::remove_file(wda_home().join(format!("record-{udid}.json")));
            let out = meta["output"].as_str().unwrap_or("").to_string();
            let output = req["output"].as_str().map(String::from).unwrap_or(out.clone());
            if output != out { std::fs::rename(&out, &output).map_err(|e| e.to_string())?; }
            Ok(json!({ "saved": output, "bytes": std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0), "seconds": (now_ms().saturating_sub(meta["started"].as_u64().unwrap_or(0))) / 1000 }))
        }
        "location" => act(udid, "POST", "/wda/simulatedLocation", json!({ "latitude": req["lat"].as_f64().ok_or("missing `lat`")?, "longitude": req["lon"].as_f64().ok_or("missing `lon`")? })).map(|_| json!({})),
        "clipboard" => match req["set"].as_str() {
            Some(t) => act(udid, "POST", "/wda/setPasteboard", json!({ "content": base64::engine::general_purpose::STANDARD.encode(t), "contentType": "plaintext" })).map(|_| json!({})),
            None => {
                let r = act(udid, "POST", "/wda/getPasteboard", json!({ "contentType": "plaintext" }))?;
                let raw = base64::engine::general_purpose::STANDARD.decode(r["value"].as_str().unwrap_or("")).unwrap_or_default();
                Ok(json!({ "text": String::from_utf8_lossy(&raw) }))
            }
        },
        _ => Err(format!("unknown op `{op}`")),
    }
}

/// Mobius's fast-touch endpoints (ios-agent/wda-mobius-fast-touch.patch): one raw event, no app lookup, no settle wait.
/// Unpatched WebDriverAgent builds fall back to W3C actions.
fn fast(udid: &str, path: &str, body: Value, fallback: impl FnOnce() -> R<Value>) -> R<Value> {
    match http(udid, "POST", path, Some(&body)) {
        Err(e) if e.contains("Unhandled endpoint") || e.contains("unknown command") => fallback(),
        r => r,
    }
}

/// One finger, W3C actions: WebDriverAgent synthesizes the events directly (much faster than /wda/tap, which re-resolves
/// the coordinate through the accessibility tree and waits).
fn touch(udid: &str, steps: &[Value]) -> R<Value> {
    act(udid, "POST", "/actions", json!({ "actions": [{ "type": "pointer", "id": "finger1", "parameters": { "pointerType": "touch" }, "actions": steps }] }))
}

fn now_ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }

fn block_on<T>(f: impl std::future::Future<Output = R<T>>) -> R<T> {
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())?.block_on(f)
}

async fn provider(udid: &str) -> R<std::sync::Arc<idevice::provider::UsbmuxdProvider>> {
    use idevice::usbmuxd::{UsbmuxdAddr, UsbmuxdConnection};
    let mut mux = UsbmuxdConnection::default().await.map_err(|e| e.to_string())?;
    let dev = mux.get_device(udid).await.map_err(|e| format!("{udid}: {e}"))?;
    Ok(std::sync::Arc::new(dev.to_provider(UsbmuxdAddr::default(), "mobiusagent-driver")))
}

/// `mobiusagent-driver __record <udid> <output.mp4> <limit_s>`: MJPEG from WebDriverAgent (9100) piped into ffmpeg until the
/// stop file appears or the time limit passes, then the MP4 is finalized.
pub fn record(udid: &str, output: &str, limit_s: u64) -> i32 {
    let stop = wda_home().join(format!("record-{udid}.stop"));
    let mut s = match connect(udid, 9100) { Ok(s) => s, Err(e) => { eprintln!("{e}"); return 1 } };
    let _ = s.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    let mut ff = match Command::new("ffmpeg").args(["-loglevel", "error", "-y", "-use_wallclock_as_timestamps", "1", "-f", "mpjpeg", "-i", "-",
        "-fps_mode", "cfr", "-r", "15", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", output]).stdin(Stdio::piped()).spawn() {
        Ok(c) => c, Err(e) => { eprintln!("ffmpeg is needed for iOS recording: {e}"); return 1 }
    };
    let mut stdin = ff.stdin.take().unwrap();
    let end = Instant::now() + Duration::from_secs(limit_s);
    let mut buf = vec![0u8; 64 * 1024];
    let mut header_done = false;
    let mut pending = vec![];
    while Instant::now() < end && !stop.exists() {
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if header_done { if stdin.write_all(&buf[..n]).is_err() { break; } continue; }
                pending.extend_from_slice(&buf[..n]);
                if let Some(i) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
                    header_done = true;
                    if stdin.write_all(&pending[i + 4..]).is_err() { break; }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => break,
        }
    }
    drop(stdin);
    let _ = std::fs::remove_file(&stop);
    if ff.wait().map(|s| s.success()).unwrap_or(false) { 0 } else { 1 }
}

/// iOS performance session: launch times through WebDriverAgent; CPU, memory footprint, threads and FPS through Apple's
/// instruments services (sysmontap, graphics) over the iOS 17+ tunnel; crashes from the crash-report service.
pub fn perf_session(udid: &str, req: &Value, secs: u64) -> R<(Value, Vec<crate::report::Sample>)> {
    use crate::report::{r1, summarize, Sample};
    let app = req["app"].as_str().ok_or("missing `app` (bundle id)")?.to_string();
    let crash_ids = || -> std::collections::HashSet<String> {
        handle("crashes", udid, &json!({}), |_, _| Ok(Value::Null)).ok().and_then(|v| v["crashes"].as_array().cloned()).unwrap_or_default()
            .into_iter().filter_map(|c| c["id"].as_str().map(String::from)).collect()
    };
    let before = crash_ids();
    // Launch: cold (terminated) then warm (backgrounded), each until the app is frontmost.
    let launch = || -> Option<u64> {
        let t = Instant::now();
        act(udid, "POST", "/wda/apps/launch", json!({ "bundleId": app })).ok()?;
        while t.elapsed() < Duration::from_secs(20) {
            if foreground(udid).as_deref() == Some(app.as_str()) { return Some(t.elapsed().as_millis() as u64); }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    };
    let _ = act(udid, "POST", "/wda/apps/terminate", json!({ "bundleId": app }));
    std::thread::sleep(Duration::from_millis(800));
    let cold = launch();
    std::thread::sleep(Duration::from_millis(1500));
    let _ = act(udid, "POST", "/wda/pressButton", json!({ "name": "home" }));
    std::thread::sleep(Duration::from_millis(800));
    let warm = launch();
    let app2 = app.clone();
    let (samples, fps, exec) = block_on(async move {
        use idevice::services::dvt::{device_info::DeviceInfoClient, graphics::GraphicsClient, remote_server::RemoteServerClient,
            };
        use idevice::{provider::RsdProvider, IdeviceService, RsdService};
        let p = provider(udid).await?;
        let exec = {
            let mut ip = idevice::services::installation_proxy::InstallationProxyClient::connect(&*p).await.map_err(|e| e.to_string())?;
            let apps = ip.get_apps(None, Some(vec![app2.clone()])).await.map_err(|e| e.to_string())?;
            apps.get(&app2).and_then(|v| v.as_dictionary()).and_then(|d| d.get("CFBundleExecutable")).and_then(|v| v.as_string()).unwrap_or("").to_string()
        };
        let proxy = idevice::core_device_proxy::CoreDeviceProxy::connect(&*p).await.map_err(|e| format!("tunnel: {e}"))?;
        let rsd_port = proxy.tunnel_info().server_rsd_port;
        let mut handle = proxy.create_software_tunnel().map_err(|e| e.to_string())?.to_async_handle();
        let mut hs = idevice::rsd::RsdHandshake::new(handle.connect_to_service_port(rsd_port).await.map_err(|e| e.to_string())?).await.map_err(|e| e.to_string())?;
        let mut rs = RemoteServerClient::connect_rsd(&mut handle, &mut hs).await.map_err(|e| format!("instruments: {e}"))?;
        // Ask the device which process attributes it supports, then request only the ones we use (unknown names make the
        // instruments service drop the connection).
        let (pid, supported, sys_attrs): (Option<u32>, Vec<String>, Vec<String>) = {
            let mut di = DeviceInfoClient::new(&mut rs).await.map_err(|e| e.to_string())?;
            let pid = di.running_processes().await.map_err(|e| e.to_string())?.into_iter().find(|p| p.name == exec).map(|p| p.pid);
            let pa = di.sysmon_process_attributes().await.map_err(|e| e.to_string())?;
            let sa = di.sysmon_system_attributes().await.map_err(|e| e.to_string())?;
            (pid, pa, sa)
        };
        let want = ["pid", "cpuUsage", "physFootprint", "memResidentSize", "threadCount"];
        let attrs: Vec<String> = want.iter().filter(|w| supported.iter().any(|s| s == *w)).map(|w| w.to_string()).collect();
        let col = |name: &str| attrs.iter().position(|a| a == name);
        let (c_cpu, c_mem, c_rss, c_thr) = (col("cpuUsage"), col("physFootprint"), col("memResidentSize"), col("threadCount"));
        let dbg = std::env::var("MOBIUS_DEBUG").is_ok();
        if dbg { eprintln!("perf: exec={exec} pid={pid:?}"); }
        // Our own reader on the sysmontap channel (same config as the crate's client): a message carries several rows
        // (system stats, process table); keep all of them.
        let mut ch = rs.make_channel("com.apple.instruments.server.services.sysmontap").await.map_err(|e| e.to_string())?;
        let mut cfg = plist::Dictionary::new();
        cfg.insert("ur".into(), plist::Value::Integer(1000i64.into()));
        cfg.insert("bm".into(), plist::Value::Integer(0i64.into()));
        cfg.insert("procAttrs".into(), plist::Value::Array(attrs.iter().map(|a| plist::Value::String(a.clone())).collect()));
        cfg.insert("sysAttrs".into(), plist::Value::Array(sys_attrs.iter().map(|a| plist::Value::String(a.clone())).collect()));
        cfg.insert("cpuUsage".into(), plist::Value::Boolean(true));
        cfg.insert("physFootprint".into(), plist::Value::Boolean(true));
        cfg.insert("sampleInterval".into(), plist::Value::Integer(1_000_000_000i64.into()));
        use idevice::services::dvt::message::AuxValue;
        ch.call_method(Some(plist::Value::String("setConfig:".into())), Some(vec![AuxValue::archived_value(plist::Value::Dictionary(cfg))]), false).await.map_err(|e| e.to_string())?;
        ch.call_method(Some(plist::Value::String("start".into())), None, false).await.map_err(|e| e.to_string())?;
        if dbg { eprintln!("perf: attrs={attrs:?}"); }
        let mut gfx_rs = RemoteServerClient::connect_rsd(&mut handle, &mut hs).await.map_err(|e| format!("instruments: {e}"))?;
        let mut gfx = GraphicsClient::new(&mut gfx_rs).await.map_err(|e| e.to_string())?;
        let _ = gfx.start_sampling(1.0).await;
        let t0 = Instant::now();
        let mut samples = vec![];
        let mut fps = vec![];
        while t0.elapsed().as_secs() < secs {
            let msg = match tokio::time::timeout(Duration::from_secs(3), ch.read_message()).await {
                Ok(Ok(m)) => m,
                other => { if dbg { eprintln!("perf: read error {:?}", other.map(|r| r.err())); } continue }
            };
            let rows = match msg.data { Some(plist::Value::Array(a)) => a, Some(v @ plist::Value::Dictionary(_)) => vec![v], _ => vec![] };
            for row in rows {
                let Some(procs) = row.as_dictionary().and_then(|d| d.get("Processes")).and_then(|v| v.as_dictionary()) else { continue };
                if dbg { eprintln!("perf: process rows {}", procs.len()); }
                if let Some(r) = pid.and_then(|pid| procs.get(&pid.to_string())).and_then(|v| v.as_array()) {
                    let f = |i: usize| r.get(i).and_then(|v| v.as_real().or(v.as_signed_integer().map(|n| n as f64)).or(v.as_unsigned_integer().map(|n| n as f64)));
                    let mem = c_mem.and_then(f).or(c_rss.and_then(f));
                    samples.push(Sample { t_ms: t0.elapsed().as_millis() as u64, cpu: c_cpu.and_then(f).map(r1), mem_mb: mem.map(|b| r1(b / 1_048_576.0)), threads: c_thr.and_then(f).map(|n| n as u64) });
                }
            }
            if let Ok(Ok(g)) = tokio::time::timeout(Duration::from_millis(200), gfx.sample()).await { if g.fps > 0.0 { fps.push(g.fps); } }
        }
        let _ = ch.call_method(Some(plist::Value::String("stop".into())), None, false).await;
        Ok::<_, String>((samples, fps, exec))
    })?;
    let new_crashes: Vec<String> = crash_ids().difference(&before).filter(|c| c.starts_with(&exec)).cloned().collect();
    let info = http(udid, "GET", "/wda/device/info", None).map(|r| r["value"].clone()).unwrap_or(Value::Null);
    let avg = |v: &[f64]| if v.is_empty() { Value::Null } else { json!(r1(v.iter().sum::<f64>() / v.len() as f64)) };
    let rep = json!({
        "app": app, "platform": "iOS", "seconds": secs,
        "device": { "model": info["model"], "ios": info["osVersion"] },
        "launch": { "cold_ms": cold, "warm_ms": warm },
        "summary": summarize(&samples),
        "frames": { "fps_avg": avg(&fps), "fps_min": fps.iter().cloned().reduce(f64::min).map(r1) },
        "crashes": new_crashes,
    });
    Ok((rep, samples))
}

fn simctl_out(args: &[&str]) -> R<String> {
    let o = Command::new("xcrun").arg("simctl").args(args).output().map_err(|e| format!("simctl: {e}"))?;
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).into_owned()) } else { Err(format!("simctl: {}", String::from_utf8_lossy(&o.stderr).trim())) }
}

fn bundle_ok(b: &str) -> R<&str> { if b.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') { Ok(b) } else { Err("invalid bundle id".into()) } }

/// Simulator-specific implementations (simctl / the Mac's file system). None = use the WebDriverAgent path.
fn sim_op(op: &str, sim: &str, req: &Value) -> Option<R<Value>> {
    let s = |k: &str| req[k].as_str().ok_or_else(|| format!("missing `{k}`"));
    Some(match op {
        "apps" => (|| {
            let o = Command::new("sh").arg("-c").arg(format!("xcrun simctl listapps {sim} | plutil -convert json -o - -")).output().map_err(|e| e.to_string())?;
            let j: Value = serde_json::from_slice(&o.stdout).map_err(|e| format!("listapps: {e}"))?;
            let mut apps: Vec<String> = j.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
            apps.sort();
            Ok(json!({ "apps": apps }))
        })(),
        "install" => s("path").and_then(|p| simctl(&["install", sim, p])),
        "uninstall" => s("app").and_then(bundle_ok).and_then(|a| simctl(&["uninstall", sim, a])),
        "clear_data" => (|| {
            let a = bundle_ok(s("app")?)?;
            let _ = simctl(&["terminate", sim, a]);
            let dir = simctl_out(&["get_app_container", sim, a, "data"])?.trim().to_string();
            for sub in ["Documents", "Library", "tmp"] {
                let p = std::path::Path::new(&dir).join(sub);
                if p.exists() { std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?; std::fs::create_dir_all(&p).ok(); }
            }
            Ok(json!({ "cleared": dir }))
        })(),
        "app_path" => (|| {
            let a = bundle_ok(s("app")?)?;
            Ok(json!({ "app": a, "bundle_path": simctl_out(&["get_app_container", sim, a, "app"])?.trim(), "data_dir": simctl_out(&["get_app_container", sim, a, "data"])?.trim() }))
        })(),
        "clipboard" => match req["set"].as_str() {
            Some(t) => (|| {
                let mut c = Command::new("xcrun").args(["simctl", "pbcopy", sim]).stdin(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
                c.stdin.take().unwrap().write_all(t.as_bytes()).map_err(|e| e.to_string())?;
                c.wait().map_err(|e| e.to_string())?;
                Ok(json!({}))
            })(),
            None => simctl_out(&["pbpaste", sim]).map(|t| json!({ "text": t })),
        },
        "location" => (|| { let (lat, lon) = (num_of(req, "lat")?, num_of(req, "lon")?); simctl(&["location", sim, "set", &format!("{lat},{lon}")]) })(),
        "dark_mode" => match req["on"].as_bool() {
            Some(on) => simctl(&["ui", sim, "appearance", if on { "dark" } else { "light" }]),
            None => simctl_out(&["ui", sim, "appearance"]).map(|o| json!({ "on": o.trim() == "dark" })),
        },
        "permission" => (|| {
            let a = bundle_ok(s("app")?)?;
            let svc = s("permission")?.to_ascii_lowercase();
            if !svc.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("invalid permission".into()); }
            simctl(&["privacy", sim, if req["grant"].as_bool().unwrap_or(true) { "grant" } else { "revoke" }, &svc, a])
        })(),
        "push_notification" => (|| {
            let a = bundle_ok(s("app")?)?;
            let payload = json!({ "aps": { "alert": { "title": req["title"].as_str().unwrap_or("Mobius"), "body": req["body"].as_str().unwrap_or("") }, "sound": "default" } });
            let f = std::env::temp_dir().join(format!("mobius-push-{}.json", now_ms()));
            std::fs::write(&f, payload.to_string()).map_err(|e| e.to_string())?;
            let r = simctl(&["push", sim, a, f.to_str().unwrap()]);
            let _ = std::fs::remove_file(&f);
            r.map(|_| json!({ "sent": true }))
        })(),
        "logs" => (|| {
            let secs = req["seconds"].as_f64().unwrap_or(3.0).clamp(1.0, 300.0);
            let mut args = vec!["spawn".to_string(), sim.into(), "log".into(), "show".into(), "--last".into(), format!("{}s", secs as u64), "--style".into(), "compact".into()];
            if let Some(a) = req["app"].as_str() { bundle_ok(a)?; args.extend(["--predicate".into(), format!("subsystem CONTAINS '{a}' OR process CONTAINS '{}'", a.rsplit('.').next().unwrap_or(a))]); }
            let o = Command::new("xcrun").arg("simctl").args(&args).output().map_err(|e| e.to_string())?;
            let n = req["lines"].as_u64().unwrap_or(200) as usize;
            let all: Vec<String> = String::from_utf8_lossy(&o.stdout).lines().map(String::from).collect();
            Ok(json!({ "lines": all[all.len().saturating_sub(n)..] }))
        })(),
        "crashes" => (|| {
            let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Logs/DiagnosticReports");
            let mut files: Vec<_> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|f| f.ends_with(".ips")).collect();
            files.sort_by(|a, b| b.cmp(a));
            Ok(json!({ "crashes": files.iter().take(50).map(|f| { let stem = f.trim_end_matches(".ips");
                let (p, t) = stem.split_once("-20").map(|(p, t)| (p.to_string(), format!("20{t}"))).unwrap_or((stem.into(), String::new()));
                json!({ "id": f, "process": p, "time": t }) }).collect::<Vec<_>>() }))
        })(),
        "crash" => (|| {
            let id = s("id")?;
            if id.contains('/') || id.contains("..") { return Err("invalid crash id".into()); }
            let p = std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Library/Logs/DiagnosticReports").join(id);
            Ok(json!({ "id": id, "text": std::fs::read_to_string(p).map_err(|e| e.to_string())? }))
        })(),
        "record_start" => (|| {
            let output = req["output"].as_str().map(String::from).unwrap_or_else(|| format!("mobius-recording-{}.mp4", now_ms()));
            use std::os::unix::process::CommandExt;
            let child = Command::new("xcrun").args(["simctl", "io", sim, "recordVideo", "--codec", "h264", "--force", &output])
                .stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(wda_home()).ok();
            std::fs::write(wda_home().join(format!("record-{sim}.json")), json!({ "pid": child.id(), "output": output, "started": now_ms() }).to_string()).map_err(|e| e.to_string())?;
            Ok(json!({ "recording": true, "output": output }))
        })(),
        "record_stop" => (|| {
            let meta: Value = std::fs::read(wda_home().join(format!("record-{sim}.json"))).ok().and_then(|b| serde_json::from_slice(&b).ok()).ok_or("no recording in progress")?;
            let pid = meta["pid"].as_u64().unwrap_or(0).to_string();
            let _ = Command::new("kill").args(["-INT", &pid]).status();
            for _ in 0..100 { if Command::new("kill").args(["-0", &pid]).stderr(Stdio::null()).status().map(|s| !s.success()).unwrap_or(true) { break; } std::thread::sleep(Duration::from_millis(100)); }
            let _ = std::fs::remove_file(wda_home().join(format!("record-{sim}.json")));
            let out = meta["output"].as_str().unwrap_or("").to_string();
            let output = req["output"].as_str().map(String::from).unwrap_or(out.clone());
            if output != out { std::fs::rename(&out, &output).map_err(|e| e.to_string())?; }
            Ok(json!({ "saved": output, "bytes": std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0), "seconds": now_ms().saturating_sub(meta["started"].as_u64().unwrap_or(0)) / 1000 }))
        })(),
        "fs_ls" | "fs_pull" | "fs_push" => (|| {
            let a = bundle_ok(s("app").map_err(|_| "on a simulator, give `app`: files live in its container".to_string())?)?;
            let root = std::path::PathBuf::from(simctl_out(&["get_app_container", sim, a, "data"])?.trim());
            let rel = req["path"].as_str().unwrap_or("/Documents").trim_start_matches('/');
            if rel.split('/').any(|c| c == "..") { return Err("invalid path".into()); }
            let p = root.join(rel);
            match op {
                "fs_ls" => Ok(json!({ "path": format!("/{rel}"), "entries": std::fs::read_dir(&p).map_err(|e| e.to_string())?.flatten().map(|e| {
                    let m = e.metadata().ok(); json!({ "name": e.file_name().to_string_lossy(), "dir": m.as_ref().is_some_and(|m| m.is_dir()), "size": m.map(|m| m.len()).unwrap_or(0) }) }).collect::<Vec<_>>() })),
                "fs_pull" => { let out = s("output")?; std::fs::copy(&p, out).map_err(|e| e.to_string())?; Ok(json!({ "saved": out })) }
                _ => { std::fs::copy(s("file")?, &p).map_err(|e| e.to_string())?; Ok(json!({ "pushed": format!("/{rel}") })) }
            }
        })(),
        "reboot" => simctl(&["shutdown", sim]).and_then(|_| simctl(&["boot", sim])),
        "flow_record_start" | "flow_record_stop" => Err("recording a human's touches is Android-only".into()),
        _ => return None,
    })
}

fn num_of(req: &Value, k: &str) -> R<f64> { req[k].as_f64().ok_or_else(|| format!("missing number `{k}`")) }

pub fn simctl(args: &[&str]) -> R<Value> {
    let o = Command::new("xcrun").arg("simctl").args(args).output().map_err(|e| format!("simctl: {e}"))?;
    if o.status.success() { Ok(json!({})) } else { Err(format!("simctl: {}", String::from_utf8_lossy(&o.stderr).trim())) }
}

fn devicectl(args: &[&str]) -> R<Value> {
    let o = Command::new("xcrun").arg("devicectl").args(args).output().map_err(|e| format!("devicectl: {e}"))?;
    if o.status.success() { Ok(json!({})) } else { Err(format!("devicectl: {}", String::from_utf8_lossy(&o.stderr).lines().find(|l| !l.trim().is_empty()).unwrap_or("failed"))) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn udids() {
        assert!(is_udid("00008140-000964E93610401C"));
        assert!(!is_udid("emulator-5554"));
        assert!(!is_udid("52181VDAQ0008V"));
    }
    #[test]
    fn wda_tree_maps_to_snapshot_shape() {
        let n = json!({ "type": "XCUIElementTypeButton", "label": "Pay ₹438", "name": "pay_btn", "rect": { "x": 10, "y": 20, "width": 100, "height": 40 }, "isEnabled": "1", "isVisible": "1",
            "children": [{ "type": "XCUIElementTypeSecureTextField", "label": "", "name": "", "rect": { "x": 0, "y": 0, "width": 5, "height": 5 }, "isVisible": "0" }] });
        let m = map_node(&n, (393.0, 852.0));
        assert_eq!(m["elementType"], 9);
        assert_eq!(m["identifier"], "pay_btn");
        assert_eq!(m["frame"]["Width"], 100.0);
        assert_eq!(m["children"][0]["elementType"], 50);
        assert_eq!(m["children"][0]["frame"]["Width"], 0.0, "invisible → zero frame");
    }
    #[test]
    fn chunked_bodies() { assert_eq!(dechunk(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), b"Wikipedia"); }
}
