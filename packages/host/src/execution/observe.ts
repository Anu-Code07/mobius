import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mobiusHome } from '../observability/audit.ts';
import { createHash } from 'node:crypto';
import type { Element, Framework, Observation } from '../core/protocol.ts';
import { MobiusError, type RawNode, type RawScreen } from './connector.ts';

type Role = Element['role'];

function roleOf(n: RawNode): Role {
  const c = n.cls;
  if (/EditText|TextField|AutoCompleteTextView/.test(c)) return 'textbox';
  if (/Switch/.test(c)) return 'switch';
  if (/CheckBox/.test(c)) return 'checkbox';
  if (/RadioButton/.test(c)) return 'radio';
  if (/Button/.test(c)) return 'button';
  if (/RecyclerView|ListView|ScrollView|GridView|ViewPager/.test(c)) return 'list';
  if (/Tab/.test(c)) return 'tab';
  if (n.checkable) return 'checkbox';
  if (n.clickable || n.longClickable) return 'button';
  if (/ImageView|Image/.test(c)) return 'image';
  if (n.text) return 'text';
  return 'view';
}

// ponytail: pattern-based redaction (password flag, card-like digit runs, OTP/verification codes).
// Applied to text AND labels (Flutter merges row text into labels). Per-app rules come with the policy engine.
const REDACTED = '[redacted]';
const CARD_LIKE = /\b(?:\d[ -]?){12,18}\d\b/g;
// Digits may be spaced or dashed ("4 8 2 9 1 3", "482-913") to dodge a plain \d{6} match.
const OTP_LIKE = /\b(otp|one[- ]?time|verification code|security code|passcode|pin|cvv|cvc)\b([^\d]{0,25})\d(?:[ -]?\d){2,7}\b/gi;
export function scrub(s: string): string {
  return s.replace(CARD_LIKE, REDACTED).replace(OTP_LIKE, (_m, kw: string, mid: string) => `${kw}${mid}${REDACTED}`);
}
/** A field asking for a secret, whatever the driver reported (an app may not set the password flag on a PIN box). */
const SECRET_FIELD = /\b(password|passcode|passwd|pin|mpin|upi pin|otp|cvv|cvc|secret)\b|one[- ]?time/i;
const isSensitive = (n: RawNode) => n.password || scrub(n.text) !== n.text || scrub(n.desc) !== n.desc
  || (roleOf(n) === 'textbox' && SECRET_FIELD.test(`${n.desc} ${n.resourceId}`));

const visible = (n: RawNode) => n.bounds.width > 0 && n.bounds.height > 0;
const interactive = (n: RawNode) => n.clickable || n.longClickable || n.scrollable || n.checkable || roleOf(n) === 'textbox';

/** Text of non-interactive descendants, for labelling a clickable container that has none itself. */
function descendantText(n: RawNode, out: string[] = []): string[] {
  for (const c of n.children) {
    if (out.length >= 3) break;
    if (interactive(c)) continue;
    const t = c.text || c.desc;
    if (t && !c.password) out.push(scrub(t));
    descendantText(c, out);
  }
  return out;
}

export interface Fingerprint {
  role: Role;
  text: string | null;
  label: string | null;
  resource_id: string | null;
  cls: string;
  path: string;
  dup_index: number;
}

// Soft keyboards: iOS Keyboard element, or Android IME packages (Gboard, Samsung, SwiftKey...).
const isKeyboard = (n: RawNode) => n.cls === 'Keyboard' || /inputmethod|keyboard|honeyboard|swiftkey/i.test(n.resourceId.split(':')[0] ?? '');

export interface Normalized {
  elements: Element[];
  fingerprints: Map<string, Fingerprint>;
  screen_hash: string;
  tree_quality: Observation['tree_quality'];
  keyboard: Observation['keyboard'];
}

export const MAX_ELEMENTS = 400;

