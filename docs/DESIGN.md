# Mobius — System Design (v0.1, for approval)

Mobius makes a smartphone a tool for AI agents (Claude Code, Claude Desktop, Cursor, any MCP client).
The agent decides; Mobius provides **observe / act / verify primitives**, enforces **policy and approvals on the device side**, and is **honest about what each OS permits**.

Status: design only. Nothing below is implemented yet. Approve or amend, then Phase 1 starts.

---

## 0. Decisions vs. the original spec (approved push-backs)

| Spec said | Mobius does | Why |
|---|---|---|
| Separate MCP server + gateway services | One host daemon (`mobius serve`) + thin stdio bridge (`mobius mcp`) | Local-first. One process owns device sockets; multiple MCP clients (Claude Code *and* Cursor) share it without port fights. |
| PostgreSQL + Redis | SQLite (`node:sqlite`, built into Node 22.5+) | No DB server to install for a local tool. Store sits behind an interface, so Postgres is a drop-in for the cloud tier. |
| ~45 MCP tools | 18 tools, capability-gated | Every tool costs agent context on every turn. Variants become parameters (`tap.mode`, `press_key.key`). |
| `action_approve` / `action_reject` as MCP tools | Agent can only **wait** on approvals; humans approve on phone/dashboard | An agent that can approve its own actions has no approval system. |
| `shared-types`, `agent-runtime`, `policy-engine` packages | `packages/protocol` + `packages/host` (modules inside) | Split a package when a second consumer exists, not before. Module boundaries are kept so the split is mechanical. |
| Room DB on Android | No local DB on phone | History/audit live on the host. Phone keeps only pairing keys (Keystore) + settings. |
| Companion app only on Android | Companion app **plus** `adb` dev connector | Lets the MCP loop be tested on an emulator on day 1, and powers future mobile-testing (Phase 5). |
| `automation_*` engine in MVP | Deferred to Phase 4/5; MVP has `task_*` budgets | Spec says the external agent decides; a workflow engine is a later product. |
| Build Android/iOS device control ourselves | **Yes: mobiusagent-driver** (Rust) behind the `Connector` interface | Owning the driver lets the safety layer see what generic drivers drop (all windows, real password flags, drawn text), and makes it fast (resident Android helper, tuned WebDriverAgent with a fast-touch patch, direct test-manager launch). Mobius is Apache-2.0. |

---

## 1. System architecture

Three runtime pieces:

1. **Host daemon** (`packages/host`, Node/TS) — runs on the user's computer. Owns device connections, MCP endpoint, policy engine, approvals, audit log, dashboard. Single process, modular inside.
2. **Device connectors** — anything implementing the `Connector` interface. Mobius ships:
   - `android-app` — Mobius Android app (AccessibilityService) over WebSocket. **Primary.**
   - `ios-app` — Mobius iOS app (App Intents, Shortcuts, EventKit, URL opening) over WebSocket.
   - `android-adb` — ADB from the host (UIAutomator dump + `input`). Dev/emulator/testing only.
   - *Future:* `ios-xctest` (WebDriverAgent-style, developer devices on USB — the only legitimate way to drive arbitrary iOS UI, and only for apps-under-test/dev devices), `cloud-android` (remote device farms).
3. **MCP clients** — Claude Code / Desktop / Cursor talk to the host via stdio bridge or Streamable HTTP.

### Host internal modules

```
host/src/
  mcp/          tool definitions → calls core. No business logic.
  core/         sessions, task budgets, action pipeline, verification, loop detection
  connectors/   Connector interface + android-app, ios-app, android-adb
  gateway/      WebSocket server, pairing, auth, heartbeats, reconnection
  policy/       rules, classifiers, approval queue
  store/        SQLite: devices, audit log, approvals, settings
  dashboard/    localhost web UI (Phase 4)
```

Every action goes through one pipeline — no tool bypasses it:

```
validate(zod) → resolve device → capability check → budget/loop check
 → policy.evaluate → [approval wait] → connector.execute (timeout, cancel)
 → stabilize → verify(expect) → audit log → structured result
```

---

## 2. Architecture diagram

