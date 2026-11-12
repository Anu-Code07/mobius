// Regression tests for the host safety review: each one fails on the code before its fix.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AttackDevice, btn, field, txt } from '../bench/break-mobius.ts';
import { AuditLog } from '../src/observability/audit.ts';
import { createServer } from '../src/interface/mcp.ts';
import { FixedApprover, Policy, DEFAULT_POLICY, type Approver, type ApprovalRequest } from '../src/policy/policy.ts';
import { Mobius } from '../src/infrastructure/registry.ts';
import { MobiusAgentDriver } from '../src/execution/drivers/mobiusagent.ts';

const R = (x: number, y: number, w = 400, h = 100) => ({ x, y, width: w, height: h });

/** AttackDevice plus driver ops: records every op that reached the "device". */
class OpsDevice extends AttackDevice {
  ops: string[] = [];
  slowTapMs = 0;
  tapLog: string[] = [];
  override async extra(op: string, args: Record<string, unknown> = {}): Promise<any> {
    if (op === 'ocr') return super.extra(op);
    this.ops.push(op);
    if (op === 'notifications') throw new Error('iOS does not let tools read other apps\' notifications');
    return { ok: true, args };
  }
  override async tap(x: number, y: number) {
    this.tapLog.push('start');
    if (this.slowTapMs) await new Promise(r => setTimeout(r, this.slowTapMs));
    await super.tap(x, y);
    this.tapLog.push('end');
  }
}

async function setup(device: OpsDevice, approver: Approver = new FixedApprover('rejected', { anyDevice: true })) {
  const audit = new AuditLog(':memory:');
  const mobius = new Mobius(async () => [device], audit, new Policy(), approver);
  const server = createServer(mobius);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: { ...(name.startsWith('mobius_') ? { device: device.deviceId } : { device_id: device.deviceId }), ...args } });
    const t = r.content.find((c: any) => c.type === 'text')?.text ?? '{}';
    return { ...JSON.parse(t), isError: !!r.isError };
  };
  return { call, mobius, audit };
}

/** Records approvals; optionally changes the world while the human decides. */
class Recorder implements Approver {
  requests: ApprovalRequest[] = [];
  private readonly answer: 'approved' | 'rejected';
  private readonly during: (() => void) | undefined;
  constructor(answer: 'approved' | 'rejected', during?: () => void) { this.answer = answer; this.during = during; }
  async request(req: ApprovalRequest) { this.requests.push(req); this.during?.(); return this.answer; }
}

const shop = () => new OpsDevice({ screen: () => [btn('Add to cart', R(0, 100)), field('Search', R(0, 300)), txt('Total ₹349', R(0, 500))] });

test('batch_commands validates each step like a direct call (no Enter or bad paths through the side door)', async () => {
  const d = shop();
  const { call } = await setup(d);
  const r = await call('mobius_batch_commands', { steps: [{ name: 'mobius_press_keys', arguments: { keys: 'enter' } }] });
  assert.equal(r.results[0].ok, false);
  assert.match(JSON.stringify(r.results[0].result), /APPROVAL_REJECTED/);
  assert.deepEqual(d.ops, [], 'Enter never reached the device');
  const bad = await call('mobius_batch_commands', { steps: [{ name: 'save_screenshot', arguments: { saveTo: '/tmp/x.txt' } }] });
  assert.match(JSON.stringify(bad), /INVALID_INPUT/);
});

test('press_keys: every spelling of Enter needs approval', async () => {
  const d = shop();
  const { call } = await setup(d);
  for (const keys of ['keycode_enter', 'KEYCODE_NUMPAD_ENTER', 'keycode_dpad_center', 'ctrl+return']) {
    const r = await call('mobius_press_keys', { keys });
    assert.equal(r.error?.code, 'APPROVAL_REJECTED', keys);
  }
  assert.deepEqual(d.ops, []);
  assert.equal((await call('mobius_press_keys', { keys: 'volume_up' })).isError, false, 'plain keys still work');
  assert.deepEqual(d.ops, ['keys']);
});

test('blocked apps: no tool reads their screen, logs or files; Back still works', async () => {
  const d = new OpsDevice({ app: 'com.example.netbanking', screen: () => [txt('Balance ₹2,40,000'), btn('Transfer', R(0, 300))] });
  const { call } = await setup(d);
  for (const [tool, args] of [
    ['mobius_snapshot', {}], ['mobius_read_screen_text', {}], ['mobius_accessibility_audit', {}], ['mobius_screen_diff', {}],
    ['mobius_assert_on_screen', { present: ['Balance'] }], ['mobius_scroll_until_visible', { text: 'Balance' }],
    ['mobius_wait_for', { text_visible: 'Balance', timeout_ms: 500 }], ['mobius_get_device_logs', {}], ['mobius_list_notifications', {}],
  ] as const) {
    const r = await call(tool, args);
    assert.equal(r.error?.code, 'POLICY_BLOCKED', tool);
    assert.doesNotMatch(JSON.stringify(r), /2,40,000/, tool);
  }
  d.app = 'com.fake.notes';
  assert.equal((await call('mobius_list_files', { packageName: 'com.hdfcbank.app' })).error?.code, 'POLICY_BLOCKED', 'app-scoped read of a blocked app');
  assert.deepEqual(d.ops, [], 'no driver read ever ran');
  d.app = 'com.example.netbanking';
  assert.equal((await call('press_key', { key: 'back' })).ok, true, 'the agent can always leave');
});

