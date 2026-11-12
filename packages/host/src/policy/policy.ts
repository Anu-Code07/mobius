import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Element } from '../core/protocol.ts';

export type Decision = 'allow' | 'approval_required' | 'blocked';

export interface PolicyConfig {
  /** Apps where agents may not act or read (regex on package / bundle id). */
  blocked_apps: string[];
  /** Apps where every state-changing action needs approval. */
  approval_apps: string[];
  /** Target text/label/id words that make a tap need approval (money, sending, deleting, committing). */
  risky_words: string[];
  /** Typing into password/PIN/OTP fields. */
  secret_entry: Decision;
  /** Typing with submit:true (sends messages, submits forms). */
  submit: Decision;
  approval_timeout_s: number;
  /** After a human clicks Approve: also require the device owner (Touch ID / login password), which a script cannot fake. */
  approval_auth: 'none' | 'device_owner';
  /** Policy as code: versioned rules, first match wins. They can tighten anything; they can never loosen a hard block. */
  version: string;
  rules: PolicyRule[];
  /** Compute and audit decisions but don't enforce approvals (blocks still enforced). For tuning rules on emulators. */
  dry_run: boolean;
}

export interface PolicyRule {
  /** Stable id, recorded in every audit entry it decides. */
  id: string;
  effect: Decision;
  description?: string;
  /** Regex on the app id (anchored to a segment start, like the app lists). */
  app?: string;
  tool?: string[];
  action_class?: ActionClass[];
  /** Regex on the target's text/label/id. */
  target?: string;
  /** Matches only when the amount involved is known and at most this (same currency units as shown). */
  max_amount?: number;
}

// ponytail: seed lists, user-editable via MOBIUS_POLICY (JSON file). Heuristic by nature; category blocks are the hard guarantee.
export const DEFAULT_POLICY: PolicyConfig = {
  // Patterns match from the start of a package/bundle-id segment ("axis" hits com.axis.mobile, not com.taxis.app).
  blocked_apps: [
    'bank', 'netbanking', 'sbi', 'hdfc', 'icici', 'axis', 'kotak', 'paytm\\.money', 'zerodha', 'groww',
    'phonepe', 'paisa', 'gpay', 'paypal', 'venmo', 'cash\\.app', 'coinbase', 'binance',
    // credentials: password managers and authenticators by their real bundle/package ids
    'authenticator', 'authy', '1password', 'onepassword', 'agilebits', 'bitwarden', 'x8bit', 'lastpass', 'dashlane', 'keepass', 'keeper', 'proton\\.pass',
  ],
  approval_apps: [
    // messaging / social: everything they do is "send"
    'whatsapp', 'telegram', 'messag', 'mobilesms', 'mms', 'gmail', 'outlook', 'slack', 'instagram', 'twitter', 'x(\\.|$)', 'linkedin', 'facebook',
    // card and fintech apps: usable (travel, rewards) but every state change asks
    'scapia', 'dreamplug', 'cred', 'slice', 'onecard', 'jupiter', 'niyo', 'pnb', 'fi\\.money',
  ],
  risky_words: [
    // 'book'/'request'/'checkout': live run found "book Cab Non AC service" (Rapido), "Request Uber Go", "Slide to book" slipping through.
    'pay', 'payment', 'place order', 'order now', 'buy', 'buy now', 'purchase', 'book', 'request', 'checkout', 'book now', 'confirm booking', 'book ride',
    'book ticket', 'book seat', 'confirm ride', 'request ride', 'confirm', 'transfer', 'send', 'delete',
    'remove account', 'unsubscribe', 'cancel order', 'cancel booking', 'submit', 'post', 'publish', 'share', 'donate', 'subscribe',
    'withdraw', 'request money', 'install', 'uninstall', 'reset', 'erase', 'sign out', 'log out', 'accept terms', 'agree',
    // Indian languages: Hindi, Tamil, Telugu, Kannada, Bengali, Marathi (pay / order / book / send / delete / buy / confirm)
    'भुगतान', 'पेमेंट', 'ऑर्डर', 'बुक', 'भेजें', 'भेजो', 'हटाएं', 'हटाएँ', 'खरीदें', 'पुष्टि',
    'செலுத்து', 'அனுப்பு', 'பதிவு செய்', 'చెల్లించు', 'పంపు', 'బుక్', 'ಪಾವತಿ', 'ಕಳುಹಿಸು', 'ಬುಕ್', 'পেমেন্ট', 'পাঠান', 'বুক', 'पाठवा', 'पैसे भरा',
    // icon-only send / submit glyphs
    '➤', '➢', '➣', '⮞',
  ],
  secret_entry: 'approval_required',
  submit: 'approval_required',
  approval_timeout_s: 90,
  approval_auth: process.platform === 'darwin' ? 'device_owner' : 'none',
  version: 'default',
  rules: [],
  dry_run: false,
};