```
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │ Claude Code  │  │Claude Desktop│  │    Cursor    │
 └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
        │ stdio           │ stdio           │ stdio / HTTP
        ▼                 ▼                 ▼
 ┌─────────────────────────────────────────────────────┐
 │  mobius mcp (stdio bridge, auto-starts the daemon)   │
 └──────────────────────────┬──────────────────────────┘
                            │ localhost (Streamable HTTP MCP)
 ┌──────────────────────────▼──────────────────────────┐
 │                  MOBIUS HOST DAEMON                  │
 │  MCP tools ─► Action pipeline ─► Policy + Approvals  │
 │                 │                     │              │
 │           Connector registry      SQLite (audit,     │
 │       ┌─────────┼──────────┐      devices, approvals)│
 │  android-app  ios-app  android-adb    Dashboard :web │
 └───────┬──────────┬──────────┬───────────────────────┘
   WSS (LAN,  WSS (LAN,     adb (USB/
   pinned)    pinned)       emulator)
         ▼          ▼          ▼
 ┌─────────────┐ ┌──────────────┐ ┌──────────────┐
 │Mobius Android│ │ Mobius iOS   │ │ Android dev  │
 │ Accessibility│ │ App Intents  │ │ device/emu   │
 │ Service      │ │ Shortcuts    │ └──────────────┘
 │ + approvals  │ │ EventKit,URLs│
 └─────────────┘ └──────────────┘
```

Approvals flow out-of-band to the human: phone notification and/or dashboard → never through the agent.

---

## 3. Repository structure

```
mobius/
├── apps/
│   ├── android/            Kotlin, Compose, AccessibilityService
│   ├── ios/                Swift, SwiftUI, App Intents
│   └── dashboard/          (Phase 4) served by host
├── packages/
│   ├── protocol/           zod schemas: device protocol, capability manifest,
│   │                       observation, errors → exports JSON Schema + golden fixtures
│   └── host/               daemon + CLI (`mobius serve | mcp | pair | devices`)
├── docs/                   DESIGN.md (this), security.md, android-setup.md,
│                           ios-limitations.md, mcp-setup.md, api-reference.md
├── examples/               MCP client configs, sample agent sessions
├── tests/
│   ├── fixtures/           golden protocol messages (shared by TS/Kotlin/Swift tests)
│   ├── fixture-app/        Android test app with known screens (dialogs, lists, webview…)
│   └── e2e/                scripted MCP client scenarios against emulator/devices
└── README.md
```

Cross-language contract: `packages/protocol` is the source of truth. Kotlin and Swift models are hand-written (small) and **validated against the same golden JSON fixtures** in their unit tests. Codegen is skipped until the protocol churns enough to justify it.

---

## 4. Technology stack

| Layer | Choice | Justification |
|---|---|---|
| Host runtime | Node 22+ LTS, TypeScript strict, ESM | MCP SDK is first-class in TS. Node 25 present locally. |
| MCP | `@modelcontextprotocol/sdk` | Official; stdio + Streamable HTTP transports. |
| Validation | `zod` | Single schema → runtime validation + MCP input schemas + JSON Schema export. |
| Device transport | `ws` + `node:http` | Fastify/Express not needed for a handful of routes; add when dashboard grows. |
| Storage | `node:sqlite` | Zero-install. Behind `Store` interface for Postgres later. |
| Host tests | `node:test` | Built in. |
| Android | Kotlin, minSdk 30, target 35, Compose, coroutines, kotlinx.serialization, OkHttp WebSocket, Android Keystore | minSdk 30 gives `AccessibilityService.takeScreenshot()` without MediaProjection prompts (Android 11+ ≈ large majority of active devices). Lower minSdk possible later with screenshot capability off. |
| iOS | Swift 5.10+/6, SwiftUI, iOS 17+, App Intents, EventKit, `URLSessionWebSocketTask`, Keychain/Secure Enclave | No third-party deps. iOS 17 for mature App Intents. |
| Dashboard | Plain TS + minimal framework (Preact/Vite) served by host | Phase 4; small. |

---

## 5. MCP protocol design

### 5.1 Tools (18)

