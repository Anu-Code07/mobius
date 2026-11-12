// Execution: the Mobius device driver (drivers/mobiusagent-driver, Rust). One long-lived process speaks JSON lines over stdio.
// Android: stock adb + an on-device helper. iOS: WebDriverAgent over usbmuxd (once built with ios-agent/setup.sh).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Capability, Framework, Key } from '../../core/protocol.ts';
import { MobiusError, type Connector, type DeviceInfo, type Direction, type RawNode, type RawScreen, type TapMode } from '../connector.ts';
import { detectAndroidFramework, toRawNode } from './nodes.ts';

/** The driver binary: $MOBIUS_DRIVER_BIN, the one bundled in the npm package for this platform, or a source build. */
export const driverPath = () => {
  if (process.env.MOBIUS_DRIVER_BIN) return process.env.MOBIUS_DRIVER_BIN;
  const bundled = fileURLToPath(new URL(`../../../bin/mobiusagent-driver-${process.platform}-${process.arch}`, import.meta.url));
  return existsSync(bundled) ? bundled : fileURLToPath(new URL('../../../../../drivers/mobiusagent-driver/target/release/mobiusagent-driver', import.meta.url));
};
/** The driver binary is built (`cargo build --release` in drivers/mobiusagent-driver). */
export const driverBuilt = () => existsSync(driverPath());
/** iOS needs WebDriverAgent built and signed once (drivers/mobiusagent-driver/ios-agent/setup.sh). */
export const iosAgentReady = () => {
  const dir = join(process.env.MOBIUS_WDA_DIR ?? join(homedir(), '.mobius', 'wda'), 'build', 'Build', 'Products');
  try { return readdirSync(dir).some(f => f.endsWith('.xctestrun')); } catch { return false; }
};

export interface AgentDevice { id: string; platform: 'android' | 'ios'; type: 'emulator' | 'simulator' | 'real'; name: string; model: string; version: string; state: string }

export class MobiusAgentDriver {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private next = 1;
  private waiting = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();

  private start() {
    const p = spawn(driverPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: p.stdout }).on('line', line => {
      let r: any; try { r = JSON.parse(line); } catch { return; }
      const w = this.waiting.get(r.id); if (!w) return;
      this.waiting.delete(r.id);
      r.ok ? w.ok(r.data) : w.fail(new MobiusError('INTERNAL', String(r.error)));
    });
    p.on('exit', () => {
      for (const w of this.waiting.values()) w.fail(new MobiusError('INTERNAL', 'mobiusagent-driver exited', { retryable: true }));
      this.waiting.clear(); this.proc = null;
    });
    this.proc = p;
    return p;
  }

  // 2 minutes: the first iOS read may have to start the runner (seconds directly, up to ~90 s through xcodebuild).
  call<T = any>(op: string, args: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
    const p = this.proc ?? this.start();
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        // ponytail: a wedged adb call blocks the one driver process; restart it rather than queue behind it.
        this.proc?.kill(); fail(new MobiusError('TIMEOUT', `mobiusagent-driver ${op} timed out`, { retryable: true }));
      }, timeoutMs);
      this.waiting.set(id, { ok: v => { clearTimeout(t); ok(v); }, fail: e => { clearTimeout(t); fail(e); } });
      p.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  async devices(): Promise<AgentDevice[]> { return (await this.call<{ devices: AgentDevice[] }>('devices')).devices; }
  close() { this.proc?.kill(); this.proc = null; }
}

const KEYS: Partial<Record<Key, string>> = { back: 'back', home: 'home', recents: 'recents', enter: 'enter' };

export class MobiusAgentConnector implements Connector {
  readonly platform: 'android' | 'ios';
  readonly deviceId: string;
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>([
    'observe', 'screenshot', 'tap', 'type', 'swipe', 'scroll', 'press_key', 'list_apps', 'open_app', 'open_url', 'wait_for',
  ]);
  readonly limitations: readonly string[];
  private size: { width: number; height: number } | null = null;
  private fwCache = new Map<string, Framework>();
  private readonly drv: MobiusAgentDriver;
  private readonly dev: AgentDevice;
  constructor(drv: MobiusAgentDriver, dev: AgentDevice) {
    this.drv = drv; this.dev = dev; this.deviceId = dev.id; this.platform = dev.platform;
    this.limitations = [
      'Interaction is coordinate-based (taps at element centres), not semantic accessibility actions.',
      ...(dev.platform === 'ios'
        ? ['iOS: real devices over USB with WebDriverAgent (developer setup). Back and Recents keys do not exist; use on-screen navigation.']
        : ['Android: FLAG_SECURE screens screenshot as black.']),
    ];
  }
  get virtual() { return this.dev.type === 'emulator' || this.dev.type === 'simulator'; }
  private get d() { return { device: this.dev.id }; }