export function loadPolicy(): PolicyConfig {
  const p = process.env.MOBIUS_POLICY;
  if (!p) return DEFAULT_POLICY;
  return { ...DEFAULT_POLICY, ...(JSON.parse(readFileSync(p, 'utf8')) as Partial<PolicyConfig>) };
}

export interface PolicyContext {
  tool: string;
  app: string | null;
  target: Element | null;
  /** True when the action changes state (tap/type/press...); observe/wait are read-only. */
  mutating: boolean;
  secretField?: boolean;
  submit?: boolean;
  url?: string;
  /** App being opened (open_app). */
  targetApp?: string;
  /** Tap given as x,y rather than an element id. */
  coordinate?: boolean;
  /** Back / home / recents: always allowed, even inside a blocked app, so the agent can leave. */
  nav?: boolean;
  /** A sideways scroll: the same finger motion as a "slide to pay" swipe. */
  horizontal?: boolean;
  /** Everything on the current screen, for context rules (checkout screens raise risk). */
  screen?: Element[];
  /** Every element under the tap point (an overlay may sit on top of the real button). */
  under?: Element[];
}

// Look-alike letters (Greek / Cyrillic) that spoof Latin words, mapped back; invisible characters removed.
const CONFUSABLE: Record<string, string> = Object.fromEntries([
  ...'АаВЕеКкМНОоРрСсТуХхІіЈјЅѕԁ'.split('').map((c, i) => [c, 'AaBEeKkMHOoPpCcTyXxIiJjSsd'[i]!]),
  ...'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧοραν'.split('').map((c, i) => [c, 'ABEZHIKMNOPTYXopav'[i]!]),
]);
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;
/** What a person would read: NFKC, invisible characters dropped, look-alikes mapped to Latin. */
export const readable = (s: string) => s.normalize('NFKC').replace(INVISIBLE, '').replace(/[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F]/g, c => CONFUSABLE[c] ?? c);
/**
 * App-declared sensitive actions (the Mobius declaration convention): the app tags a control's identifier
 *   mobius:<class>[:<amount>[:<CURRENCY>]]   e.g. Flutter Semantics(identifier: 'mobius:payment:438:INR'), iOS accessibilityIdentifier
 *   mobius_<class>[_<amount>[_<CURRENCY>]]   e.g. Android resource id com.shop:id/mobius_payment_438_INR
 * A declaration is authoritative: it outranks the visible label (which an app or attacker may word any way).
 */
const DECLARED = /(?:^|[^a-z])mobius[:_](payment|booking|send|delete|account|install|secret)(?:[:_](\d+(?:\.\d+)?))?(?:[:_]([a-z]{3}))?(?![a-z])/i;
export interface Declaration { action_class: ActionClass; amount: number | null; currency: string | null }
export function declaredAction(e: Element | null | undefined): Declaration | null {
  const m = e ? DECLARED.exec(`${e.resource_id ?? ''} ${e.label ?? ''}`) : null;
  return m ? { action_class: m[1]!.toLowerCase() as ActionClass, amount: m[2] ? Number(m[2]) : null, currency: m[3]?.toUpperCase() ?? null } : null;
}

