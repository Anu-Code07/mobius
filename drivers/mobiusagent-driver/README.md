# mobiusagent-driver

The Mobius device driver: one Rust binary that drives **Android** (emulators and phones, over adb plus a 15 KB on-device helper), **real iPhones** (WebDriverAgent over USB) and **iOS simulators**. Mobius uses it under its safety layer. You can also run it on its own as a CLI or as a JSON-lines server.

```sh
cargo build --release
mobiusagent-driver devices
mobiusagent-driver snapshot --device emulator-5554          # the screen as text, with @e1 refs
mobiusagent-driver tap @e4 --device emulator-5554
mobiusagent-driver perf_report --app com.example --seconds 60 --output perf.html --device <id>
```

## What it can do

| Area | Commands |
|---|---|
| **Screen** | `dump` (full tree), `snapshot` (text + refs), `diff`, `ocr`, `screenshot`, `element_screenshot`, `wait_idle`, `foreground`, `size`, `info` |
| **Input** | `tap` (x,y or `@ref`; single/long/double), `tap_text` (falls back to OCR), `swipe`, `pinch`, `text` (any language), `fill`, `key`, `keys` (combos, volume, power), `hide_keyboard` |
| **Apps** | `apps`, `launch`, `terminate`, `install`, `uninstall`, `clear_data`, `app_path`, `url`, `deeplink` (open and verify) |
| **Quality** | `perf_report` (launch, CPU, memory + trend, threads, FPS/jank, battery, crashes, budgets, HTML), `perf`, `a11y_audit`, `visual_check` (baseline + diff image), `bug_report` (HTML), `watch_crashes`, `crashes`, `crash`, `logs` |
| **Device state** | `dark_mode`, `font_scale`, `app_locale`, `battery`, `network` (speed, airplane), `permission`, `settings`, `orientation`, `location`, `gps_route`, `biometric`, `clipboard` |
| **Files & media** | `fs_ls`, `fs_pull`, `fs_push` (device storage and app sandboxes/containers), `record_start` / `record_stop` (MP4), `flow_record_start` / `flow_record_stop` / `replay` |
| **Web** | `webviews`, `webview_dom`, `webview_eval` (Chrome DevTools protocol) |
| **Devices** | `devices`, `boot` (emulator / simulator), `shutdown`, `reboot`, `push_notification` (simulators), `notifications` |

**Platform notes:**
- iOS has no system-settings, font-scale or flow-recording interface, so those commands are Android-only. Biometrics and push notifications need an emulator or simulator.
- Clipboard read on a real iPhone, and WebView inspection on iOS, are not supported yet.

## Speed

**Against [mobilecli](https://github.com/mobile-next/mobilecli), the CLI behind mobile-mcp.**

How it was measured:
- CLI against CLI, one fresh process per command for both tools.
- Median of 7 runs after 2 warm-ups.
- On Android, only one tool's helper runs at a time, because Android allows a single accessibility client.

Rerun it with `python3 bench/compare.py --android <serial> --ios <udid> --cold 3` (needs `mobilecli` on PATH).

| Operation | Android emulator: mobilecli | **mobiusagent-driver** | iPhone 16 (USB): mobilecli | **mobiusagent-driver** |
|---|---|---|---|---|
| Read screen (full tree) | 56 ms | **11 ms** | 564 ms | **192 ms** |
| Tap | 24 ms | **6 ms** | 464 ms | **320 ms** |
| Swipe | 1033 ms | **113 ms** | 604 ms | **421 ms** |
| Type text | 25 ms | **7 ms** | 1815 ms | **329 ms** |
| Screenshot (768 px) | 87 ms | **24 ms** | 253 ms | **78 ms** |
| Foreground app | 91 ms | **28 ms** | 439 ms | **67 ms** |
| List apps | 72 ms | **24 ms** | 238 ms | **151 ms** |
| Launch app | 94 ms | **46 ms** | 91 ms | **31 ms** |
| Orientation | 43 ms | **24 ms** | 30 ms | **15 ms** |

**Cold start** (the first command with nothing running for that tool: no on-device helper or runner, no daemon, no cache):

| | Android: mobilecli | **mobiusagent-driver** | iOS: mobilecli | **mobiusagent-driver** |
|---|---|---|---|---|
| Cold start | 1025 ms | **561 ms** | 3187 ms | **1332 ms** |
| Warm screen read | 56–64 ms | **10–11 ms** | 462–564 ms | **192–432 ms** |

**A real app, end to end:** MakeMyTrip, from launch to the flight checkout page. Same locators and wait logic for both tools; `bench/flow_mmt.py`.

| iPhone 16 | mobilecli | **mobiusagent-driver** |
|---|---|---|
| Cold | 19.5 s | **17.4 s** |
| Warm (median of 3) | 19.2 s | **17.6 s** |

Measured on 2026-11-12. The Android figures are from an emulator.

## How it's fast

**Android: a resident helper.**
- `android-agent/` runs as the shell user through `app_process`, the same way Android's own `uiautomator` runs, and keeps one accessibility connection open.
- **Screen reads** take milliseconds, against 2–4 s for `uiautomator dump`. Reads cover every window and the platform's real password flag.
- **Input** goes straight into the input system (`InputManagerGlobal`), the path Android's `input` command uses, with no shell process per event.
- **Screenshots** are scaled and JPEG-encoded on the phone.
- **Fresh processes** reuse the helper port, checked against its build hash.

**iOS: a tuned WebDriverAgent.**
- **Launch:** started through Apple's test-manager protocol directly (the `idevice` crate), with no `xcodebuild` per start.
- **Screen reads** skip per-element visibility checks; visibility is computed from frames, which is about 15× cheaper.
- **No waits:** no quiescence or idle waits, and screenshots come as JPEG.
- **Taps and swipes** use one raw event each, through a fast-touch patch (`ios-agent/wda-mobius-fast-touch.patch`).
- **Transport:** USB through usbmuxd directly; simulators on localhost.

## Setup

- **Android:** `cargo build --release` is all you need. Rebuild the helper with `android-agent/build.sh` after changing it.
- **iOS, once:** `MOBIUS_TEAM_ID=<your team id> ios-agent/setup.sh`. It builds, patches and signs WebDriverAgent with your team, and installs it on the phone as **Mobius Agent**, with the Mobius icon.
  - Simulators: also build the simulator runner (see `setup.sh`).
  - iOS screen recording uses `ffmpeg`, and OCR uses macOS Vision (built once with `swiftc`).

## Protocol

With no arguments, the driver reads one JSON request per stdin line and writes one JSON reply per stdout line:

```
{"id":1,"op":"dump","device":"emulator-5554"}  →  {"id":1,"ok":true,"data":{...}}
```

## Credits

The iOS runner is [WebDriverAgent](https://github.com/appium/WebDriverAgent) (BSD-3, © Facebook / Appium contributors), built from source with a small patch. iOS device services come from [idevice](https://crates.io/crates/idevice) (MIT).
