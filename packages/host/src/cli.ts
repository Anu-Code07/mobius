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
  if (!driverBuilt()) throw new Error(`No Mobius driver for ${process.platform}-${process.arch} in this install (looked for ${driverPath()}). ` +
    'Build it from https://github.com/Anu-Code07/mobius (`cargo build --release` in drivers/mobiusagent-driver) and point MOBIUS_DRIVER_BIN at the binary.');
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
/** The package version, from package.json next to dist/ (npm) or src/ (repo). */
function version(): string {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
}
const HELP = `mobius: let AI agents use a real phone, safely

Usage: npx -y @anuraghq/mobius <command>

  init                        Set everything up: checks, iOS runner, and adds Mobius to Claude Code, Cursor, Claude Desktop
  mcp                         Run the MCP server (what your agent starts)
  doctor                      Check your setup: Node, driver, Android, iOS
  setup-ios                   Build and sign the iOS runner once (finds your Apple team)
  serve [--port 7777]         REST API with the same engine
  stop | resume               Kill switch: refuse, or allow again, every agent action
  audit verify | export       Check or print the signed audit log
  session issue | revoke      Signed agent sessions
  keys [--all] | keys rotate  The install's signing key
  --version                   Print the version

Docs: https://github.com/Anu-Code07/mobius#readme
`;

type CheckOpts = { quietTail?: boolean };
const say = (m: string) => process.stdout.write(m + '\n');
const okLine = (m: string) => say(`  ✓ ${m}`);
const badLine = (m: string, fix: string) => say(`  ✗ ${m}\n      → ${fix}`);

async function sh(c: string, a: string[], opts: { inherit?: boolean } = {}) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(c, a, { encoding: 'utf8', timeout: opts.inherit ? 0 : 20_000, stdio: opts.inherit ? 'inherit' : 'pipe' });
  return r.error ? null : r;
}
function hasXcode(): boolean {
  try { return require_('node:child_process').spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' }).status === 0; } catch { return false; }
}
// ponytail: createRequire only to keep hasXcode synchronous; everything else is async.
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);

/** Node, driver, Android (adb + devices) and iOS (Xcode, runner, devices), each with the exact fix. Returns problem count. */
async function checks(o: CheckOpts = {}): Promise<number> {
  let problems = 0;
  const bad = (m: string, fix: string) => { problems++; badLine(m, fix); };
  say('Basics');
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  maj > 22 || (maj === 22 && min >= 5) ? okLine(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, 'Install Node 22.5 or newer (https://nodejs.org)');
  driverBuilt() ? okLine(`Device driver for ${process.platform}-${process.arch}`) : bad(`No device driver for ${process.platform}-${process.arch}`, 'The npm package ships the Apple Silicon Mac driver. Build it from https://github.com/Anu-Code07/mobius and set MOBIUS_DRIVER_BIN.');
  say('\nAndroid');
  const adb = await sh('adb', ['devices']);
  if (!adb || adb.status !== 0) bad('adb not found', process.platform === 'darwin' ? 'brew install android-platform-tools' : 'Install Android platform-tools and put adb on your PATH');
  else {
    okLine('adb installed');
    const rows = adb.stdout.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(r => r.length >= 2);
    if (!rows.length) say('  · No Android device yet: start an emulator, or plug in a phone with USB debugging on (Settings → Developer options)');
    for (const [id, state] of rows) {
      if (state === 'device') okLine(`${id} ready`);
      else if (state === 'unauthorized') bad(`${id} is unauthorized`, 'Unlock the phone and accept the "Allow USB debugging?" prompt');
      else bad(`${id} is ${state}`, 'Reconnect the cable, or run: adb kill-server && adb start-server');
    }
  }
  if (process.platform === 'darwin') {
    say('\niOS');
    const xc = await sh('xcodebuild', ['-version']);
    if (xc && xc.status === 0) okLine(xc.stdout.split('\n')[0]!);
    else bad('Xcode not found', 'Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app');
    if (iosAgentReady()) okLine('iOS runner built');
    else if (o.quietTail) say('  · iOS runner not built yet (built next)');
    else bad('iOS runner not built', 'npx -y @anuraghq/mobius setup-ios');
    if (driverBuilt()) {
      const driver = new MobiusAgentDriver();
      try {
        const ios = (await driver.devices()).filter(d => d.platform === 'ios');
        if (!ios.length) say('  · No iPhone or simulator yet: boot a simulator (open -a Simulator), or connect an unlocked iPhone with Developer Mode on');
        for (const d of ios) d.state === 'online' ? okLine(`${d.name} (${d.type}) ready`) : bad(`${d.name} is ${d.state}`, 'Unlock the iPhone and tap Trust when asked');
      } catch (e) { bad('Could not list iOS devices', (e as Error).message); }
      driver.close();
    }
  }
  return problems;
}