| Tool | Purpose | Android | iOS app |
|---|---|---|---|
| `device_list` | Paired devices, online state, platform, battery, locked | ✓ | ✓ |
| `device_capabilities` | Capability manifest + known limitations for one device | ✓ | ✓ |
| `observe` | Normalized screen: foreground app, elements, `observation_id`; optional screenshot | ✓ | Mobius-own UI only* |
| `wait_for` | Block until element/text/app condition holds or timeout (event-driven) | ✓ | — |
| `tap` | `target: element_id \| {x,y}`, `mode: single\|long\|double` | ✓ | — |
| `type` | Text into focused/target field, optional `submit` | ✓ | — |
| `scroll` | `direction`, optional container `element_id`, `until` element | ✓ | — |
| `swipe` | Raw gesture `from→to`, duration | ✓ | — |
| `press_key` | `back \| home \| recents \| notifications \| enter` | ✓ | — |
| `list_apps` | Launchable apps | ✓ | Declared schemes only |
| `open_app` | Launch by package/bundle id | ✓ | Via URL scheme where known |
| `open_url` | URL / deep link / universal link | ✓ | ✓ (app must be foreground) |
| `run_shortcut` | Run named Shortcut with input, get result via x-callback | — | ✓ |
| `device_action` | Named native actions from the manifest (e.g. `create_reminder`, `create_event`, `set_alarm`) | ✓ (intents) | ✓ (EventKit) |
| `approval_wait` | Wait for a human decision on `approval_id` | ✓ | ✓ |
| `task_start` | Declare goal + budgets → `task_id` | ✓ | ✓ |
| `task_status` | Budget usage, history, last good state | ✓ | ✓ |
| `task_cancel` | Cancel task + in-flight action | ✓ | ✓ |

\* iOS cannot read other apps' UI. `ios-xctest` (future, dev devices) and a user-started ReplayKit broadcast (future, observation-only screen frames) are the only supported routes.

**Capability gating.** `tools/list` exposes a tool only if ≥1 connected device supports it; `notifications/tools/list_changed` fires on connect/disconnect. Every call re-checks the *target* device and returns `UNSUPPORTED_CAPABILITY` with `alternatives` (e.g. "use `run_shortcut` or `open_url`").

**Extensibility.** New native features are added as entries in a device's manifest and invoked through `device_action` — no new MCP tool needed. A new tool is added only for a new *interaction primitive*.

### 5.2 Common shapes

Every tool accepts `device_id` (optional if exactly one device online), optional `task_id`, `timeout_ms`.

Action result:
```json
{
  "ok": true,
  "action_id": "act_01J…",
  "status": "succeeded",          // succeeded | failed | blocked | pending_approval | outcome_unknown
  "duration_ms": 240,
  "state_changed": true,
  "foreground_app": "com.example.app",
  "observation_id": "obs_42",     // fresh observation after stabilization
  "verified": true,               // only when `expect` was passed
  "message": "Tapped 'Search' (button)"
}
```

Error:
```json
{ "ok": false, "error": { "code": "STALE_ELEMENT", "message": "...", "retryable": true,
  "hint": "Call observe again; screen changed since obs_41", "diagnostics": {…} } }
```

Optional `expect` on any action: `{ "text_visible": "Results" } | { "app": "pkg" } | { "element_gone": "o41:e7" }` → server waits for stabilization and sets `verified`.

### 5.3 Error codes
`INVALID_INPUT, DEVICE_NOT_FOUND, DEVICE_OFFLINE, DEVICE_LOCKED, SERVICE_DISABLED, PERMISSION_REQUIRED, UNSUPPORTED_CAPABILITY, ELEMENT_NOT_FOUND, AMBIGUOUS_TARGET, STALE_ELEMENT, SECURE_WINDOW, APP_NOT_INSTALLED, POLICY_BLOCKED, APPROVAL_REQUIRED, APPROVAL_REJECTED, APPROVAL_EXPIRED, BUDGET_EXCEEDED, LOOP_DETECTED, RATE_LIMITED, DUPLICATE_ACTION, TIMEOUT, CANCELLED, OUTCOME_UNKNOWN, FOREGROUND_REQUIRED, INTERNAL`

### 5.4 Observation format

```json
{
  "observation_id": "obs_42",
  "device_id": "dev_7f3a",
  "platform": "android",
  "foreground_app": "com.example.app",
  "screen": { "width": 1080, "height": 2400, "rotation": 0, "density": 2.75 },
  "screen_hash": "a91c…",
  "keyboard_visible": false,
  "windows": ["app", "dialog"],
  "elements": [
    { "id": "o42:e1", "role": "button", "text": "Search", "label": null,
      "resource_id": "com.example:id/search", "clickable": true, "enabled": true,
      "focused": false, "scrollable": false, "editable": false, "sensitive": false,
      "bounds": { "x": 20, "y": 100, "width": 200, "height": 60 }, "dup_index": 0 }
  ],
  "framework": "flutter",          // native | flutter | compose | react_native | webview | unknown
  "tree_quality": "sparse",        // good | sparse | empty → hints screenshot/vision fallback
  "sources": ["a11y"],             // a11y | flutter_vm | vision — which layers produced elements
  "untrusted_content": true,
  "truncated": false,
  "screenshot": null
}
```

