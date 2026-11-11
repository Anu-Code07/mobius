// Execution: normalizing what device drivers report into Mobius's RawNode tree, and detecting an app's UI framework.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Framework } from '../../core/protocol.ts';
import type { RawNode } from '../connector.ts';

const run = promisify(execFile);

/** A node as drivers report it: Android (uiautomator / on-device helper) or iOS (XCUITest snapshot). */
export interface SnapshotNode {
  class?: string; text?: string; hint?: string; 'content-desc'?: string; 'resource-id'?: string;
  focused?: boolean; enabled?: boolean; checked?: boolean; checkable?: boolean; clickable?: boolean;
  selected?: boolean; visible?: boolean; editable?: boolean;
  /** The platform password flag, when the driver reports it. */
  password?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  children?: SnapshotNode[] | null;
  // iOS fields (XCUITest snapshot)
  type?: string; label?: string; name?: string; value?: string | null; title?: string;
  elementType?: number; identifier?: string; hasFocus?: boolean; placeholderValue?: string;
  frame?: { X: number; Y: number; Width: number; Height: number };
}

// XCUIElement.ElementType codes we care about → Android-ish class names the normalizer understands.
const IOS_TYPES: Record<number, string> = {
  7: 'Alert', 9: 'Button', 10: 'RadioButton', 12: 'CheckBox', 14: 'PopUpButton', 17: 'ToolbarButton', 19: 'Keyboard',
  20: 'Button(Key)', 21: 'NavigationBar', 22: 'TabBar', 25: 'StatusBar', 26: 'Table(ScrollView)', 32: 'CollectionView',
  33: 'Slider', 40: 'Switch', 41: 'Switch(Toggle)', 42: 'Button(Link)', 43: 'Image', 45: 'TextField(Search)',
  46: 'ScrollView', 48: 'StaticText', 49: 'TextField', 50: 'SecureTextField', 52: 'TextField(TextView)', 75: 'Cell', 80: 'Tab',
};
const IOS_TAPPABLE = new Set([9, 10, 12, 14, 17, 20, 40, 41, 42, 45, 49, 50, 52, 75, 80]);

function iosToRawNode(n: SnapshotNode, path: string): RawNode | null {
  const t = n.elementType ?? 0;
  if (t === 25) return null; // status bar
  const f = n.frame ?? { X: 0, Y: 0, Width: 0, Height: 0 };
  const cls = IOS_TYPES[t] ?? 'Other';
  const editable = t === 45 || t === 49 || t === 50 || t === 52;
  const value = typeof n.value === 'string' ? n.value : '';
  const label = n.label || n.title || '';
  const node: RawNode = {
    cls, pkg: '',
    text: editable || t === 48 ? value || (t === 48 ? label : '') : '',
    desc: t === 48 ? (value && value !== label ? label : '') : label || (editable ? n.placeholderValue ?? '' : ''),
    resourceId: n.identifier ?? '',
    clickable: IOS_TAPPABLE.has(t),
    longClickable: false,
    enabled: n.enabled !== false,
    focused: !!n.hasFocus,
    scrollable: t === 26 || t === 32 || t === 46,
    checkable: t === 12 || t === 40 || t === 41,
    checked: (t === 40 || t === 41 || t === 12) && (value === '1' || value === 'on'),
    selected: !!n.selected,
    password: t === 50 || (editable && SECRET_FIELD.test(`${label} ${n.placeholderValue ?? ''} ${n.identifier ?? ''}`)),
    bounds: { x: f.X, y: f.Y, width: f.Width, height: f.Height },
    path,
    children: [],
  };
  (n.children ?? []).forEach((c, i) => { const ch = iosToRawNode(c, `${path}.${i}`); if (ch) node.children.push(ch); });
  return node;
}

// Status bar holds notification previews (message text, OTP senders): never shown to the agent.
const HIDDEN_IDS = /^com\.android\.systemui:id\/(status_bar_container|status_bar_launch_animation_container)$/;
// Secret fields: the driver's password flag when it has one, plus hint/label/id patterns as a backstop.
const SECRET_FIELD = /\b(password|passcode|passwd|pin|mpin|upi pin|otp|cvv|cvc|secret)\b|one[- ]?time/i;

export function toRawNode(n: SnapshotNode, path: string): RawNode | null {
  if (n.elementType !== undefined) return iosToRawNode(n, path);
  const resourceId = n['resource-id'] ?? '';
  if (HIDDEN_IDS.test(resourceId)) return null;
  const cls = n.class ?? n.type ?? '';
  const editable = n.editable ?? /TextField|EditText|SecureTextField/.test(cls);
  const hint = n.hint ?? '';
  const desc = n['content-desc'] ?? n.label ?? '';
  const node: RawNode = {
    cls: editable && !/EditText|TextField/.test(cls) ? `${cls}(EditText)` : cls,
    pkg: '',
    text: n.text ?? n.value ?? '',
    desc: desc || (editable ? hint : ''),
    resourceId: resourceId || n.name || '',
    clickable: !!n.clickable,
    longClickable: false,
    enabled: n.enabled !== false,
    focused: !!n.focused,
    scrollable: /RecyclerView|ScrollView|ListView|GridView|ViewPager|ScrollView|Table|CollectionView/.test(cls),
    checkable: !!n.checkable,
    checked: !!n.checked,
    selected: !!n.selected,
    password: n.password === true || /SecureTextField/.test(cls) || (editable && SECRET_FIELD.test(`${hint} ${desc} ${resourceId}`)),
    bounds: n.visible === false ? { x: 0, y: 0, width: 0, height: 0 } : (n.rect ?? { x: 0, y: 0, width: 0, height: 0 }),
    path,
    children: [],
  };
  (n.children ?? []).forEach((c, i) => {
    const child = toRawNode(c, `${path}.${i}`);
    if (child) node.children.push(child);
  });
  return node;
}

/** Flutter / React Native detection from the APK's native libs, via adb (Android only). */
export async function detectAndroidFramework(serial: string, pkg: string): Promise<Framework> {
  if (!/^[\w.]+$/.test(pkg)) return 'unknown';
  const sh = async (cmd: string) => (await run('adb', ['-s', serial, 'shell', cmd], { timeout: 10_000 })).stdout;
  const apks = (await sh(`pm path ${pkg}`)).split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
  if (!apks.length) return 'unknown';
  const libs = await sh(`for a in ${apks.map(a => `'${a}'`).join(' ')}; do unzip -l "$a" 2>/dev/null; done | grep -oE "lib(flutter|reactnativejni|hermes)\\.so" | sort -u`);
  return libs.includes('libflutter') ? 'flutter' : /reactnativejni|hermes/.test(libs) ? 'react_native' : 'native';
}

/** Flutter / React Native detection from a simulator app bundle's embedded frameworks. */
export async function detectIosSimFramework(udid: string, bundleId: string): Promise<Framework> {
  if (!/^[\w.\-]+$/.test(bundleId) || !/^[\w\-]+$/.test(udid)) return 'unknown';
  const dir = (await run('xcrun', ['simctl', 'get_app_container', udid, bundleId, 'app'], { timeout: 10_000 })).stdout.trim();
  const { readdir } = await import('node:fs/promises');
  const fws = await readdir(`${dir}/Frameworks`).catch(() => [] as string[]);
  return fws.includes('Flutter.framework') ? 'flutter'
    : fws.some(f => /React|hermes/i.test(f)) ? 'react_native' : 'native';
}