/** Generic "go ahead" buttons: harmless on most screens, a commit on a checkout screen. */
const PROCEED = /^\s*(continue|proceed|next|done|ok|okay|submit|confirm|complete|finish|go|place|जारी रखें|आगे बढ़ें)\b/i;
const AMOUNT = /(₹|rs\.?|inr|\$|€|£)\s?\d/i;
/** "Slide to <verb>" controls that only move around the app (tabs, toggles, galleries). Any other verb is a possible commit. */
const NAV_SLIDER = /^(switch|change|toggle|view|see|explore|browse|navigate|scroll|zoom|refresh|dismiss|close|cancel|next|previous|more)$/i;

/** What kind of consequence an action has; shown in approvals and audit. */
export type ActionClass = 'payment' | 'booking' | 'send' | 'delete' | 'account' | 'install' | 'permission' | 'secret' | 'unknown';
const CLASSES: [ActionClass, RegExp][] = [
  ['payment', /pay|payment|buy|purchase|checkout|order|transfer|withdraw|donate|subscribe|भुगतान|पेमेंट|ऑर्डर|खरीद|செலுத்து|చెల్లించు|ಪಾವತಿ|পেমেন্ট|पैसे/i],
  ['booking', /book|request|ride|ticket|seat|बुक|బుక్|ಬುಕ್|বুক|பதிவு/i],
  ['send', /send|share|post|publish|submit|भेज|अनुप्|அனுப்பு|పంపు|ಕಳುಹಿಸು|পাঠান|पाठवा|➤|➢|➣|⮞/i],
  ['delete', /delete|remove|erase|reset|cancel|हटा/i],
  ['account', /sign out|log out|unsubscribe|agree|accept|confirm|पुष्टि/i],
  ['install', /install/i],
];
export const classify = (words: string): ActionClass => CLASSES.find(([, re]) => re.test(words))?.[0] ?? 'unknown';

/** A screen that shows money due (₹349, Total, To pay...) makes unidentifiable targets risky. */
const MONEY = /(₹|rs\.?|inr|\$|€|£)\s?\d/i;
const DUE = /\b(total|to pay|amount|grand total|payable|fare|subtotal)\b|कुल|देय/i;
/** The amount a commit involves: from the target's own text ("Pay ₹438"), else the screen's Total/To-pay line. */
export function amountInvolved(target: Element | null, screen: Element[] | undefined): number | null {
  const num = (s: string) => { const m = s.match(/(?:₹|rs\.?|inr|\$|€|£)\s?([\d,]+(?:\.\d+)?)/i); return m ? Number(m[1]!.replace(/,/g, '')) : null; };
  const own = target ? num(`${target.text ?? ''} ${target.label ?? ''}`) : null;
  if (own !== null) return own;
  const lines = (screen ?? []).map(e => `${e.text ?? ''} ${e.label ?? ''}`);
  for (let i = 0; i < lines.length; i++) {
    if (!DUE.test(lines[i]!)) continue;
    const v = num(lines[i]!) ?? num(lines[i + 1] ?? ''); // "Total ₹438" or "Total" then "₹438"
    if (v !== null) return v;
  }
  return null;
}

export function moneyOnScreen(screen: Element[] | undefined): boolean {
  if (!screen) return false;
  const text = screen.map(e => `${e.text ?? ''} ${e.label ?? ''}`).join(' \n ');
  return MONEY.test(text) && DUE.test(text);
}

// OS permission sheets (iOS springboard, Android permission controller): granting is a privacy decision.
const PERMISSION_HOST = /springboard|permissioncontroller|packageinstaller/i;
const PERMISSION_GRANT = /^\s*(allow|while using|only this time)\b/i;

const wordRe = (words: string[]) => new RegExp(`(^|[^a-z])(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([^a-z]|$)`, 'i');
/** App patterns anchor to the start of a bundle/package segment. */
const appRe = (pats: string[]) => pats.length ? new RegExp(`(^|\\.)(${pats.join('|')})`, 'i') : null;

export interface Verdict {
  decision: Decision;
  reason: string;
  action_class: ActionClass;
  /** Which rule decided: "builtin.*" or a policy-as-code rule id. */
  rule_id: string;
  amount?: number | null;
  dry_run?: boolean;
}

export class Policy {
  readonly config: PolicyConfig;
  private blocked: RegExp | null;
  private approvalApps: RegExp | null;
  private risky: RegExp;