/** Apple developer teams from valid "Apple Development" certificates in the login keychain: [teamId, name]. */
async function appleTeams(): Promise<[string, string][]> {
  const r = await sh('security', ['find-certificate', '-a', '-c', 'Apple Development', '-p']);
  if (!r || r.status !== 0) return [];
  const { X509Certificate } = await import('node:crypto');
  const teams = new Map<string, string>();
  for (const pem of r.stdout.split(/(?<=-----END CERTIFICATE-----)/).map(x => x.trim()).filter(Boolean)) {
    try {
      const x = new X509Certificate(pem);
      if (new Date(x.validTo) < new Date()) continue;
      const ou = /OU=([A-Z0-9]{10})/.exec(x.subject)?.[1];
      if (ou) teams.set(ou, /CN=([^\n]+)/.exec(x.subject)?.[1] ?? ou);
    } catch { /* not a certificate */ }
  }
  return [...teams];
}

/** The team a previous runner build was signed with, so re-runs never switch accounts silently. */
async function previousTeam(): Promise<string | null> {
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const app = join(process.env.MOBIUS_WDA_DIR ?? join(homedir(), '.mobius', 'wda'), 'build', 'Build', 'Products', 'Debug-iphoneos', 'WebDriverAgentRunner-Runner.app');
  if (!existsSync(app)) return null;
  const r = await sh('codesign', ['-dv', app]);
  return /TeamIdentifier=([A-Z0-9]{10})/.exec((r?.stderr ?? '') + (r?.stdout ?? ''))?.[1] ?? null;
}

/** Pick the Apple team: MOBIUS_TEAM_ID, then the previous build's team, then the only team, then ask (terminal) or explain. */
async function pickTeam(): Promise<string | null> {
  if (process.env.MOBIUS_TEAM_ID) return process.env.MOBIUS_TEAM_ID;
  const prev = await previousTeam();
  if (prev) { say(`  Using team ${prev} (your previous Mobius build).`); return prev; }
  const teams = await appleTeams();
  if (teams.length === 1) { say(`  Using team ${teams[0]![0]} (${teams[0]![1]}).`); return teams[0]![0]; }
  if (!teams.length) {
    say('  No Apple Development certificate found. In Xcode: Settings → Accounts → add your Apple ID → Manage Certificates → + Apple Development. A free Apple ID works.');
    return null;
  }
  say('  You have more than one Apple team:');
  teams.forEach(([id, name], i) => say(`    ${i + 1}. ${id}  ${name}`));
  if (process.stdin.isTTY) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question('  Which one should sign the Mobius runner? [1] ')).trim() || '1';
    rl.close();
    const t = teams[Number(ans) - 1];
    if (t) return t[0];
  }
  say(`  Re-run with one of them, for example:\n    MOBIUS_TEAM_ID=${teams[0]![0]} npx -y @anuraghq/mobius setup-ios`);
  return null;
}

async function setupIos(): Promise<number> {
  if (process.platform !== 'darwin') { say('iOS needs a Mac with Xcode.'); return 1; }
  const { fileURLToPath } = await import('node:url');
  const script = [new URL('../ios-agent/setup.sh', import.meta.url), new URL('../../../drivers/mobiusagent-driver/ios-agent/setup.sh', import.meta.url)]
    .map(u => fileURLToPath(u)).find(p => existsSync(p));
  if (!script) { say('ios-agent/setup.sh not found in this install'); return 1; }
  const team = await pickTeam();
  if (!team) return 2;
  process.env.MOBIUS_TEAM_ID = team;
  return (await sh('sh', [script], { inherit: true }))?.status ?? 1;
}

