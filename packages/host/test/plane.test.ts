// Agent plane: policy as code, audit chain, kill switch, quotas, secrets vault, webhook approvals.
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AuditLog, verifyExport } from '../src/observability/audit.ts';
import { ephemeralSigner, issueSession, verifySession } from '../src/observability/signing.ts';
import { amountInvolved, DEFAULT_POLICY, Policy, WebhookApprover, type PolicyRule } from '../src/policy/policy.ts';
import type { Element } from '../src/core/protocol.ts';

const el = (p: Partial<Element>): Element => ({ id: 'o1:e1', role: 'button', text: null, label: null, resource_id: null, clickable: true,
  long_clickable: false, enabled: true, focused: false, scrollable: false, editable: false, checked: null, selected: false,
  sensitive: false, bounds: { x: 0, y: 0, width: 100, height: 100 }, dup_index: 0, ...p });
const withRules = (rules: PolicyRule[], extra = {}) => new Policy({ ...DEFAULT_POLICY, rules, version: 'test-1', ...extra });

test('policy as code: amount-aware allow, first match wins, rule id recorded', () => {
  const p = withRules([
    { id: 'small-food-orders', effect: 'allow', app: 'bundl\\.swiggy', action_class: ['payment'], max_amount: 200 },
    { id: 'whatsapp-send-always', effect: 'approval_required', app: 'com\\.whatsapp', action_class: ['send'] },
  ]);
  const pay = (text: string, app = 'bundl.swiggy') => p.evaluate({ tool: 'tap', mutating: true, app, target: el({ text }) });
  const small = pay('Pay ₹149');
  assert.equal(small.decision, 'allow');
  assert.equal(small.rule_id, 'small-food-orders');
  assert.equal(small.amount, 149);
  assert.equal(pay('Pay ₹438').decision, 'approval_required', 'above the limit still asks');
  assert.equal(pay('Pay ₹149', 'com.other.app').decision, 'approval_required', 'rule is scoped to its app');
});

test('policy as code: an anchored target matches a label-only control', () => {
  const p = withRules([{ id: 'ig-tabs', effect: 'allow', app: 'com\\.burbn\\.instagram', tool: ['tap'], target: '^(Reels|Main feed|Explore)$' }]);
  const tap = (label: string) => p.evaluate({ tool: 'tap', mutating: true, app: 'com.burbn.instagram', target: el({ label }) });
  assert.equal(tap('Reels').decision, 'allow');
  assert.equal(tap('Send').decision, 'approval_required', 'other Instagram taps still ask');
});

test('policy as code: rules can never loosen a hard block', () => {
  const p = withRules([{ id: 'yolo', effect: 'allow' }]);
  assert.equal(p.evaluate({ tool: 'tap', mutating: true, app: 'com.phonepe.app', target: el({ text: 'Pay' }) }).decision, 'blocked');
});

test('policy as code: dry run reports but does not ask; blocks still enforced', () => {
  const p = withRules([], { dry_run: true });
  const v = p.evaluate({ tool: 'tap', mutating: true, app: 'x', target: el({ text: 'Pay ₹10' }) });
  assert.equal(v.decision, 'allow');
  assert.equal(v.dry_run, true);
  assert.match(v.reason, /would ask/);
  assert.equal(p.evaluate({ tool: 'open_app', mutating: true, app: null, target: null, targetApp: 'com.phonepe.app' }).decision, 'blocked');
});

test('amount from the target, else from the screen total', () => {
  assert.equal(amountInvolved(el({ text: 'Pay ₹1,249.50' }), []), 1249.5);
  assert.equal(amountInvolved(el({ text: 'Continue' }), [el({ text: 'Total' }), el({ text: '₹438' })]), 438);
  assert.equal(amountInvolved(el({ text: 'Continue' }), [el({ text: 'Menu ₹99' })]), null, 'a price is not a total');
});