  constructor(config: PolicyConfig = loadPolicy()) {
    this.config = config;
    this.blocked = appRe(config.blocked_apps);
    this.approvalApps = appRe(config.approval_apps);
    this.risky = wordRe(config.risky_words);
  }

  appBlocked(app: string | null): boolean { return !!app && !!this.blocked?.test(app); }

  /** Built-in layers, then the user's rules (policy as code), then dry-run. */
  evaluate(ctx: PolicyContext): Verdict {
    const base = this.builtin(ctx);
    const t = ctx.target;
    const words = t ? `${t.text ?? ''} ${t.label ?? ''} ${t.resource_id ?? ''}` : '';
    const cls = base.action_class !== 'unknown' ? base.action_class : classify(words);
    const decl = declaredAction(t) ?? (ctx.under ?? []).map(declaredAction).find(Boolean) ?? null;
    const amount = decl?.amount ?? amountInvolved(t, ctx.screen);
    let v: Verdict = { ...base, action_class: cls, rule_id: base.rule_id, amount };
    if (base.decision !== 'blocked' && ctx.mutating) {
      // A ceiling rule ("allow payments up to ₹200") is checked against the largest amount on screen too: a label
      // saying "Pay ₹1" must not unlock a ₹50,000 checkout.
      const shown = (ctx.screen ?? []).flatMap(e => [...`${e.text ?? ''} ${e.label ?? ''}`.matchAll(/(?:₹|rs\.?|inr|\$|€|£)\s?([\d,]+(?:\.\d+)?)/gi)].map(m => Number(m[1]!.replace(/,/g, ''))));
      const ceiling = amount === null ? null : Math.max(amount, ...shown);
      const r = this.config.rules.find(r =>
        (!r.app || appRe([r.app])!.test(ctx.app ?? '')) && (!r.tool || r.tool.includes(ctx.tool))
        && (!r.action_class || r.action_class.includes(cls)) && (!r.target || new RegExp(r.target, 'i').test(words))
        && (r.max_amount === undefined || (ceiling !== null && ceiling <= r.max_amount)));
      if (r) v = { ...v, decision: r.effect, reason: `rule ${r.id}${r.description ? `: ${r.description}` : ''} (was: ${base.reason})`, rule_id: r.id };
    }
    if (this.config.dry_run && v.decision === 'approval_required') v = { ...v, decision: 'allow', reason: `dry run, would ask: ${v.reason}`, dry_run: true };
    return v;
  }