test('approvals name what they approve; the audit keeps URLs without their query', async () => {
  const d = shop();
  const rec = new Recorder('rejected');
  const { call, audit } = await setup(d, rec);
  await call('mobius_set_permission', { packageName: 'com.fake.notes', permission: 'CAMERA', grant: true });
  assert.match(rec.requests[0]!.summary, /com\.fake\.notes/);
  assert.match(rec.requests[0]!.summary, /CAMERA/);
  await call('mobius_webview_eval', { socket: 's', js: 'document.forms[0].submit()' });
  assert.match(rec.requests[1]!.summary, /forms\[0\]\.submit/);
  await call('open_url', { url: 'upi://pay?pa=attacker@upi&am=50000' });
  assert.match(rec.requests[2]!.summary, /pa=attacker@upi&am=50000/);
  const rows = JSON.stringify(audit.recent());
  assert.match(rows, /upi:\/\/pay/);
  assert.doesNotMatch(rows, /attacker/);
  assert.doesNotMatch(rows, /forms\[0\]/, 'scripts are not kept in the audit');
});

test('output files stay in the Mobius output folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mobius-out-'));
  process.env.MOBIUS_HOME = home;
  try {
    const d = shop();
    const { call } = await setup(d);
    for (const output of [join(home, 'revoked'), '../revoked', '/etc/hosts']) {
      const r = await call('mobius_pull_file', { path: '/sdcard/x', output });
      assert.equal(r.error?.code, 'POLICY_BLOCKED', output);
    }
    assert.deepEqual(d.ops, []);
    const ok = await call('mobius_pull_file', { path: '/sdcard/x', output: 'x.bin' });
    assert.equal(ok.args.output, join(home, 'outputs', 'x.bin'));
    writeFileSync(join(home, 'not-a-flow.json'), '{"steps":[]}');
    assert.equal((await call('mobius_replay_flow', { file: join(home, 'not-a-flow.json') })).error?.code, 'POLICY_BLOCKED', 'reads too');
  } finally { delete process.env.MOBIUS_HOME; rmSync(home, { recursive: true }); }
});

test('record_flow_start (captures the user\'s own touches) needs approval', async () => {
  const d = shop();
  const { call } = await setup(d);
  assert.equal((await call('mobius_record_flow_start')).error?.code, 'APPROVAL_REJECTED');
  assert.deepEqual(d.ops, []);
});

test('after approval: kill switch re-checked, and a coordinate tap is re-validated against the screen', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mobius-ks2-'));
  process.env.MOBIUS_HOME = home;
  try {
    // The operator hits `mobius stop` while the approval dialog is open.
    const d1 = new OpsDevice({ screen: () => [btn('Pay ₹499', R(0, 100))], commitRects: () => [R(0, 100)] });
    const { call: c1 } = await setup(d1, new Recorder('approved', () => writeFileSync(join(home, 'STOP'), 'now')));
    await c1('observe');
    const r1 = await c1('tap', { x: 100, y: 150 });
    assert.match(r1.message, /Kill switch/);
    assert.deepEqual(d1.commits, []);
    rmSync(join(home, 'STOP'));
    // The app swaps the button under the approved point while the human decides.
    let swapped = false;
    const d2 = new OpsDevice({ screen: () => [btn(swapped ? 'Send ₹49,999' : 'Pay ₹499', R(0, 100))], commitRects: () => [R(0, 100)] });
    const { call: c2 } = await setup(d2, new Recorder('approved', () => { swapped = true; }));
    await c2('observe');
    const r2 = await c2('tap', { x: 100, y: 150 });
    assert.equal(r2.error?.code, 'STALE_ELEMENT');
    assert.deepEqual(d2.commits, []);
  } finally { delete process.env.MOBIUS_HOME; rmSync(home, { recursive: true }); }
});

test('kill switch stops scrolls, nav keys and driver reads too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mobius-ks3-'));
  process.env.MOBIUS_HOME = home;
  try {
    const d = shop();
    const { call } = await setup(d);
    await call('observe');
    writeFileSync(join(home, 'STOP'), 'now');
    assert.match((await call('scroll', { direction: 'down' })).message, /Kill switch/);
    assert.match((await call('press_key', { key: 'home' })).message, /Kill switch/);
    assert.match((await call('mobius_read_screen_text')).message ?? '', /Kill switch/);
    assert.deepEqual(d.keys, []);
  } finally { delete process.env.MOBIUS_HOME; rmSync(home, { recursive: true }); }
});

