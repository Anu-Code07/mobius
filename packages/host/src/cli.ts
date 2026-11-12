#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLog } from './observability/audit.ts';
import { createServer } from './interface/mcp.ts';
import { createEngine } from './interface/engine.ts';
import { createHttpServer } from './interface/http.ts';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { issueSession, rotateInstallKey, verifySession } from './observability/signing.ts';
/** Session tokens are verified with this install's key, or an operator key (MOBIUS_SESSION_PUBKEY = path to a PEM). */
const operatorKey = process.env.MOBIUS_SESSION_PUBKEY ? readFileSync(process.env.MOBIUS_SESSION_PUBKEY, 'utf8') : undefined;
import { driverBuilt, driverPath, iosAgentReady, MobiusAgentConnector, MobiusAgentDriver } from './execution/drivers/mobiusagent.ts';
import type { Connector } from './execution/connector.ts';

/** Every online device through the Mobius driver. iOS devices also need the Mobius Agent runner set up once. */
const connectors = (driver: MobiusAgentDriver) => async (): Promise<Connector[]> => {
  if (!driverBuilt()) throw new Error(`Mobius driver not built: run \`cargo build --release\` in drivers/mobiusagent-driver (expected ${driverPath()})`);
  const ios = iosAgentReady();
  return (await driver.devices()).filter(d => d.state === 'online' && (d.platform === 'android' || ios)).map(d => new MobiusAgentConnector(driver, d));
};
import { defaultApprover, Policy } from './policy/policy.ts';
import { writeFileSync, rmSync } from 'node:fs';
import { killSwitchPath, revokedPath } from './infrastructure/plane.ts';
import { mobiusHome } from './observability/audit.ts';
import { Mobius } from './infrastructure/registry.ts';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + '\n'); // stdout is the MCP channel

const cmd = process.argv[2] ?? 'mcp';

