import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ActionResult, Element, Expect, Observation } from '../core/protocol.ts';
import type { AuditLog } from '../observability/audit.ts';
import { isRevoked, killSwitchPath, newPlaneContext, type PlaneContext } from '../infrastructure/plane.ts';
import { MobiusError, type Connector } from './connector.ts';
import { buildObservation, ObservationStore } from './observe.ts';
import { moneyOnScreen, newApprovalId, type Approver, type Policy, type PolicyContext, type Verdict } from '../policy/policy.ts';


/** Policy hook for one action. `targetId` is re-resolved after approval (screen may have changed). */
export interface Guard {
  ctx: Omit<PolicyContext, 'app' | 'target'>;
  targetId?: string | undefined;
  /** Coordinate actions: the point the finger lands on (resolved against the fresh screen). */
  point?: { x: number; y: number } | undefined;
  /** Human-readable action built from DEVICE state (element text), never from agent prose. */
  describe: (target: Element | null) => string;
}

export const DEFAULT_ACTION_TIMEOUT_MS = 20_000;
export const DEFAULT_EXPECT_TIMEOUT_MS = 6_000;
/** Cold app launches (Flutter/RN on iOS) take longer than a tap to show; live run: Scapia was still on SpringBoard at 6 s. */
export const LAUNCH_EXPECT_TIMEOUT_MS = 20_000;
/** Pause between re-reads while waiting for the screen. */
const POLL_MS = 100;

/** Text read from pixels, as an element the policy can judge like any label. */
const drawnText = (text: string, bounds: Element['bounds']): Element => ({ id: 'drawn', role: 'text', text, label: null, resource_id: null,
  clickable: false, long_clickable: false, enabled: true, focused: false, scrollable: false, editable: false, checked: null, selected: false,
  sensitive: false, bounds, dup_index: 0 });

/** Where to touch an element: the center of its on-screen part (an element partly above/left of the screen has negative
 *  bounds; its raw center can be off-screen). Given the screen, a point not covered by a smaller clickable element inside
 *  it: tapping a big card's center must not hit the item drawn there (live run: Swiggy's restaurant card opened a burger). */
export const center = (e: Element, screen?: readonly Element[]) => {
  const x1 = Math.max(e.bounds.x, 0), y1 = Math.max(e.bounds.y, 0);
  const x2 = Math.max(e.bounds.x + e.bounds.width, x1), y2 = Math.max(e.bounds.y + e.bounds.height, y1);
  const mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  if (!screen) return mid;
  const inside = (o: Element) => o.bounds.x >= e.bounds.x && o.bounds.y >= e.bounds.y && o.bounds.x + o.bounds.width <= e.bounds.x + e.bounds.width
    && o.bounds.y + o.bounds.height <= e.bounds.y + e.bounds.height && o.bounds.width * o.bounds.height < e.bounds.width * e.bounds.height;
  const kids = screen.filter(o => o !== e && o.id !== e.id && (o.clickable || o.editable) && inside(o));
  if (!kids.length) return mid;
  const hit = (p: { x: number; y: number }) => kids.some(k => p.x >= k.bounds.x && p.x <= k.bounds.x + k.bounds.width && p.y >= k.bounds.y && p.y <= k.bounds.y + k.bounds.height);
  const at = (fx: number, fy: number) => ({ x: x1 + (x2 - x1) * fx, y: y1 + (y2 - y1) * fy });
  for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.12], [0.12, 0.5], [0.88, 0.5], [0.5, 0.88], [0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88], [0.3, 0.12], [0.7, 0.12]] as const) {
    const p = at(fx, fy);
    if (!hit(p)) return p;
  }
  return mid; // fully covered: the children are the target in practice
};

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new MobiusError('OUTCOME_UNKNOWN', `${what} did not finish within ${ms} ms`, {
        hint: 'The action may or may not have happened. Call observe before retrying.',
      })), ms);
    }),
  ]);
}

export function expectationMet(obs: Observation, ex: Expect): boolean {
  const has = (t: string) => obs.elements.some(e => (e.text ?? '').includes(t) || (e.label ?? '').includes(t));
  if (ex.text_visible !== undefined && !has(ex.text_visible)) return false;
  if (ex.app !== undefined && obs.foreground_app !== ex.app) return false;
  if (ex.element_gone !== undefined && obs.elements.some(e => e.id === ex.element_gone)) return false;
  return true;
}