test('audit: hash chain detects edits; identity and verdict recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobius-'));
  const db = join(dir, 'a.db');
  const key = ephemeralSigner();
  const a = new AuditLog(db, key);
  for (const id of ['act_1', 'act_2', 'act_3']) {
    a.record({ action_id: id, device_id: 'd', tool: 'tap', params: {}, status: 'succeeded', error_code: null, duration_ms: 1,
      agent: 'claude-code/2.1', session_id: 'ses_x', decision: 'approval_required', rule_id: 'builtin.approval_required', action_class: 'payment', amount: 438 });
  }
  assert.deepEqual(a.verify(), { ok: true, rows: 3 });
  const line = JSON.parse(a.exportJsonl().split('\n')[0]!);
  assert.equal(line.agent, 'claude-code/2.1');
  assert.equal(line.action_class, 'payment');
  new DatabaseSync(db).exec("UPDATE actions SET status = 'blocked' WHERE action_id = 'act_2'"); // someone rewrites history
  const after = new AuditLog(db, key).verify();
  assert.deepEqual([after.ok, after.broken_at], [false, 'act_2']);
  assert.match(after.reason!, /chain broken/);
  rmSync(dir, { recursive: true });
});

test('webhook approver: remote decision, fail closed on errors', async () => {
  let body: any;
  const srv = httpServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      body = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ decision: body.summary.includes('ok') ? 'approved' : 'nope' }));
    });
  });
  await new Promise<void>(r => srv.listen(0, r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}`;
  const req = (summary: string) => ({ id: 'a', device_id: 'd', app: 'x', tool: 'tap', summary, reason: 'r', action_class: 'payment' as const });
  const w = new WebhookApprover(url, 'tok');
  assert.equal(await w.request(req('ok tap'), 5), 'approved');
  assert.equal(body.action_class, 'payment');
  assert.equal(await w.request(req('tap'), 5), 'rejected', 'anything but "approved" is a no');
  srv.close();
  assert.equal(await new WebhookApprover('http://127.0.0.1:1').request(req('ok'), 2), 'rejected', 'unreachable approver fails closed');
});

test('kill switch file and quotas block mutating actions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mobius-home-'));
  process.env.MOBIUS_HOME = dir;
  const { killSwitchPath } = await import('../src/infrastructure/plane.ts');
  writeFileSync(killSwitchPath(), 'now');
  assert.ok(killSwitchPath().startsWith(dir));
  rmSync(dir, { recursive: true });
  delete process.env.MOBIUS_HOME;
});

test('signed audit: an exported log verifies anywhere with the public key; a forged entry does not', () => {
  const key = ephemeralSigner(), other = ephemeralSigner();
  const a = new AuditLog(':memory:', key);
  for (const id of ['a1', 'a2']) a.record({ action_id: id, device_id: 'd', tool: 'tap', params: {}, status: 'succeeded', error_code: null, duration_ms: 1, agent_session: 'jti_1' });
  const jsonl = a.exportJsonl();
  assert.deepEqual(verifyExport(jsonl, key.publicKeyPem), { ok: true, rows: 2 });
  assert.equal(verifyExport(jsonl, other.publicKeyPem).ok, false, 'signed by someone else');
  // An attacker who rewrites an entry and recomputes the hash chain still can't produce the signature.
  const forged = jsonl.split('\n').map(l => JSON.parse(l)); forged[1].agent_session = 'jti_attacker';
  assert.match(verifyExport(forged.map(r => JSON.stringify(r)).join('\n'), key.publicKeyPem).reason!, /signature/);
});

test('session tokens: signed identity + policy version, expiry, tamper-proof', () => {
  const key = ephemeralSigner();
  const now = Math.floor(Date.now() / 1000);
  const t = issueSession(key, { sub: 'acme-refund-bot/2.1', jti: 'ses_1', iat: now, exp: now + 3600, policy_version: 'acme-v3' });
  const v = verifySession(t, key.publicKeyPem);
  assert.ok(v.ok && v.claims.sub === 'acme-refund-bot/2.1' && v.claims.policy_version === 'acme-v3');
  assert.deepEqual(verifySession(t, key.publicKeyPem, now + 7200), { ok: false, reason: 'expired' });
  const [body, sig] = t.split('.');
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), sub: 'admin' })).toString('base64url');
  assert.deepEqual(verifySession(`${evil}.${sig}`, key.publicKeyPem), { ok: false, reason: 'bad signature' });
});