  private builtin(ctx: PolicyContext): Verdict {
    const out = (decision: Decision, reason: string, action_class: ActionClass = 'unknown', rule_id = `builtin.${decision}`): Verdict => ({ decision, reason, action_class, rule_id });
    if (this.appBlocked(ctx.targetApp ?? null)) return out('blocked', `${ctx.targetApp} is in a blocked app category (finance/credentials)`);
    if (ctx.nav) return out('allow', 'navigation key');
    if (this.appBlocked(ctx.app)) return out('blocked', `${ctx.app} is in a blocked app category (finance/credentials)`);
    if (!ctx.mutating) return out('allow', 'read-only');
    if (ctx.url && /^(intent|file|content|javascript|data):/i.test(ctx.url)) return out('blocked', 'URL scheme not allowed');
    // Anything but a web page jumps into another app (UPI, phone, SMS, store install, deep links): a human decides.
    if (ctx.url && !/^https?:/i.test(ctx.url)) {
      const scheme = ctx.url.split(':')[0]!.toLowerCase();
      const cls: ActionClass = /upi|pay|tez|phonepe|paytm/.test(scheme) ? 'payment' : /tel|sms|mms|mailto|whatsapp/.test(scheme) ? 'send' : /market|itms/.test(scheme) ? 'install' : 'unknown';
      return out('approval_required', `opens a ${scheme}: link outside the browser`, cls);
    }
    if (ctx.secretField) return out(this.config.secret_entry, 'typing into a password/PIN/OTP field', 'secret');
    const t = ctx.target;
    // camelCase ids split into words: btnPayNow, placeOrderButton.
    // A developer id backs up what the user sees. When the control has a readable label, generic verbs in its id
    // ("CUSTOMIZATION_CONFIRM_BUTTON" behind "Add Item", Swiggy live run) don't make it a commit; strong ones (pay,
    // order, buy, book) still do, and an unlabeled control is judged by its id alone.
    const idWords = (e: Element) => {
      const id = (e.resource_id ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.:/-]/g, ' ');
      return e.text || e.label ? id.replace(/\b(confirm|submit|agree|accept|request|reset|post|share)\b/gi, ' ') : id;
    };
    const wordsOf = (e: Element) => readable(`${e.text ?? ''} ${e.label ?? ''}`).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ') + ' ' + idWords(e);
    const words = t ? wordsOf(t) : '';
    const gesture = ctx.tool === 'tap' || ctx.tool === 'swipe' || ctx.tool === 'scroll';
    // Layer 0: the app itself declared this control sensitive. Trust the app over any label.
    if (gesture) {
      for (const e of [...(t ? [t] : []), ...(ctx.under ?? [])]) {
        const d = declaredAction(e);
        if (d) return out('approval_required', `the app declares this control a ${d.action_class} action${d.amount !== null ? ` of ${d.currency ?? ''} ${d.amount}`.replace('  ', ' ') : ''}`, d.action_class, 'app.declared');
      }
    }
    // Layer 1: the target, or anything under the tap point (overlays), says it commits: any language, icon glyphs,
    // look-alike letters, or a word split across child views ("P · ay"). Swipes count: "Slide to pay".
    if (gesture) {
      for (const e of [...(t ? [t] : []), ...(ctx.under ?? [])]) {
        const w = wordsOf(e);
        const hit = this.risky.exec(w) ?? this.risky.exec(w.replace(/\s*·\s*/g, ''));
        if (hit) return out('approval_required', `${e === t ? 'target' : 'element under the tap'} "${(e.text ?? e.label ?? e.resource_id ?? '').slice(0, 60)}" looks consequential ("${hit[2]}")`, classify(hit[2]!));
      }
      // Checkout screen: a generic "Continue" or a button that only shows an amount is the commit.
      if (t && ctx.tool === 'tap' && moneyOnScreen(ctx.screen) && (PROCEED.test(words) || AMOUNT.test(words))) {
        return out('approval_required', `"${words.trim().slice(0, 40)}" on a screen showing an amount due`, 'payment');
      }
    }
    // App lifecycle: wiping or removing an app loses the user's data; installing adds code.
    if (ctx.tool === 'uninstall_app' || ctx.tool === 'clear_app_data') return out('approval_required', `${ctx.tool === 'uninstall_app' ? 'uninstalling' : 'clearing all data of'} ${ctx.targetApp ?? 'an app'}`, 'delete');
    if (ctx.tool === 'install_app') return out('approval_required', 'installing an app', 'install');
    // Driver powers that act, authenticate or capture beyond what the screen shows: a human decides.
    const POWER: Record<string, [string, ActionClass]> = {
      webview_eval: ['running JavaScript inside a web page (it can submit forms or pay)', 'payment'],
      simulate_biometric: ['simulating a fingerprint / Face ID match (authenticates as the user)', 'account'],
      push_file: ['writing a file onto the device', 'install'],
      device_setting_write: ['changing a system setting', 'account'],
      set_permission: ['changing an app permission', 'permission'],
      start_screen_recording: ['recording the screen (video cannot be masked)', 'secret'],
      record_flow_start: ["recording the user's own taps (it can capture a PIN or unlock pattern)", 'secret'],
      reboot_device: ['rebooting the device', 'unknown'],
    };
    const power = POWER[ctx.tool];
    if (power) return out('approval_required', power[0], power[1]);
    // Layer 2: OS permission sheets.
    if (ctx.tool === 'tap' && PERMISSION_HOST.test(ctx.app ?? '') && PERMISSION_GRANT.test(words)) {
      return out('approval_required', `granting an OS permission ("${words.trim().slice(0, 40)}")`, 'permission');
    }
    // Layer 3: fail safe on targets Mobius can't read. A commit button drawn without accessibility is invisible to layer 1.
    // ponytail: x,y anywhere and unlabeled elements on money screens ask; upgrade path is OCR/vision on the tapped region.
    if (ctx.tool === 'tap' && !words.trim() && (ctx.coordinate || moneyOnScreen(ctx.screen))) {
      return out('approval_required', ctx.coordinate
        ? 'tap at coordinates on something Mobius cannot identify (could be a hidden Pay/Book button)'
        : 'unlabeled control on a screen showing an amount due (could be a hidden Pay button)', 'payment');
    }
    // Layer 4: a swipe on a screen that offers "slide to …" commits. Sliders that only navigate ("Slide to switch" gender
    // toggle on Slikk, live run) don't count; any other verb, or none we can read, still asks (fail closed).
    if ((ctx.tool === 'swipe' || (ctx.tool === 'scroll' && ctx.horizontal)) && ctx.screen?.some(e => { const m = /\b(?:slide|swipe) to\b\s*(\p{L}*)/iu.exec(wordsOf(e)); return !!m && !NAV_SLIDER.test(m[1]!); })) {
      return out('approval_required', 'swipe on a screen with a "slide to …" control (swipe-to-pay/book)', 'payment');
    }
    if (ctx.submit) return out(this.config.submit, 'submitting text (may send a message or form)', 'send');
    if (ctx.app && this.approvalApps?.test(ctx.app) && (ctx.tool === 'type' || ctx.tool === 'tap' || ctx.tool === 'swipe')) {
      return out('approval_required', `${ctx.app} is a sensitive app (messaging, social or finance)`, classify(words));
    }
    return out('allow', 'no rule matched');
  }
}