/** One device: observation history + serialized action pipeline. */
export class DeviceSession {
  readonly connector: Connector;
  readonly store: ObservationStore;
  private readonly audit: AuditLog;
  private readonly policy: Policy;
  private readonly approver: Approver;
  private queue: Promise<unknown> = Promise.resolve();
  private recent: { key: string; changed: boolean | null }[] = [];
  private readonly plane: PlaneContext;
  private verdict: Verdict | null = null;

  constructor(connector: Connector, audit: AuditLog, policy: Policy, approver: Approver, plane: PlaneContext = newPlaneContext(), persistIds = false) {
    this.store = new ObservationStore(persistIds ? connector.deviceId : undefined);
    this.connector = connector;
    this.plane = plane;
    this.audit = audit;
    this.policy = policy;
    this.approver = approver;
  }

  isBlockedApp(app: string | null) { return this.policy.appBlocked(app); }

  /** Policy + approval gate. Returns the (re-resolved) target to act on. Throws MobiusError to stop. */
  private async gate(tool: string, guard: Guard): Promise<Element | null> {
    // Time of check = time of use: the app may have changed the screen since the agent read it ("Add to cart" becomes
    // "Pay ₹999"). Re-read now and decide on what the finger will actually hit. A changed target is refused as stale.
    if (guard.ctx.mutating && (guard.targetId || guard.point)) await this.observe();
    const latest = this.store.latest();
    let target = guard.targetId ? this.store.resolve(guard.targetId) : guard.point ? this.elementAt(guard.point.x, guard.point.y) : null;
    const p = guard.point ?? (target ? center(target, latest?.elements) : null);
    const under = p ? this.elementsAt(p.x, p.y) : [];
    // Pixels, not just labels: on a screen showing an amount due, read the text actually drawn where the finger lands
    // (OCR), so a Pay button can't hide behind an accessibility label that says "Close".
    if (guard.ctx.mutating && p && this.connector.extra && moneyOnScreen(latest?.elements)) {
      const drawn = await this.connector.extra('ocr', {}).catch(() => null);
      const b = target?.bounds;
      for (const t of drawn?.text ?? []) {
        const [x = 0, y = 0, w = 0, h = 0] = (t.box ?? []) as number[];
        const cx = x + w / 2, cy = y + h / 2;
        const hit = b ? cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height
          : p.x >= x - 16 && p.x <= x + w + 16 && p.y >= y - 16 && p.y <= y + h + 16;
        if (hit && t.text) under.push(drawnText(String(t.text), { x, y, width: w, height: h }));
      }
    }
    if (guard.ctx.mutating) {
      if (existsSync(killSwitchPath())) throw new MobiusError('POLICY_BLOCKED', 'Kill switch engaged: all agent actions are stopped', { hint: 'A human ran `mobius stop`. Stop and tell the user.' });
      const pl = this.plane;
      if (pl.actions >= pl.max_actions) throw new MobiusError('POLICY_BLOCKED', `Action quota reached (${pl.max_actions} per session)`, { hint: 'Stop and report progress to the user.' });
      const ses = pl.session();
      if (ses && 'invalid' in ses) throw new MobiusError('POLICY_BLOCKED', `Agent session token rejected: ${ses.invalid}`, { hint: 'Ask the operator for a fresh session token.' });
      if (!ses && pl.require_session) throw new MobiusError('POLICY_BLOCKED', 'This Mobius requires a signed agent session', { hint: 'Ask the operator for a session token (mobius session issue).' });
      if (ses && isRevoked(ses.jti)) throw new MobiusError('POLICY_BLOCKED', 'Agent session revoked by the operator', { hint: 'Stop and tell the user.' });
      if (ses && ses.exp <= Date.now() / 1000) throw new MobiusError('POLICY_BLOCKED', 'Agent session expired', { hint: 'Ask the operator for a fresh session token.' });
      if (ses?.policy_version && ses.policy_version !== this.policy.config.version) {
        throw new MobiusError('POLICY_BLOCKED', `Session was issued for policy ${ses.policy_version}, but Mobius runs ${this.policy.config.version}`, { hint: 'The operator must re-issue the session for the current policy.' });
      }
      if (pl.max_minutes && Date.now() - pl.started > pl.max_minutes * 60_000) throw new MobiusError('POLICY_BLOCKED', `Session time limit reached (${pl.max_minutes} min)`, { hint: 'Stop and report progress to the user.' });
    }
    const v = this.policy.evaluate({ ...guard.ctx, tool, app: latest?.foreground_app ?? null, target, screen: latest?.elements, under });
    this.verdict = v;
    const { decision, reason, action_class } = v;
    if (decision === 'blocked') throw new MobiusError('POLICY_BLOCKED', `Blocked by policy: ${reason}`, { hint: 'Ask the user to do this step themselves.' });
    if (decision === 'allow') return target;
    const req = { id: newApprovalId(), device_id: this.connector.deviceId, app: latest?.foreground_app ?? null, tool, summary: guard.describe(target), reason, action_class, virtual_device: this.connector.virtual };
    const outcome = await this.approver.request(req, this.policy.config.approval_timeout_s);
    if (outcome === 'rejected') throw new MobiusError('APPROVAL_REJECTED', `User rejected: ${req.summary}`, { hint: 'Do not retry. Ask the user what they want instead.' });
    if (outcome === 'expired') throw new MobiusError('APPROVAL_EXPIRED', `No decision within ${this.policy.config.approval_timeout_s}s: ${req.summary}`, { retryable: true });
    // Time passed while the human decided: confirm the approved target is still the one on screen.
    if (guard.targetId) {
      await this.observe();
      target = this.store.resolve(guard.targetId);
      if (guard.describe(target) !== req.summary) {
        throw new MobiusError('STALE_ELEMENT', 'Screen changed after approval; the approved target is no longer the same', { retryable: true, hint: 'Observe again; a new approval will be requested.' });
      }
    }
    return target;
  }