/** Add Mobius to the agents installed here. Never overwrites an existing entry; backs up any file it changes. */
async function registerAgents() {
  const { join, dirname } = await import('node:path');
  const { homedir } = await import('node:os');
  const { copyFileSync, mkdirSync } = await import('node:fs');
  const entry = { command: 'npx', args: ['-y', '@anuraghq/mobius', 'mcp'] };
  let any = false;
  const claude = await sh('claude', ['mcp', 'list']);
  if (claude && claude.status === 0) {
    any = true;
    if (/\bmobius\b/.test(claude.stdout)) okLine('Claude Code: already has Mobius');
    else {
      const r = await sh('claude', ['mcp', 'add', 'mobius', '-s', 'user', '--', 'npx', '-y', '@anuraghq/mobius', 'mcp']);
      r && r.status === 0 ? okLine('Claude Code: added (user scope)') : badLine('Claude Code: could not add Mobius', 'claude mcp add mobius -s user -- npx -y @anuraghq/mobius mcp');
    }
  }
  const files: [string, string][] = [
    ['Cursor', join(homedir(), '.cursor', 'mcp.json')],
    ['Claude Desktop', process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : join(process.env.APPDATA ?? join(homedir(), '.config'), 'Claude', 'claude_desktop_config.json')],
  ];
  for (const [name, file] of files) {
    if (!existsSync(dirname(file))) continue; // that agent isn't installed
    any = true;
    let cfg: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(file)) {
      try { cfg = JSON.parse(readFileSync(file, 'utf8') || '{}'); } catch { badLine(`${name}: ${file} isn't valid JSON, left untouched`, `Add {"mcpServers": {"mobius": ${JSON.stringify(entry)}}} by hand`); continue; }
    }
    if (cfg.mcpServers?.mobius) { okLine(`${name}: already has Mobius`); continue; }
    if (existsSync(file)) copyFileSync(file, file + '.bak-mobius');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), mobius: entry } }, null, 2) + '\n');
    okLine(`${name}: added to ${file}${existsSync(file + '.bak-mobius') ? ' (backup: .bak-mobius)' : ''}`);
  }
  if (!any) say('  · No agent found. Add this to your MCP client\'s config:\n    {"mcpServers": {"mobius": {"command": "npx", "args": ["-y", "@anuraghq/mobius", "mcp"]}}}');
}


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
  process.exit(await setupIos());
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
} else if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  process.stdout.write(version() + '\n');
} else if (cmd === 'doctor') {
  // Checks everything a first run needs and says exactly how to fix what's missing.
  const problems = await checks();
  process.stdout.write(problems ? `\n${problems} thing${problems > 1 ? 's' : ''} to fix.\n` : '\nAll good. Add Mobius to your agent: npx -y @anuraghq/mobius init\n');
  process.exit(problems ? 1 : 0);
} else if (cmd === 'init') {
  // Zero-friction onboarding: check the machine, build the iOS runner if needed, and register Mobius with the agents
  // installed here (Claude Code, Cursor, Claude Desktop). Safe to re-run; existing entries and files are kept.
  const flags = new Set(process.argv.slice(3));
  process.stdout.write(`Setting up Mobius ${version()}\n\n`);
  let problems = await checks({ quietTail: true });
  if (process.platform === 'darwin' && !flags.has('--no-ios') && !iosAgentReady() && hasXcode()) {
    process.stdout.write('\nBuilding the iOS runner (one time, about 2 minutes)...\n');
    const code = await setupIos();
    if (code === 0) problems = Math.max(0, problems - 1);
  }
  if (!flags.has('--no-agents')) { process.stdout.write('\nAgents\n'); await registerAgents(); }
  process.stdout.write(problems
    ? `\n${problems} thing${problems > 1 ? 's' : ''} still to fix (see above). Re-run "npx -y @anuraghq/mobius init" after fixing.\n`
    : `\nReady. Restart your agent, then ask it: "What devices are connected?"\n`);
  process.exit(problems ? 1 : 0);
} else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  process.stdout.write(HELP);
} else {
  process.stderr.write(`mobius: unknown command "${cmd}"\n\n${HELP}`);
  process.exit(2);
}
