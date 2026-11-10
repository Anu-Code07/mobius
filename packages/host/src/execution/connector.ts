import type { Bounds, Capability, ErrorCode, Framework, Key } from '../core/protocol.ts';

/** Platform-neutral raw accessibility node, as produced by a connector before normalization. */
export interface RawNode {
  cls: string;
  pkg: string;
  text: string;
  desc: string;
  resourceId: string;
  clickable: boolean;
  longClickable: boolean;
  enabled: boolean;
  focused: boolean;
  scrollable: boolean;
  checkable: boolean;
  checked: boolean;
  selected: boolean;
  password: boolean;
  bounds: Bounds;
  path: string; // index chain from root, e.g. "0.2.1"
  children: RawNode[];
}

export interface RawScreen {
  root: RawNode | null;
  width: number;
  height: number;
  rotation: number;
  foregroundApp: string | null;
}

export interface DeviceInfo {
  device_id: string;
  platform: 'android' | 'ios';
  connector: string;
  name: string;
  model: string;
  os_version: string;
  online: boolean;
  screen_on: boolean | null;
  locked: boolean | null;
}

export type TapMode = 'single' | 'long' | 'double';
export type Direction = 'up' | 'down' | 'left' | 'right';

/** What every device backend implements. Add a platform = add a Connector. */
export interface Connector {
  readonly deviceId: string;
  readonly platform: 'android' | 'ios';
  /** Emulator or simulator (no real accounts or money on it). Undefined = unknown, treated as a real phone. */
  readonly virtual?: boolean;
  readonly capabilities: ReadonlySet<Capability>;
  /** Known limitations surfaced to agents via device_capabilities. */
  readonly limitations: readonly string[];
  info(): Promise<DeviceInfo>;
  /** Accessibility tree of the current screen; should return once the UI is idle. */
  dump(): Promise<RawScreen>;
  framework(pkg: string): Promise<Framework>;
  screenshot(maxSize: number): Promise<{ data: string; mimeType: string }>;
  tap(x: number, y: number, mode: TapMode): Promise<void>;
  type(text: string, submit: boolean): Promise<void>;
  /** `direction` is finger movement; start defaults to screen centre. */
  swipe(direction: Direction, from: { x: number; y: number } | null, distance: number | null): Promise<void>;
  key(key: Key): Promise<void>;
  openApp(appId: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  listApps(): Promise<string[]>;
  /** Driver operations beyond the core set (terminate, install, uninstall, clear_data, orientation, location, clipboard, info).
   *  Optional: connectors without it report UNSUPPORTED_CAPABILITY. */
  extra?(op: string, args?: Record<string, unknown>): Promise<any>;
}

export class MobiusError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; hint?: string } = {}) {
    super(message);
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.hint = opts.hint;
  }
}