  /** Serialize work per device: one action at a time, no interleaved taps. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async observe(): Promise<Observation> {
    const screen = await this.connector.dump();
    const fw = screen.foregroundApp ? await this.connector.framework(screen.foregroundApp) : 'unknown';
    const { obs, fps } = buildObservation(screen, this.connector.deviceId, this.connector.platform, this.store.nextId(), fw);
    this.store.add(obs, fps);
    return obs;
  }

  /** Re-observe until two consecutive screens hash the same (UI settled), bounded. State-based, no fixed sleeps. */
  private async settle(deadline: number): Promise<Observation> {
    let prev = await this.observe();
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const next = await this.observe();
      if (next.screen_hash === prev.screen_hash) return next;
      prev = next;
    }
    return prev;
  }

  /** Every element containing the point on the latest screen (overlays, the button below them, its labels). */
  elementsAt(x: number, y: number): Element[] {
    return (this.store.latest()?.elements ?? []).filter(e => x >= e.bounds.x && x <= e.bounds.x + e.bounds.width && y >= e.bounds.y && y <= e.bounds.y + e.bounds.height);
  }

  /** Smallest clickable/editable element containing the point on the latest screen. */
  elementAt(x: number, y: number): Element | null {
    const hits = (this.store.latest()?.elements ?? []).filter(e => (e.clickable || e.editable || e.long_clickable)
      && x >= e.bounds.x && x <= e.bounds.x + e.bounds.width && y >= e.bounds.y && y <= e.bounds.y + e.bounds.height);
    return hits.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height)[0] ?? null;
  }

  /** After tapping a field: wait (state-based, ≤2.5 s) until an editable element at that point has focus. */
  async waitForFocus(x: number, y: number) {
    const until = Date.now() + 2_500;
    while (Date.now() < until) {
      const o = await this.observe();
      const f = o.elements.find(e => e.editable && e.focused && x >= e.bounds.x && x <= e.bounds.x + e.bounds.width && y >= e.bounds.y && y <= e.bounds.y + e.bounds.height);
      if (f) return;
    }
  }

  focusedField(): Element | null {
    return this.store.latest()?.elements.find(e => e.editable && e.focused) ?? null;
  }

  resolveTarget(element_id: string | undefined, x: number | undefined, y: number | undefined) {
    if (element_id) {
      const el = this.store.resolve(element_id);
      if (!el.enabled) throw new MobiusError('ELEMENT_NOT_FOUND', `${element_id} is disabled`, { hint: 'Wait for it to enable or pick another element.' });
      return { ...center(el, this.store.latest()?.elements), el };
    }
    if (x !== undefined && y !== undefined) {
      const s = this.store.latest()?.screen;
      if (s && s.width && (x < 0 || y < 0 || x > s.width || y > s.height)) {
        throw new MobiusError('INVALID_INPUT', `(${x}, ${y}) is outside the ${s.width}x${s.height} screen`);
      }
      return { x, y, el: null };
    }
    throw new MobiusError('INVALID_INPUT', 'Give element_id, or both x and y');
  }

  /**
   * The single action pipeline: execute → settle → verify `expect` → audit.
   * Never retries: the agent decides after seeing the fresh observation.
   */
  run(
    tool: string,
    auditParams: Record<string, unknown>,
    exec: (target: Element | null) => Promise<string>,
    opts: { expect?: Expect | undefined; timeoutMs?: number | undefined; guard?: Guard; verifyMs?: number;
      /** Built-in post-condition (e.g. typed text landed); combined with `expect`. Returns a failure reason or null. */
      check?: (obs: Observation) => string | null } = {},
  ): Promise<ActionResult> {
    return this.exclusive(async () => {
      const action_id = `act_${randomUUID().slice(0, 8)}`;
      const t0 = Date.now();
      let preHash = this.store.latest()?.screen_hash ?? null;
      const loopKey = `${tool}|${JSON.stringify(auditParams)}|${preHash}`;
      let result: ActionResult;
      try {
        // Loop guard: same action on the same unchanged screen 3 times in a row.
        const last2 = this.recent.slice(-2);
        if (last2.length === 2 && last2.every(r => r.key === loopKey && r.changed === false)) {
          throw new MobiusError('LOOP_DETECTED', `${tool} repeated 3x on an unchanged screen`, { hint: 'Change strategy: observe, scroll, take a screenshot, or ask the user.' });
        }
        this.verdict = null;
        const target = opts.guard ? await this.gate(tool, opts.guard) : null;
        if (opts.guard?.ctx.mutating) this.plane.actions++;
        preHash = this.store.latest()?.screen_hash ?? preHash;
        const message = await withTimeout(exec(target), opts.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, tool);
        const verifying = !!opts.expect || !!opts.check;
        const deadline = Date.now() + (verifying ? opts.verifyMs ?? DEFAULT_EXPECT_TIMEOUT_MS : 2_500);
        let obs = await this.settle(Math.min(deadline, Date.now() + 2_500));
        let verified: boolean | null = null;
        let why = '';
        const evaluate = (o: Observation) => {
          const bad = opts.check?.(o) ?? null;
          if (bad) { why = bad; return false; }
          if (opts.expect && !expectationMet(o, opts.expect)) { why = `expectation not met: ${JSON.stringify(opts.expect)}`; return false; }
          return true;
        };
        if (verifying) {
          verified = evaluate(obs);
          while (!verified && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, POLL_MS)); // yield: a fast device must not starve timers (and the CPU)
            obs = await this.observe();
            verified = evaluate(obs);
          }
        }
        result = {
          ok: verified !== false,
          action_id,
          status: verified === false ? 'failed' : 'succeeded',
          duration_ms: Date.now() - t0,
          state_changed: preHash === null ? null : preHash !== obs.screen_hash,
          foreground_app: obs.foreground_app,
          observation_id: obs.observation_id,
          verified,
          message: verified === false ? `${message}, but ${why}` : message,
        };
      } catch (e) {
        const err = e instanceof MobiusError ? e : new MobiusError('INTERNAL', (e as Error).message);
        result = {
          ok: false, action_id,
          status: err.code === 'OUTCOME_UNKNOWN' ? 'outcome_unknown'
            : ['POLICY_BLOCKED', 'APPROVAL_REJECTED', 'APPROVAL_EXPIRED'].includes(err.code) ? 'blocked' : 'failed',
          duration_ms: Date.now() - t0, state_changed: null, foreground_app: null, observation_id: null, verified: null,
          message: err.message,
          error: { code: err.code, message: err.message, retryable: err.retryable, ...(err.hint ? { hint: err.hint } : {}) },
        };
      }
      this.recent.push({ key: loopKey, changed: result.state_changed });
      if (this.recent.length > 10) this.recent.shift();
      try {
        this.audit.record({
          action_id, device_id: this.connector.deviceId, tool, params: auditParams, status: result.status,
          error_code: result.error?.code ?? null, duration_ms: result.duration_ms,
          agent: (() => { const ses = this.plane.session(); return ses && !('invalid' in ses) ? ses.sub : this.plane.agent(); })(),
          agent_session: (() => { const ses = this.plane.session(); return ses && !('invalid' in ses) ? ses.jti : null; })(),
          session_id: this.plane.session_id,
          decision: this.verdict?.decision ?? null, rule_id: this.verdict?.rule_id ?? null,
          action_class: this.verdict?.action_class ?? null, amount: this.verdict?.amount ?? null,
        });
      } catch (e) {
        process.stderr.write(JSON.stringify({ level: 'error', msg: 'audit write failed', err: String(e) }) + '\n');
      }
      return result;
    });
  }
}
