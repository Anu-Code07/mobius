// REST front door: same engine, same safety as MCP.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AttackDevice, btn, txt } from '../bench/break-mobius.ts';
import { createEngine } from '../src/interface/engine.ts';
import { createHttpServer } from '../src/interface/http.ts';
import { Mobius } from '../src/infrastructure/registry.ts';
import { AuditLog } from '../src/observability/audit.ts';
import { FixedApprover, Policy } from '../src/policy/policy.ts';

const TOKEN = 'test-token-0123456789abcdef';
const PAY = { x: 100, y: 1800, width: 880, height: 140 };

test('REST: auth, tools, actions through the same policy gate, agent in the audit', async () => {
  const device = new AttackDevice({ commitRects: () => [PAY], screen: () => [txt('Total'), txt('₹438'), btn('Pay ₹438', PAY)] });
  const audit = new AuditLog(':memory:');
  const engine = await createEngine(new Mobius(async () => [device], audit, new Policy(), new FixedApprover('rejected', { anyDevice: true })));
  const srv = createHttpServer(engine, audit, TOKEN).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-mobius-agent': 'acme-ops-bot/2.1' };
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/tools`)).status, 401, 'no token');
    assert.equal((await fetch(`${base}/tools`, { headers: { authorization: 'Bearer wrong-token-0123456789' } })).status, 401);
    const tools = await (await fetch(`${base}/tools`, { headers: H })).json() as any;
    assert.ok(tools.tools.some((t: any) => t.name === 'tap'));
    const obs = await (await fetch(`${base}/actions`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'observe', arguments: {} }) })).json() as any;
    const pay = obs.result.elements.find((e: any) => /Pay/.test(e.text ?? ''));
    const r = await fetch(`${base}/actions`, { method: 'POST', headers: H, body: JSON.stringify({ tool: 'tap', arguments: { element_id: pay.id } }) });
    assert.equal(r.status, 422);
    assert.equal(((await r.json()) as any).result.error.code, 'APPROVAL_REJECTED');
    assert.deepEqual(device.commits, [], 'nothing paid over REST either');
    const entries = ((await (await fetch(`${base}/audit`, { headers: H })).json()) as any).entries;
    assert.equal(entries[0].agent, 'acme-ops-bot/2.1');
    assert.equal(entries[0].action_class, 'payment');
    assert.deepEqual(await (await fetch(`${base}/audit/verify`, { headers: H })).json(), { ok: true, rows: entries.length });
  } finally { srv.close(); await engine.close(); }
});

test('REST refuses a weak token', () => {
  assert.throws(() => createHttpServer({} as any, {} as any, 'short'), /at least 16/);
});

test('REST: signed agent sessions are the identity of record; bad, expired or wrong-policy sessions are refused', async () => {
  const { issueSession, ephemeralSigner } = await import('../src/observability/signing.ts');
  const { DEFAULT_POLICY } = await import('../src/policy/policy.ts');
  const device = new AttackDevice({ screen: () => [txt('Home'), btn('Search', { x: 0, y: 0, width: 400, height: 100 })] });
  const audit = new AuditLog(':memory:');
  const mobius = new Mobius(async () => [device], audit, new Policy({ ...DEFAULT_POLICY, version: 'acme-v3' }), new FixedApprover('rejected', { anyDevice: true }));
  mobius.plane.require_session = true;
  const engine = await createEngine(mobius);
  const srv = createHttpServer(engine, audit, TOKEN).listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  const now = Math.floor(Date.now() / 1000);
  const tok = (c: object, key = audit.signer) => issueSession(key, { sub: 'acme-refund-bot/2.1', jti: 'ses_ok', iat: now, exp: now + 600, ...c });
  const act = async (session?: string) => {
    const r = await fetch(`${base}/actions`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(session ? { 'x-mobius-session': session } : {}) },
      body: JSON.stringify({ tool: 'tap', arguments: { x: 200, y: 50 } }) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    assert.match((await act()).body.result.error.message, /requires a signed agent session/, 'anonymous agents refused');
    assert.equal((await act(tok({ policy_version: 'acme-v3' }, ephemeralSigner()))).status, 401, 'token from another key');
    assert.match((await act(tok({ policy_version: 'acme-v2' }))).body.result.error.message, /issued for policy acme-v2/);
    const ok = await act(tok({ policy_version: 'acme-v3' }));
    assert.equal(ok.body.result.ok, true);
    const e = audit.recent(1)[0] as any;
    assert.deepEqual([e.agent, e.agent_session], ['acme-refund-bot/2.1', 'ses_ok']);
  } finally { srv.close(); await engine.close(); }
});