  async info(): Promise<DeviceInfo> {
    return { device_id: this.dev.id, platform: this.dev.platform, connector: 'mobiusagent-driver', name: this.dev.name, model: this.dev.model,
      os_version: this.dev.version, online: this.dev.state === 'online', screen_on: null, locked: null };
  }

  async dump(): Promise<RawScreen> {
    const r = await this.drv.call<{ tree: { hierarchy: any[] }; width: number; height: number; rotation: number; foregroundApp: string | null }>('dump', this.d).catch(e => {
      throw new MobiusError('DEVICE_LOCKED', `Could not read the screen: ${(e as Error).message}`, { retryable: true, hint: 'Ask the user to wake and unlock the phone.' });
    });
    this.size = { width: r.width, height: r.height };
    const root: RawNode = { cls: 'hierarchy', pkg: '', text: '', desc: '', resourceId: '', clickable: false, longClickable: false,
      enabled: true, focused: false, scrollable: false, checkable: false, checked: false, selected: false, password: false,
      bounds: { x: 0, y: 0, width: r.width, height: r.height }, path: 'r', children: [] };
    r.tree.hierarchy.forEach((w, i) => { const n = toRawNode(w, `r.${i}`); if (n) root.children.push(n); });
    return { root, width: r.width, height: r.height, rotation: r.rotation, foregroundApp: r.foregroundApp };
  }

  async framework(pkg: string): Promise<Framework> {
    if (this.platform === 'ios') return 'unknown';
    const hit = this.fwCache.get(pkg); if (hit) return hit;
    const fw = await detectAndroidFramework(this.dev.id, pkg).catch((): Framework => 'unknown');
    this.fwCache.set(pkg, fw); return fw;
  }

  async screenshot(maxSize: number) { return this.drv.call<{ data: string; mimeType: string }>('screenshot', { ...this.d, max: maxSize }); }
  async tap(x: number, y: number, mode: TapMode) { await this.drv.call('tap', { ...this.d, x, y, mode }); }

  async type(text: string, submit: boolean) {
    await this.drv.call('text', { ...this.d, text, submit });
  }

  async swipe(direction: Direction, from: { x: number; y: number } | null, distance: number | null) {
    if (!this.size) this.size = await this.drv.call<{ width: number; height: number }>('size', this.d);
    const s = this.size;
    const start = from ?? { x: s.width / 2, y: s.height / 2 };
    const dist = distance ?? Math.round((direction === 'up' || direction === 'down' ? s.height : s.width) * 0.4);
    const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[direction];
    const clamp = (v: number, hi: number) => Math.max(1, Math.min(hi - 1, Math.round(v)));
    await this.drv.call('swipe', { ...this.d, x1: clamp(start.x, s.width), y1: clamp(start.y, s.height),
      x2: clamp(start.x + dx! * dist, s.width), y2: clamp(start.y + dy! * dist, s.height), ms: 400 });
  }

  async key(key: Key) {
    const k = KEYS[key];
    if (!k || (this.platform === 'ios' && (key === 'back' || key === 'recents'))) throw new MobiusError('UNSUPPORTED_CAPABILITY', `Key "${key}" is not available on this device`);
    await this.drv.call('key', { ...this.d, key: k });
  }

  async openApp(appId: string) {
    await this.drv.call('launch', { ...this.d, app: appId }).catch(e => {
      throw new MobiusError('APP_NOT_INSTALLED', (e as Error).message, { hint: 'Call list_apps to see installed apps.' });
    });
  }
  async openUrl(url: string) { await this.drv.call('url', { ...this.d, url }); }
  async listApps() { return (await this.drv.call<{ apps: string[] }>('apps', this.d)).apps; }
  async extra(op: string, args: Record<string, unknown> = {}) {
    // Long-running ops get their own budget: sessions (`seconds`), routes, installs, first OCR build.
    const secs = Number(args.seconds ?? 0);
    const timeout = op === 'gps_route' ? 3_700_000 : op === 'install' ? 300_000
      : ['perf_report', 'watch_crashes'].includes(op) ? (secs + 120) * 1000 : ['ocr', 'bug_report', 'replay'].includes(op) ? 180_000 : 60_000;
    return this.drv.call(op, { ...this.d, ...args }, timeout);
  }
}