- Only **meaningful** nodes are emitted (interactive, labelled, or text-bearing); layout-only wrappers are collapsed. Clickable parents absorb text of non-clickable children.
- `dup_index` disambiguates identical text; `AMBIGUOUS_TARGET` is returned if an agent targets by text and >1 match.
- `sensitive: true` → text replaced by `"[redacted]"` (password fields, `isPassword`, OTP/card patterns).
- Screenshots: off by default; `observe({screenshot: true})` returns a JPEG at configurable scale/quality, with `scale` so coordinates map back. Never sent anywhere except to the requesting MCP client. Blocked by policy for sensitive app categories.

---

## 6. Android AccessibilityService design

**Components**
- `MobiusAccessibilityService` — the long-lived component. Bound by the system, so it keeps the process alive and is exempt from background-activity-start limits (needed for launching apps). Hosts the WebSocket client — **no separate foreground service** (avoids Android 14/15 FGS-type restrictions). A persistent low-priority notification shows "Mobius connected" for transparency.
- `ObservationEngine` — walks `getWindows()` (with `flagRetrieveInteractiveWindows`) + `rootInActiveWindow`, normalizes, redacts, assigns ids, computes structural `screen_hash`.
- `ActionExecutor` — semantic first, coordinates second:
  - tap: `ACTION_CLICK` on node (or nearest clickable ancestor) → fallback `dispatchGesture` at bounds center.
  - long press: `ACTION_LONG_CLICK` → gesture.
  - type: `ACTION_SET_TEXT` on editable → fallback clipboard + `ACTION_PASTE`.
  - scroll: `ACTION_SCROLL_FORWARD/BACKWARD` on scrollable container → swipe gesture.
  - keys: `performGlobalAction(BACK/HOME/RECENTS/NOTIFICATIONS)`; enter via `ACTION_IME_ENTER` (API 30).
  - open app: `getLaunchIntentForPackage` (+ `<queries>` for launcher intent; **no** `QUERY_ALL_PACKAGES`).
  - screenshot: `takeScreenshot()`; `ERROR_TAKE_SCREENSHOT_SECURE_WINDOW` → `SECURE_WINDOW`.
- `Stabilizer` — after an action, waits for `TYPE_WINDOW_STATE_CHANGED` / `TYPE_WINDOW_CONTENT_CHANGED` to go quiet for a short idle window (default 300 ms, capped by timeout). Event-driven, not fixed sleeps.
- `ElementResolver` — each id maps to a **fingerprint** (resource id, class, text/label, tree path, bounds). On action, re-resolve fingerprint in the *current* tree:
  - unique match → act (handles benign re-renders),
  - none / moved to a different screen hash → `STALE_ELEMENT`,
  - multiple → `AMBIGUOUS_TARGET`.
  Ids from older observations of a *different* screen are always stale.