test('a sideways scroll on a "slide to pay" screen is judged like a swipe', async () => {
  const d = new OpsDevice({ screen: () => [txt('Slide to pay ₹999', R(0, 1000, 1080, 100))], commitRects: () => [R(0, 0, 1080, 2400)] });
  const { call } = await setup(d);
  await call('observe');
  assert.equal((await call('scroll', { direction: 'left' })).error?.code, 'APPROVAL_REJECTED');
  assert.deepEqual(d.commits, []);
});

test('typing with no focused field while a PIN box is on screen is treated as secret entry', async () => {
  const d = new OpsDevice({ screen: () => [field('UPI PIN', R(0, 300), { password: true })] });
  const { call } = await setup(d);
  const r = await call('type', { text: '1234' });
  assert.equal(r.error?.code, 'APPROVAL_REJECTED');
  assert.deepEqual(d.typed, []);
});

test('the driver binary failing to start is an error, not a crash', async () => {
  process.env.MOBIUS_DRIVER_BIN = '/nonexistent/mobiusagent-driver';
  try {
    await assert.rejects(new MobiusAgentDriver().call('devices'), /could not run|exited/);
  } finally { delete process.env.MOBIUS_DRIVER_BIN; }
});

test('a timed-out action keeps the device busy: the next action waits for it', async () => {
  const d = shop();
  d.slowTapMs = 900;
  const { call } = await setup(d);
  const o = await call('observe');
  const add = o.elements.find((e: any) => e.text === 'Add to cart').id;
  const first = await call('tap', { element_id: add, timeout_ms: 500 });
  assert.equal(first.status, 'outcome_unknown');
  d.slowTapMs = 0;
  await call('tap', { x: 100, y: 150 });
  assert.deepEqual(d.tapLog.slice(0, 3), ['start', 'end', 'start'], 'second tap started only after the first finished');
});

test('driver read errors reach the agent instead of an empty result', async () => {
  const d = shop();
  const { call } = await setup(d);
  const r = await call('mobius_list_notifications');
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r), /notifications/);
});

test('policy: camelCase ids are read as words; a ceiling rule uses the largest amount on screen', () => {
  const el = (p: any) => ({ id: 'e', role: 'button', text: null, label: null, resource_id: null, clickable: true, long_clickable: false, enabled: true,
    focused: false, scrollable: false, editable: false, checked: null, selected: false, sensitive: false, bounds: R(0, 0), dup_index: 0, ...p });
  const p = new Policy();
  assert.equal(p.evaluate({ tool: 'tap', mutating: true, app: 'com.shop', target: el({ resource_id: 'com.shop:id/btnPayNow' }) }).decision, 'approval_required');
  const capped = new Policy({ ...DEFAULT_POLICY, rules: [{ id: 'small', effect: 'allow', action_class: ['payment'], max_amount: 200 }] });
  const v = capped.evaluate({ tool: 'tap', mutating: true, app: 'com.shop', target: el({ text: 'Pay ₹1' }), screen: [el({ text: 'Total ₹50,000' })] });
  assert.equal(v.decision, 'approval_required');
  assert.equal(capped.evaluate({ tool: 'tap', mutating: true, app: 'com.shop', target: el({ text: 'Pay ₹149' }), screen: [el({ text: 'Total ₹149' })] }).decision, 'allow');
});

test('blind x,y taps are judged on the text drawn there (read by Mobius, not supplied by the agent)', async () => {
  // A product card with no accessibility label: the pixels read "SOJANYA Embroidered Straight Kurta" (Myntra live run).
  const card = { ...txt('', R(200, 300, 180, 240)), text: '', desc: '', drawn: 'SOJANYA Embroidered Straight Kurta' } as any;
  const hiddenPay = { ...txt('', R(20, 1500, 400, 100)), text: '', desc: '', drawn: 'Pay ₹999' } as any;
  // iOS containers repeat every label inside them; this one also lists the tab bar's "Post".
  const shell = { ...txt('', R(0, 0, 1080, 2400)), text: '', desc: 'feed grid bottom navigation Home Minis Post Saved Profile', drawn: '' } as any; // a label, not pixels
  const dev = new OpsDevice({ screen: () => [shell, card, hiddenPay] } as any);
  const { call } = await setup(dev);
  await call('observe');
  const kurta = await call('tap', { x: 290, y: 420 });
  assert.equal(kurta.ok, true, JSON.stringify(kurta));
  const pay = await call('tap', { x: 220, y: 1550 });
  assert.equal(pay.error?.code, 'APPROVAL_REJECTED', 'drawn "Pay" still asks');
  const blank = await call('tap', { x: 900, y: 2200 });
  assert.equal(blank.error?.code, 'APPROVAL_REJECTED', 'nothing readable at the point still asks');
});