if (cmd === 'mcp') {
  // ponytail: stdio server owns devices directly. The shared daemon + bridge from DESIGN.md arrives
  // with the Android app connector, when a long-lived WebSocket owner is actually needed.
  const driver = new MobiusAgentDriver();
  const audit = new AuditLog();
  const mobius = new Mobius(
    connectors(driver),
    audit,
    new Policy(),
    defaultApprover(),
  );
  mobius.persistIds = true;
  // A signed agent session handed to this MCP server by its operator (identity + policy version for every action).
  const tok = process.env.MOBIUS_SESSION_TOKEN;
  if (tok) {
    const check = () => verifySession(tok, operatorKey ?? audit.signer.publicKeyPem);
    const v = check();
    // Re-verified on every action: a key rotation or expiry takes effect mid-session (revocation is checked in the gate).
    mobius.plane.session = () => { const r = check(); return r.ok ? r.claims : { invalid: r.reason }; };
    log(v.ok ? 'info' : 'error', v.ok ? 'agent session verified' : 'agent session token rejected', v.ok ? { agent: v.claims.sub, policy: v.claims.policy_version ?? null } : { reason: v.reason });
  }
  const server = createServer(mobius);
  await server.connect(new StdioServerTransport());
  log('info', 'mobius mcp ready');
  const shutdown = async () => { driver.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
} else if (cmd === 'serve') {
  // REST front door (same engine as MCP). Local by default; put it behind your own TLS proxy to expose it.
  const args = process.argv.slice(3);
  const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
  const port = Number(opt('port', '7777')), host = opt('host', '127.0.0.1');
  let token = process.env.MOBIUS_API_TOKEN ?? '';
  if (!token) { token = randomBytes(24).toString('base64url'); process.stderr.write(`MOBIUS_API_TOKEN not set; generated one for this run:\n  ${token}\n`); }
  const driver = new MobiusAgentDriver();
  const audit = new AuditLog();
  const mobius = new Mobius(connectors(driver), audit, new Policy(), defaultApprover());
  mobius.persistIds = true;
  const engine = await createEngine(mobius);
  createHttpServer(engine, audit, token, operatorKey).listen(port, host, () => log('info', 'mobius rest ready', { url: `http://${host}:${port}/v1` }));
  const shutdown = async () => { await engine.close().catch(() => {}); driver.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else if (cmd === 'keys' && process.argv[3] === 'rotate') {
  // Retire the install key (its public half is kept so old audit entries still verify) and start a new one.
  rotateInstallKey(mobiusHome());
  process.stdout.write('Key rotated. Running Mobius servers switch to the new key on their next action.\nEvery session token signed by the old key is now refused: issue new ones with `mobius session issue`.\n');
} else if (cmd === 'keys') {
  // The public half of this install's key: verifies its audit logs and the session tokens it issues.
  // --all: every key it has used, oldest first, as JSON (what an auditor needs to verify a log across rotations).
  const a = new AuditLog();
  process.stdout.write(process.argv[3] === '--all' ? JSON.stringify(a.keyring(), null, 2) + '\n' : a.signer.publicKeyPem);
} else if (cmd === 'session' && process.argv[3] === 'revoke') {
  // mobius session revoke <jti>: the jti is printed at issue time and recorded on every audit entry.
  const jti = process.argv[4];
  if (!jti || !/^[\w.-]{1,128}$/.test(jti)) { process.stderr.write('usage: mobius session revoke <session id (jti), e.g. ses_1a2b3c>\n'); process.exit(2); }
  appendFileSync(revokedPath(), jti + '\n', { mode: 0o600 });
  process.stdout.write(`Session ${jti} revoked: every Mobius on this machine refuses its actions from now on.\n`);
} else if (cmd === 'session' && process.argv[3] === 'issue') {
  // mobius session issue --agent acme-bot/1.0 [--ttl 8h] [--policy-version v3] [--issuer ops-team]
  const args = process.argv.slice(4);
  const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const agent = opt('agent');
  if (!agent) { process.stderr.write('usage: mobius session issue --agent <name/version> [--ttl 8h] [--policy-version <v>] [--issuer <who>]\n'); process.exit(2); }
  const m = /^(\d+)(m|h|d)$/.exec(opt('ttl') ?? '8h');
  if (!m) { process.stderr.write('--ttl: e.g. 30m, 8h, 7d\n'); process.exit(2); }
  const now = Math.floor(Date.now() / 1000);
  const pv = opt('policy-version'), iss = opt('issuer');
  const jti = `ses_${randomBytes(6).toString('hex')}`;
  process.stderr.write(`session id ${jti} (revoke with: mobius session revoke ${jti})\n`);
  process.stdout.write(issueSession(new AuditLog().signer, {
    sub: agent, jti, iat: now, exp: now + Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as 'm' | 'h' | 'd'],
    ...(pv ? { policy_version: pv } : {}), ...(iss ? { iss } : {}),
  }) + '\n');
} else if (cmd === 'setup-ios') {
  // One-time iOS setup: build, patch, sign and install the Mobius Agent runner with your Apple developer team.
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = [new URL('../ios-agent/setup.sh', import.meta.url), new URL('../../../drivers/mobiusagent-driver/ios-agent/setup.sh', import.meta.url)]
    .map(u => fileURLToPath(u)).find(p => existsSync(p));
  if (!script) { process.stderr.write('ios-agent/setup.sh not found in this install\n'); process.exit(1); }
  if (!process.env.MOBIUS_TEAM_ID) { process.stderr.write('Set MOBIUS_TEAM_ID to your Apple developer team id (the OU of your "Apple Development" certificate):\n  MOBIUS_TEAM_ID=XXXXXXXXXX mobius setup-ios\n'); process.exit(2); }
  process.exit(spawnSync('sh', [script], { stdio: 'inherit' }).status ?? 1);
} else if (cmd === 'stop') {
  // Kill switch: every running Mobius refuses state-changing actions until `mobius resume`.
  writeFileSync(killSwitchPath(), new Date().toISOString());
  process.stdout.write('Kill switch engaged: all agent actions are stopped. Run `mobius resume` to allow them again.\n');
} else if (cmd === 'resume') {
  rmSync(killSwitchPath(), { force: true });
  process.stdout.write('Kill switch released.\n');
} else if (cmd === 'audit' && process.argv[3] === 'export') {
  process.stdout.write(new AuditLog().exportJsonl() + '\n');
} else if (cmd === 'audit' && process.argv[3] === 'verify') {
  const r = new AuditLog().verify();
  process.stdout.write(r.ok ? `Audit log intact: ${r.rows} entries, chain and signatures verified${r.legacy_unsigned ? ` (${r.legacy_unsigned} older unsigned entries)` : ''}.\n` : `TAMPERED at ${r.broken_at}: ${r.reason} (${r.rows} entries).\n`);
  process.exit(r.ok ? 0 : 1);
} else {
  process.stderr.write('usage: mobius mcp | serve [--port 7777] [--host 127.0.0.1] | session issue --agent <name> | session revoke <jti> | keys [--all] | keys rotate | setup-ios | stop | resume | audit export | audit verify\n');
  process.exit(2);
}