export interface ApprovalRequest {
  id: string;
  device_id: string;
  app: string | null;
  tool: string;
  /** Composed from device state, never from agent-supplied text. */
  summary: string;
  reason: string;
  action_class?: ActionClass;
  /** From the device connector: an emulator/simulator. */
  virtual_device?: boolean;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'expired';

/** Asks a human. Implementations must not be satisfiable by the agent itself. */
export interface Approver {
  request(req: ApprovalRequest, timeoutS: number): Promise<ApprovalOutcome>;
}

// Device-owner check (Touch ID or login password) via LocalAuthentication. An agent with a shell can script a click on
// "Approve" (System Events), but it cannot present the owner's fingerprint or password.
const AUTH_SWIFT = `import LocalAuthentication
import Foundation
let reason = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "approve an AI agent action"
let ctx = LAContext()
var err: NSError?
guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { exit(2) }
let sem = DispatchSemaphore(value: 0)
var ok = false
ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in ok = success; sem.signal() }
sem.wait()
exit(ok ? 0 : 1)
`;
let authBin: Promise<string | null> | null = null;
/** Compile the helper once into ~/.mobius/bin (needs Xcode command-line tools). null = unavailable. */
function deviceOwnerHelper(): Promise<string | null> {
  return authBin ??= (async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const dir = `${homedir()}/.mobius/bin`, bin = `${dir}/mobius-owner-auth`;
    if (existsSync(bin)) return bin;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/owner-auth.swift`, AUTH_SWIFT);
    return new Promise(res => execFile('swiftc', ['-O', '-o', bin, `${dir}/owner-auth.swift`], { timeout: 120_000 }, e => res(e ? null : bin)));
  })();
}
export async function confirmDeviceOwner(reason: string): Promise<boolean> {
  const bin = await deviceOwnerHelper();
  if (!bin) {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'device-owner check unavailable (install Xcode command-line tools, or set approval_auth "none")' }) + '\n');
    return false; // fail closed
  }
  return new Promise(res => execFile(bin, [reason], { timeout: 120_000 }, e => res(!e)));
}

/** Native macOS dialog on the user's screen, then (by default) Touch ID / password, so a scripted click can't approve. */
export class MacDialogApprover implements Approver {
  private readonly auth: PolicyConfig['approval_auth'];
  constructor(auth: PolicyConfig['approval_auth'] = DEFAULT_POLICY.approval_auth) { this.auth = auth; }
  async request(req: ApprovalRequest, timeoutS: number): Promise<ApprovalOutcome> {
    const clicked = await this.dialog(req, timeoutS);
    if (clicked !== 'approved' || this.auth === 'none') return clicked;
    return (await confirmDeviceOwner(`approve: ${req.summary.slice(0, 120)}`)) ? 'approved' : 'rejected';
  }
  private dialog(req: ApprovalRequest, timeoutS: number): Promise<ApprovalOutcome> {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const kind = req.action_class && req.action_class !== 'unknown' ? ` (${req.action_class})` : '';
    const msg = `An AI agent wants to act on your phone${kind}.\n\nApp: ${req.app ?? 'unknown'}\nAction: ${req.summary}\nWhy approval: ${req.reason}\n\nDevice: ${req.device_id}`;
    const script = `display dialog "${esc(msg)}" with title "Mobius approval" buttons {"Reject", "Approve"} default button "Reject" cancel button "Reject" with icon caution giving up after ${timeoutS}`;
    return new Promise(resolve => {
      execFile('osascript', ['-e', script], { timeout: (timeoutS + 5) * 1000 }, (err, stdout) => {
        if (err) return resolve('rejected'); // Reject button or failure: fail closed
        if (/gave up:true/.test(stdout)) return resolve('expired');
        resolve(/button returned:Approve/.test(stdout) ? 'approved' : 'rejected');
      });
    });
  }
}

/** Emulators and simulators only: physical phones hold real accounts and money. */
export const isVirtualDevice = (id: string) => /^emulator-\d+$/.test(id) || /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(id);

/**
 * Tests only: fixed answer from MOBIUS_TEST_APPROVAL. Never enabled implicitly.
 * An auto-"approved" never reaches a physical device: an agent that edits its own MCP config can't turn it into a bypass.
 */
export class FixedApprover implements Approver {
  private readonly answer: ApprovalOutcome;
  private readonly anyDevice: boolean;
  readonly requests: ApprovalRequest[] = [];
  constructor(answer: ApprovalOutcome, opts: { anyDevice?: boolean } = {}) { this.answer = answer; this.anyDevice = !!opts.anyDevice; }
  async request(req: ApprovalRequest) {
    this.requests.push(req);
    const virtual = req.virtual_device ?? isVirtualDevice(req.device_id);
    if (this.answer === 'approved' && !this.anyDevice && !virtual) return 'rejected';
    return this.answer;
  }
}

/**
 * Remote approver: POSTs the request to a webhook (your Slack bot, push service or backend) and waits for its answer.
 * The decision lives off this machine, so an agent with a local shell can't click it. Fail closed on any error.
 * Request body: ApprovalRequest + timeout_s. Response: {"decision":"approved"|"rejected"} (anything else = rejected).
 */
export class WebhookApprover implements Approver {
  private readonly url: string;
  private readonly token: string | undefined;
  constructor(url: string, token?: string) { this.url = url; this.token = token; }
  async request(req: ApprovalRequest, timeoutS: number): Promise<ApprovalOutcome> {
    try {
      const r = await fetch(this.url, {
        method: 'POST', signal: AbortSignal.timeout(timeoutS * 1000),
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ ...req, timeout_s: timeoutS }),
      });
      if (!r.ok) return 'rejected';
      const d = ((await r.json()) as { decision?: string }).decision;
      return d === 'approved' ? 'approved' : d === 'expired' ? 'expired' : 'rejected';
    } catch (e) {
      return (e as Error).name === 'TimeoutError' ? 'expired' : 'rejected';
    }
  }
}

/** No human channel available: fail closed. */
export class DenyApprover implements Approver {
  async request() { return 'rejected' as const; }
}

export function defaultApprover(): Approver {
  const fixed = process.env.MOBIUS_TEST_APPROVAL;
  if (fixed === 'approved' || fixed === 'rejected' || fixed === 'expired') return new FixedApprover(fixed);
  const hook = process.env.MOBIUS_APPROVAL_WEBHOOK;
  if (hook) return new WebhookApprover(hook, process.env.MOBIUS_APPROVAL_TOKEN);
  return process.platform === 'darwin' ? new MacDialogApprover(loadPolicy().approval_auth) : new DenyApprover();
}

export const newApprovalId = () => `apr_${randomUUID().slice(0, 8)}`;