export function normalize(screen: RawScreen, obsId: string): Normalized & { truncated: boolean } {
  const picked: { n: RawNode; text: string | null; label: string | null }[] = [];

  let kb: { x1: number; y1: number; x2: number; y2: number } | null = null;
  const walk = (n: RawNode, insideClickable: boolean) => {
    if (isKeyboard(n) && visible(n)) {
      const b = n.bounds;
      kb = kb ? { x1: Math.min(kb.x1, b.x), y1: Math.min(kb.y1, b.y), x2: Math.max(kb.x2, b.x + b.width), y2: Math.max(kb.y2, b.y + b.height) }
        : { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
      return; // keys are noise for the agent; the area is reported as `keyboard`
    }
    if (!visible(n) && n.cls !== 'hierarchy') {
      // Zero-size containers (common on iOS) can still hold visible children.
      for (const c of n.children) walk(c, insideClickable);
      return;
    }
    const own = n.text || n.desc;
    const isInteractive = interactive(n);
    if (isInteractive) {
      let text: string | null = n.text ? (n.password ? REDACTED : scrub(n.text)) : null;
      const label = n.desc ? scrub(n.desc) : null;
      if (!text && !label && (n.clickable || n.longClickable)) text = descendantText(n).join(' · ') || null;
      picked.push({ n, text, label });
    } else if (own && !insideClickable) {
      // Plain text not owned by a clickable ancestor stays readable for the agent.
      picked.push({ n, text: n.text ? (n.password ? REDACTED : scrub(n.text)) : null, label: n.desc ? scrub(n.desc) : null });
    }
    const clickableHere = insideClickable || n.clickable || n.longClickable;
    for (const c of n.children) walk(c, clickableHere);
  };
  if (screen.root) walk(screen.root, false);

  const truncated = picked.length > MAX_ELEMENTS;
  const dupCount = new Map<string, number>();
  const fingerprints = new Map<string, Fingerprint>();
  const elements: Element[] = picked.slice(0, MAX_ELEMENTS).map(({ n, text, label }, i) => {
    const role = roleOf(n);
    const key = `${role}|${text}|${label}`;
    const dup_index = text || label ? dupCount.get(key) ?? 0 : 0; // unlabeled nodes aren't "duplicates"
    if (text || label) dupCount.set(key, dup_index + 1);
    const id = `${obsId}:e${i + 1}`;
    const resource_id = n.resourceId || null;
    fingerprints.set(id, { role, text, label, resource_id, cls: n.cls, path: n.path, dup_index });
    return {
      id, role, text, label, resource_id,
      clickable: n.clickable, long_clickable: n.longClickable, enabled: n.enabled, focused: n.focused,
      scrollable: n.scrollable, editable: role === 'textbox', checked: n.checkable ? n.checked : null,
      selected: n.selected, sensitive: isSensitive(n), bounds: n.bounds, dup_index,
    };
  });

  const screen_hash = createHash('sha1')
    .update(JSON.stringify(elements.map(e => [e.role, e.text, e.label, e.resource_id, e.bounds, e.enabled, e.checked])))
    .digest('hex').slice(0, 12);

  const actionable = elements.filter(e => e.clickable || e.editable || e.long_clickable);
  const unlabeled = actionable.filter(e => !e.text && !e.label && !e.resource_id).length;
  const tree_quality: Normalized['tree_quality'] =
    elements.length === 0 ? 'empty'
      : actionable.length <= 1 || unlabeled / Math.max(actionable.length, 1) > 0.5 ? 'sparse'
        : 'good';

  const k = kb as { x1: number; y1: number; x2: number; y2: number } | null;
  const keyboard = k ? { x: k.x1, y: k.y1, width: k.x2 - k.x1, height: k.y2 - k.y1 } : null;
  return { elements, fingerprints, screen_hash, tree_quality, truncated, keyboard };
}

const sameIdentity = (a: Fingerprint, e: Element) =>
  a.role === e.role && a.text === e.text && a.label === e.label && a.resource_id === e.resource_id;

/** Identity of an element as a hash: what gets saved to disk, so no screen text is ever written there. */
const identityHash = (f: { role: string; text: string | null; label: string | null; resource_id: string | null }) =>
  createHash('sha256').update(JSON.stringify([f.role, f.text, f.label, f.resource_id])).digest('base64url').slice(0, 22);
type Saved = { id: string; hash: string; dup: number; rid: boolean };

/** Per-device observation history. Element ids are only honoured against the latest screen.
 *  With `persistAs` (the real CLI), recent identities and the id counter survive a restart, so an id an agent got from
 *  an earlier Mobius process still resolves against the live screen (same identity rules, same ambiguity checks). */
export class ObservationStore {
  private seq = 0;
  private history: { obs: Observation; fps: Map<string, Fingerprint> }[] = [];
  private saved: Saved[][] = [];
  private readonly file: string | null;

  constructor(persistAs?: string) {
    this.file = persistAs ? join(mobiusHome(), 'obs', `${persistAs.replace(/[^\w.-]/g, '_')}.json`) : null;
    if (!this.file) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8')) as { seq: number; saved: Saved[][] };
      this.seq = d.seq | 0; this.saved = Array.isArray(d.saved) ? d.saved.slice(-5) : [];
    } catch { /* first run on this device */ }
  }

  nextId(): string { return `o${++this.seq}`; }

  add(obs: Observation, fps: Map<string, Fingerprint>) {
    this.history.push({ obs, fps });
    if (this.history.length > 5) this.history.shift();
    if (!this.file) return;
    this.saved.push([...fps].map(([id, f]) => ({ id, hash: identityHash(f), dup: f.dup_index, rid: !!f.resource_id })));
    this.saved = this.saved.slice(-5);
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify({ seq: this.seq, saved: this.saved }), { mode: 0o600 });
    } catch { /* best effort: ids still work within this process */ }
  }

  latest(): Observation | null { return this.history.at(-1)?.obs ?? null; }

  /**
   * Resolve an element id to an element on the latest screen.
   * Same observation → direct. Older observation → re-find by identity (role/text/label/resource_id/dup_index);
   * unique match survives benign re-renders, otherwise STALE_ELEMENT / AMBIGUOUS_TARGET.
   */
  resolve(id: string): Element {
    const latest = this.history.at(-1);
    if (!latest) throw new MobiusError('STALE_ELEMENT', `No observation yet for ${id}`, { retryable: true, hint: 'Call observe first.' });
    const direct = latest.obs.elements.find(e => e.id === id);
    if (direct) return direct;
    const fp = this.history.find(h => h.fps.has(id))?.fps.get(id);
    if (!fp) {
      // An id from an earlier process: match by saved identity hash on the live screen.
      const sv = this.saved.flat().find(x => x.id === id);
      if (sv) {
        const m = latest.obs.elements.filter(e => identityHash(e) === sv.hash);
        const { width: W, height: H } = latest.obs.screen;
        const vis = m.filter(e => e.bounds.y + e.bounds.height > 0 && e.bounds.y < H && e.bounds.x + e.bounds.width > 0 && e.bounds.x < W);
        if (m.length === 1) return m[0]!;
        if (vis.length === 1) return vis[0]!;
        const exact = m.filter(e => e.dup_index === sv.dup);
        if (m.length > 1 && exact.length === 1 && sv.rid) return exact[0]!;
        if (m.length > 1) throw new MobiusError('AMBIGUOUS_TARGET', `${id} matches ${m.length} elements on the current screen`, { hint: `Pick one of: ${m.map(e => e.id).join(', ')}` });
        throw new MobiusError('STALE_ELEMENT', `${id} is not on the current screen (${latest.obs.observation_id})`, { retryable: true, hint: 'The screen changed. Call observe and pick a fresh id.' });
      }
      throw new MobiusError('ELEMENT_NOT_FOUND', `Unknown element id ${id}`, {
        hint: `Use an id from the latest observation (${latest.obs.observation_id}).`,
      });
    }
    const matches = latest.obs.elements.filter(e => sameIdentity(fp, e));
    const exact = matches.filter(e => e.dup_index === fp.dup_index);
    if (matches.length === 1) return matches[0]!;
    // A copy scrolled far off-screen (sticky headers leave one in the tree; Slikk, live run) isn't what the agent means.
    const { width: W, height: H } = latest.obs.screen;
    const visible = matches.filter(e => e.bounds.y + e.bounds.height > 0 && e.bounds.y < H && e.bounds.x + e.bounds.width > 0 && e.bounds.x < W);
    if (visible.length === 1) return visible[0]!;
    if (exact.length === 1 && matches.length > 1 && fp.resource_id) return exact[0]!;
    if (matches.length > 1) {
      throw new MobiusError('AMBIGUOUS_TARGET', `${id} matches ${matches.length} elements on the current screen`, {
        hint: `Pick one of: ${matches.map(m => m.id).join(', ')}`,
      });
    }
    throw new MobiusError('STALE_ELEMENT', `${id} is not on the current screen (${latest.obs.observation_id})`, {
      retryable: true, hint: 'The screen changed. Call observe and pick a fresh id.',
    });
  }
}

export function buildObservation(
  screen: RawScreen, deviceId: string, platform: Observation['platform'], obsId: string, framework: Framework,
): { obs: Observation; fps: Map<string, Fingerprint> } {
  const n = normalize(screen, obsId);
  return {
    obs: {
      observation_id: obsId,
      device_id: deviceId,
      platform,
      foreground_app: screen.foregroundApp,
      screen: { width: screen.width, height: screen.height, rotation: screen.rotation },
      screen_hash: n.screen_hash,
      framework,
      tree_quality: n.tree_quality,
      sources: ['a11y'],
      elements: n.elements,
      untrusted_content: true,
      truncated: n.truncated,
      keyboard: n.keyboard,
    },
    fps: n.fingerprints,
  };
}
