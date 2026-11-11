// Foundation hardening: devices run in parallel, sessions can be revoked, the signing key can be rotated.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createPrivateKey } from 'node:crypto';
import { AttackDevice, btn } from '../bench/break-mobius.ts';
import { createEngine } from '../src/interface/engine.ts';
import { Mobius } from '../src/infrastructure/registry.ts';
import { AuditLog, verifyExport } from '../src/observability/audit.ts';
import { issueSession, rotateInstallKey, signerFromKey, verifySession } from '../src/observability/signing.ts';
import { FixedApprover, Policy } from '../src/policy/policy.ts';

const ADD = { x: 100, y: 600, width: 400, height: 120 };
const tapAdd = async (engine: Awaited<ReturnType<typeof createEngine>>, device_id: string, agent: string, session?: any) => {
  const o = await engine.call('observe', { device_id }, agent, session);
  const id = (o.result as any).elements.find((e: any) => e.text === 'Add to cart').id;
  return engine.call('tap', { device_id, element_id: id }, agent, session);
};

test('engine: a slow device does not hold up another, and each audit entry names its own agent', async () => {
  let release!: () => void;
  const held = new Promise<void>(r => (release = r));
  const slow = new AttackDevice({ deviceId: 'emu-slow', screen: () => [btn('Add to cart', ADD)] } as any);
  const fast = new AttackDevice({ deviceId: 'emu-fast', screen: () => [btn('Add to cart', ADD)] } as any);
  const realTap = slow.tap.bind(slow);
  slow.tap = async (x, y) => { await held; return realTap(x, y); };
  const audit = new AuditLog(':memory:');
  const engine = await createEngine(new Mobius(async () => [slow, fast], audit, new Policy(), new FixedApprover('rejected', { anyDevice: true })));
  try {
    const a = tapAdd(engine, 'emu-slow', 'alpha/1');
    await new Promise(r => setTimeout(r, 50)); // alpha's tap is now stuck on the slow device
    const b = await Promise.race([tapAdd(engine, 'emu-fast', 'beta/1'), new Promise(r => setTimeout(() => r('blocked'), 2000))]);
    assert.notEqual(b, 'blocked', 'the fast device was held up by the slow one');
    assert.equal((b as any).ok, true);
    release();
    assert.equal((await a).ok, true);
    const taps = (audit.recent(50) as any[]).filter(e => e.tool === 'tap').map(e => `${e.device_id}=${e.agent}`).sort();
    assert.deepEqual(taps, ['emu-fast=beta/1', 'emu-slow=alpha/1']);
  } finally { release(); await engine.close(); }
});

test('sessions: a revoked session is refused before it expires', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mobius-rev-'));
  process.env.MOBIUS_HOME = home;
  try {
    const { revokedPath } = await import('../src/infrastructure/plane.ts');
    const audit = new AuditLog(':memory:');
    const engine = await createEngine(new Mobius(async () => [new AttackDevice({ screen: () => [btn('Add to cart', ADD)] })], audit, new Policy(), new FixedApprover('rejected', { anyDevice: true })));
    const now = Math.floor(Date.now() / 1000);
    const claims = verifySession(issueSession(audit.signer, { sub: 'bot/1', jti: 'ses_live', iat: now, exp: now + 3600 }), audit.signer.publicKeyPem);
    assert.ok(claims.ok);
    assert.equal((await tapAdd(engine, 'emulator-attack', 'bot/1', claims.claims)).ok, true);
    appendFileSync(revokedPath(), 'ses_other\nses_live\n');
    const r = await tapAdd(engine, 'emulator-attack', 'bot/1', claims.claims);
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r.result), /revoked/);
    await engine.close();
  } finally { rmSync(home, { recursive: true }); delete process.env.MOBIUS_HOME; }
});

test('key rotation: old entries still verify, old sessions die, a retired key cannot sign new entries', () => {
  const home = mkdtempSync(join(tmpdir(), 'mobius-rot-'));
  process.env.MOBIUS_HOME = home;
  try {
    const audit = new AuditLog(join(home, 'm.db'));
    const rec = (id: string) => audit.record({ action_id: id, device_id: 'd', tool: 'tap', params: {}, status: 'succeeded', error_code: null, duration_ms: 1 });
    rec('a1'); rec('a2');
    const oldKey = signerFromKey(createPrivateKey(readFileSync(join(home, 'keys', 'ed25519.pem'))));
    const now = Math.floor(Date.now() / 1000);
    const oldToken = issueSession(audit.signer, { sub: 'bot/1', jti: 'ses_old', iat: now, exp: now + 3600 });

    rotateInstallKey(home);
    rec('a3'); rec('a4'); // same AuditLog instance: picks up the new key without a restart
    assert.notEqual(audit.signer.publicKeyPem, oldKey.publicKeyPem);
    assert.equal(audit.keyring().length, 2);
    assert.deepEqual(audit.verify(), { ok: true, rows: 4 });
    assert.deepEqual(verifySession(oldToken, audit.signer.publicKeyPem), { ok: false, reason: 'bad signature' });

    // Someone holding the retired private key re-signs the newest entry: refused, keys only move forward.
    const rows = audit.exportJsonl().split('\n').map(l => JSON.parse(l));
    const last = rows.at(-1); last.sig = oldKey.sign(`${last.hash}|${last.agent_session ?? ''}`);
    const r = verifyExport(rows.map(x => JSON.stringify(x)).join('\n'), audit.keyring());
    assert.equal(r.ok, false);
    assert.equal(r.broken_at, 'a4');
  } finally { rmSync(home, { recursive: true }); delete process.env.MOBIUS_HOME; }
});

test('open_app waits for a slow cold launch instead of reporting failure (Scapia on iOS, live run)', async () => {
  const dev = new AttackDevice({ app: 'com.apple.springboard', screen: () => [btn('Add to cart', ADD)] });
  dev.openApp = async (a: string) => { setTimeout(() => (dev.app = a), 7_000); }; // reaches the foreground after the old 6 s window
  const engine = await createEngine(new Mobius(async () => [dev], new AuditLog(':memory:'), new Policy(), new FixedApprover('rejected', { anyDevice: true })));
  try {
    const r = await engine.call('open_app', { app_id: 'cards.example.app' });
    assert.equal(r.ok, true, JSON.stringify(r.result));
    assert.equal((r.result as any).foreground_app, 'cards.example.app');
  } finally { await engine.close(); }
});