- `ApprovalUI` — notification with Approve/Reject + in-app sheet showing the real target from the device (not the agent's description).
- `Pairing` — QR scan → key pair in Keystore → register with host.

**Guards**: `KeyguardManager.isKeyguardLocked` → `DEVICE_LOCKED` (Mobius never unlocks secure lock screens). Service-disabled is detected by host as a dropped connection + last-known-state `SERVICE_DISABLED`.

**Distribution reality**: Google Play restricts AccessibilityService use outside accessibility purposes → Mobius Android is sideloaded / dev distribution. On Android 13+ sideloaded apps hit **"Restricted settings"**: user must enable *Allow restricted settings* in App Info before the accessibility toggle works. Setup docs and the in-app onboarding walk through this.

---

## 6a. Framework-aware observation (Flutter first)

Agents shouldn't care what framework an app uses; Mobius should. Observations carry `framework` and `tree_quality`, and the host keeps a private `element_id → source layer` map so actions route correctly. The agent always sees one normalized element list.

### Mode 1 — any installed Flutter app (release, no code access) · Phase 1

Already covered by the AccessibilityService. Flutter builds its accessibility tree from the Semantics layer, and only while an accessibility service is enabled, which Mobius's is.

- Standard widgets (buttons, text fields, list tiles) appear as normal nodes, so semantic tap and type work.
- Custom-painted widgets, unlabeled `GestureDetector`s and bare icons are missing or blank. The observation reports `tree_quality: "sparse"`, and the agent falls back to `observe({screenshot:true})` plus coordinate taps.
- **Detection:** a `FlutterView` / `io.flutter.*` class in the window's node tree, or `lib/*/libflutter.so` inside the package's APK (the APK's `sourceDir` is readable). The result is cached per `package + versionCode`.
- **Timing:** Flutter updates its semantics a frame or two after the pixels. This needs no fixed sleeps, because the event-driven stabilizer already waits for `WINDOW_CONTENT_CHANGED` to go quiet. Flutter apps get a slightly longer idle window (a per-framework setting, tuned by benchmark).
- **Apps you build:** `Semantics(identifier: 'checkout_pay_button', …)` (Flutter 3.19+) becomes `resource-id` on Android and `accessibilityIdentifier` on iOS. Mobius surfaces it as `resource_id`, which is the most stable target an agent can have. Teams already adding Maestro semantics IDs get this for free.

### Mode 2 — your own app in debug/profile (VM Service) · Phase 5

A debug or profile build exposes the Dart VM Service, which gives the full widget tree, runtime errors, screenshots and hot reload.

**Design decision:** use the VM Service to **enrich observations, not to execute actions.**
- **Observe:** a `flutter-vm` enricher (in the host) attaches only when the developer explicitly links a running debug session (a VM Service URI from `flutter run`, or the Dart Tooling Daemon). It merges widget-tree data (widget type, keys, source location) onto a11y elements by bounds overlap. VM Service coordinates are logical pixels, so they're converted to screen pixels using `devicePixelRatio` and the FlutterView's offset. Elements that exist only in the widget tree are added with `source: "flutter_vm"`.
- **Act:** taps and typing still go through the AccessibilityService or `adb`. One input path means one set of verification, policy and idempotency rules. Injecting pointer events through the VM Service would need the app to enable `flutter_driver` or to evaluate Dart code. That adds a second, divergent action path for no gain, because real OS input already reaches debug builds.
- **Code loop (edit → hot reload → verify):** don't rebuild it. Run the official **Dart MCP server** (`dart mcp-server`, from the Dart team) alongside Mobius. It covers the widget tree, hot reload and runtime errors. Mobius covers device control, policy and verification. The two compose in the agent.
- Third-party Flutter MCP drivers (e.g. Dusk, flutter-pilot) haven't been evaluated yet. Mobius won't depend on them until they're tested.

**Hard rule:** VM Service attach is opt-in, limited to debug/profile builds the developer launched, and bound to localhost. Mobius never attempts to attach to release apps it doesn't own. That isn't possible anyway, and attempting it would be circumventing the app owner's protections.

The same `framework` + enricher slot later fits React Native (Hermes debugger) and WebViews (Chrome DevTools Protocol for your own debuggable WebViews).

---

## 7. iOS capability design (honest)

iOS gives third-party apps **no** cross-app UI reading or tapping. Mobius iOS is a capability provider, not a remote control.

| Capability | How | Constraint |
|---|---|---|
| Connection to host | `URLSessionWebSocketTask` while app is **foreground** ("session mode": screen kept awake via `isIdleTimerDisabled`) | iOS suspends background sockets. Background → device reported `suspended`; actions return `FOREGROUND_REQUIRED`. Push-wake (APNs) needs a cloud relay → future. |
| Open URL / deep link / universal link | `UIApplication.open` | Foreground only; result is only "handed off", not "succeeded inside target app". |
| Is app installed | `canOpenURL` for schemes in `LSApplicationQueriesSchemes` | Limited to declared schemes (≤50). Unknown → "unknown", never guessed. |
| Run Shortcut | `shortcuts://x-callback-url/run-shortcut?name=&input=&x-success=mobius://…` | Shortcuts app comes foreground; result returns via callback; some actions prompt user. |
| List Shortcuts | No public API. User installs a provided "Mobius: List Shortcuts" helper shortcut (uses *Get My Shortcuts*) that calls back into Mobius | Requires one-time user setup; otherwise `UNSUPPORTED_CAPABILITY` with setup hint. |
| Reminders / Calendar | EventKit inside Mobius (`device_action: create_reminder, create_event, list_events`) | Requires user permission; truly executes. |
| Mobius App Intents | Mobius exposes intents (e.g. "Get next Mobius command", "Report result") to Shortcuts | Lets users build Shortcut automations that bridge Mobius ↔ other apps' App Intents. Mobius **cannot** call another app's App Intents directly. |
| Approvals | Local notifications + in-app sheet | Works while app is foreground or via notification tap. |
| Screen observation of other apps | **Not supported.** Future opt-in: ReplayKit Broadcast Upload Extension (user starts broadcast; frames only, no input) | Clearly labelled observation-only. |
| Arbitrary UI control | **Not supported** in the app. Future `ios-xctest` connector for developer devices tethered to a Mac (testing use case) | Requires Xcode + developer signing; not for consumer phones. |

Local network: `NSLocalNetworkUsageDescription` (iOS 14+ prompt) and `NSAllowsLocalNetworking` in ATS. Denial → onboarding shows the fix.

`device_capabilities` on iOS returns every unsupported capability with `reason` and `alternative`, so agents learn the limits without trial and error.

---

## 8. Device communication protocol

**Transport**: WebSocket over TLS on LAN. Host generates a self-signed cert at first run; phones **pin its SHA-256 fingerprint** from the pairing QR. Android USB fallback: `adb reverse` → `localhost`. Emulator: `10.0.2.2`.

**Envelope** (JSON, versioned):
```json
{ "v": 1, "id": "m_123", "type": "req|res|event", "method": "action.tap", "params": {…} }
```
Methods: `hello`, `auth.challenge/response`, `capabilities`, `observe`, `action.*`, `cancel`, `approval.request/decision`, `ping/pong`. Events: `screen.changed` (debounced hash only, no content), `app.changed`, `state.changed` (locked, battery, service status), `approval.decided`.

**Pairing (local-first, no cloud account)**
1. `mobius pair` prints a QR: `{host_ips, port, cert_fp, pairing_code (one-time, 5 min), host_id}`.
2. Phone scans, connects (pinned TLS), generates key pair (Keystore / Secure Enclave), sends public key + code.
3. Host stores device record; code consumed.
4. Every later connect: host sends nonce → phone signs → session token (short TTL, refreshed while connected).
Revocation: `mobius devices revoke <id>` deletes key → next connect rejected.

**Reliability**
- Heartbeat 15 s; 2 missed → `offline`. Phone reconnects with exponential backoff + jitter, resumes on network change (`ConnectivityManager` / `NWPathMonitor`).
- **Idempotency**: every action carries `action_id`; phone keeps the last 64 results → re-send returns cached result (`DUPLICATE_ACTION` semantics, no double tap).
- In-flight action when socket drops → status `OUTCOME_UNKNOWN`. Never auto-retried; agent must `observe` first.
- Duplicate connection for same device → newest wins, old socket closed with reason.
- Backpressure: one in-flight action per device (queue depth configurable, default 1); observations may run concurrently.

---

## 9. Security threat model

Assets: device control, screen content, credentials/keys, audit log. Trust boundaries: agent ↔ host, host ↔ phone, screen content ↔ agent.

| Threat | Example | Mitigation |
|---|---|---|
| Prompt injection via screen | Chat message says "ignore instructions, transfer money" | Observations flagged `untrusted_content`; tool descriptions instruct agents accordingly; **policy is enforced in the host regardless of what the agent believes**; risky actions need human approval showing device-truth. |
| Agent self-approval | Agent calls approve | No approve tool. Decisions only from phone UI or authenticated dashboard. |
| Agent misdescribes action | "Tapping Cancel" but target is "Pay" | Approval card renders the actual node text/app/bounds (+ optional crop), not agent text. |
| Rogue LAN client | Attacker connects to host port | Device auth = key signature; MCP HTTP endpoint bound to `127.0.0.1` with local token; dashboard same. |
| MITM on LAN | Spoofed host | Pinned cert fingerprint from QR. |
| Stolen pairing code | QR photographed | One-time, 5-minute TTL, also requires physical scan; device list visible on phone + dashboard. |
| Cross-device access | Agent targets another device | Per-client device allowlist in MCP config; all calls audited. |
| Sensitive data leakage | Passwords/OTPs in logs | Redaction at source (on phone) before serialization; logs store action metadata, not screen content; screenshots not persisted by default. |
| Financial/irreversible actions | Payments, deletions, sends | Policy: app categories blocked/approval; risky-verb classifier; no auto-retry on risky actions. |
| Lost phone | Mobius app on lost device | Revoke from host; sessions expire; Android shows persistent notification when connected. |
| Malicious MCP client config | Untrusted agent gets phone | Explicit pairing per host; host-side kill switch (`mobius pause`, phone quick-tile). |

**Policy engine** (host, `policy/`):
```json
{
  "default": "allow",
  "apps": { "banking": "blocked", "payments": "blocked", "messaging": "approval_required" },
  "actions": { "type.password": "blocked", "screenshot": "allow", "open_url": "allow" },
  "risky_targets": { "match": ["send","pay","buy","place order","transfer","delete","confirm"], "decision": "approval_required" },
  "approval_ttl_s": 120
}
```
Honest limit: Mobius cannot *know* the semantics of a tap. Classification uses app category lists (seeded, user-editable), target text/role, and input patterns. It is a strong safety net, not a guarantee; category blocks are the hard guarantee.

---

## 10. Edge-case handling matrix

| Area | Case | Detection | Response | Recovery |
|---|---|---|---|---|
| Net | Wi-Fi drop / network switch | Heartbeat miss, path monitor | `DEVICE_OFFLINE` | Auto-reconnect; in-flight → `OUTCOME_UNKNOWN` |
| Net | Host restart | Socket close | Phone backoff reconnect | Sessions re-auth; tasks marked interrupted |
| Net | MCP client restart | Bridge reconnects to daemon | none | Tasks persist in daemon |
| Net | Credentials expired/revoked | Auth failure | `DEVICE_OFFLINE` + reason | Re-pair |
| Net | Duplicate connection | Same device id | Newest wins | — |
| Net | Multiple devices | — | `device_id` required when >1 online | — |
| Android | Accessibility disabled/revoked | Service `onUnbind`/drop | `SERVICE_DISABLED` | Notification deep-links to settings |
| Android | Process killed | Socket drop | `DEVICE_OFFLINE` | System rebinds service; reconnect |
| Android | Locked / screen off | Keyguard check | `DEVICE_LOCKED` | User unlocks; `wait_for` resumable |
| Android | Battery saver / low battery | Battery events | Warning in `device_list`; heartbeat relaxed | — |
| Android | System permission dialog | Foreground pkg = permissioncontroller | Observation shows dialog; tap on "Allow" = approval_required | — |
| Android | OEM restrictions (MIUI, etc.) | Capability probe at startup | Capability off + reason | Setup doc per OEM |
| Android | Restricted settings (13+) | Onboarding check | Guided fix | — |
| UI | App crash | `app.changed` to launcher / crash dialog | `state_changed`, `verified:false` | Agent re-observes |
| UI | Spinner never ends | `wait_for` timeout | `TIMEOUT` with last observation | — |
| UI | Duplicate buttons | `dup_index` | `AMBIGUOUS_TARGET` if by text | Target by id |
| UI | Invisible/offscreen | `isVisibleToUser`, bounds | Not emitted / `ELEMENT_NOT_FOUND` | `scroll until` |
| UI | Disabled control | `enabled:false` | Tap refused `ELEMENT_NOT_FOUND`-disabled hint | — |
| UI | Keyboard covers target | IME window bounds overlap | Hint; auto `back` to dismiss is opt-in | — |
| UI | Dialog / bottom sheet | Multiple windows | Elements tagged by window; top window first | — |
| UI | WebView | Chrome a11y tree usually present | Normal | Coordinate fallback |
| UI | Canvas/game, empty tree | 0 meaningful nodes | `observe` hints screenshot | Coordinate tap |
| UI | Flutter app, unlabeled widgets | `framework:flutter`, `tree_quality:sparse` | Elements present + screenshot hint | Coordinate tap; add `Semantics(identifier)` if own app |
| UI | Flutter semantics lag | Content-changed events continue | Longer per-framework idle window | — |
| UI | VM Service session ends (debug app restarted) | Enricher socket close | Silently drop to a11y-only, `sources` updated | Developer re-links |
| UI | Rotation / font scale / dark mode | Screen dims change, hash change | Old ids stale | Re-observe |
| UI | Stale id | Fingerprint resolve | `STALE_ELEMENT` | Re-observe |
| UI | Secure window (FLAG_SECURE) | Screenshot error | `SECURE_WINDOW` | Tree still may work |
| UI | Coordinate mismatch | `scale` field | Coordinates in screenshot space mapped | — |
| Agent | Invalid action | zod | `INVALID_INPUT` | — |
| Agent | Repeats action / stuck | Same (action, fingerprint, screen_hash) ×3 | `LOOP_DETECTED` | Agent changes strategy |
| Agent | Hallucinated element | Resolver | `ELEMENT_NOT_FOUND` + nearest matches | — |
| Agent | Wrong app | Foreground check vs `expect.app` | `verified:false` | — |
| Agent | Budget exceeded | Task counters | `BUDGET_EXCEEDED` | New task / user |
| Agent | Prohibited op | Policy | `POLICY_BLOCKED` | — |
| Agent | Other device | Allowlist | `DEVICE_NOT_FOUND` | — |
| Agent | Injected instructions | N/A (content) | Policy + approvals still apply | — |
| iOS | Shortcut missing | x-error callback | `ELEMENT_NOT_FOUND`-shortcut | — |
| iOS | Shortcut needs confirmation | Callback delayed | `pending` until callback/timeout | — |
| iOS | App not installed / link unsupported | `canOpenURL`/open result false | `APP_NOT_INSTALLED` / `UNSUPPORTED_CAPABILITY` | — |
| iOS | Mobius backgrounded/suspended | scenePhase, socket drop | `FOREGROUND_REQUIRED` | User reopens app |
| iOS | Permission revoked | EventKit auth status | `PERMISSION_REQUIRED` | Settings deep link |
| iOS | Device locked | Protected data unavailable | `DEVICE_LOCKED` | — |
| iOS | Cross-app UI request | Capability check | `UNSUPPORTED_CAPABILITY` + alternatives | — |

**Recovery rules (global):** structured error always; diagnostics captured without screen content unless permitted; **no automatic retry for any action classified risky or with `OUTCOME_UNKNOWN`**; safe retries (observe, wait, non-risky taps on `STALE_ELEMENT` after re-resolve) at most once; resume only after a fresh `observe`.

---

## 11. MVP implementation plan

Android and iOS both ship; Android first because it's the only platform with general UI control, iOS in parallel from Phase 2.

**Phase 1 — Android PoC (acceptance: Claude Code inspects a real Android phone, taps a control, types, verifies)**
- M1 `packages/protocol`: schemas, errors, golden fixtures. Host skeleton: daemon, `mobius mcp` bridge, connector interface, action pipeline (no policy yet), SQLite audit.
- M2 `android-adb` connector → full MCP loop against emulator. *Proves tool design with Claude Code before any Kotlin.*
- M3 Android app: AccessibilityService, observation engine, tap/type/scroll/keys/open app, screenshot, WebSocket + basic QR pairing.
- M4 Verification (`expect`, stabilizer, stale handling), E2E on emulator + one physical phone, Claude Code setup doc.

**Phase 2 — Reliability + iOS companion (two tracks)**
- Track A: signed pairing/revocation, idempotency, reconnection, policy engine, approvals (phone notification), tasks/budgets, loop detection.
- Track B: iOS app — session mode, pairing, open_url, run_shortcut (x-callback), EventKit `device_action`s, capability manifest with explicit unsupported list, local-notification approvals.

**Phase 3** — Claude Desktop/Cursor verified configs, multi-device, diagnostics, docs.
**Phase 4** — Dashboard, SDK (`@mobius/client`), examples.
**Phase 5** — Agentic mobile testing: scenarios, traces, HTML reports, `ios-xctest` connector, `flutter-vm` observation enricher.

Flutter release-app support (detection, `tree_quality`, tuned stabilizer) lands in Phase 1 M3/M4. The fixture app gets a Flutter twin so both paths are tested.

**Key risks**
1. OEM accessibility quirks (Xiaomi/Samsung background kills) → per-OEM docs, probe at startup.
2. Sideload friction (restricted settings) → onboarding flow.
3. iOS foreground requirement limits usefulness → stated upfront; cloud push relay later.
4. Observation size → token cost; mitigated by node pruning + `observe({mode:"compact"})`.
5. Risk classifier false negatives → category hard-blocks as backstop.

---

## 12. Testing strategy

| Layer | Tool | What |
|---|---|---|
| Protocol | `node:test` + golden fixtures | Schema round-trips; same fixtures consumed by JUnit + XCTest |
| Host unit | `node:test` | Pipeline order, policy decisions, approvals, budgets, loop detection, idempotency, cancellation |
| Host integration | Fake connector over real WebSocket | Auth, reconnect, duplicate connection, offline mid-action → `OUTCOME_UNKNOWN` |
| MCP | SDK `Client` in-process | Tool registration, `list_changed` on connect, schema validation, error shapes |
| Android unit | JUnit | Normalizer, redaction, fingerprint resolver on recorded trees |
| Android instrumented | AndroidX Test on emulator + `tests/fixture-app` | Service startup, extraction, tap/type/scroll/gestures, dialogs, lists, webview, rotation, permission revocation |
| iOS | XCTest on simulator | App Intents, EventKit, URL handling, capability manifest, unsupported responses, scene suspension |
| E2E | Scripted MCP client vs emulator (CI) and physical devices (manual, logged) | The 10-step scenario: connect → capabilities → open app → observe → find → tap → verify → disconnect → reconnect → resume |
| Benchmarks | Script on real devices | Observe/action latency p50/p95, reconnect time, failure rate, observation tokens; published with device model — no unmeasured claims |

Compatibility claims (Claude Code, Desktop, Cursor) are made only after each passes the E2E scenario.
