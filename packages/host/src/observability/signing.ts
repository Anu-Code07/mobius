// Observability: an Ed25519 identity for this Mobius install. It signs audit entries (so an exported log can be verified
// anywhere) and agent session tokens (so identity and policy travel with the session). Keys are plain Node crypto.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Signer { sign(data: string): string; publicKeyPem: string }

export const signerFromKey = (key: KeyObject): Signer => ({
  sign: data => sign(null, Buffer.from(data), key).toString('base64url'),
  publicKeyPem: createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(),
});
export const ephemeralSigner = (): Signer => signerFromKey(generateKeyPairSync('ed25519').privateKey);

const keyFile = (home: string) => join(home, 'keys', 'ed25519.pem');
const retiredDir = (home: string) => join(home, 'keys', 'retired');
const writeKey = (file: string) => {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file); // atomic: a running server never sees a missing key
};

/** The install's key, created on first use (owner-only permissions). Reloaded when `mobius keys rotate` replaces it, so
 *  running servers switch to the new key without a restart. */
export function installSigner(home: string): Signer {
  const file = keyFile(home);
  if (!existsSync(file)) writeKey(file);
  let stamp = '', cur!: Signer;
  const load = () => {
    const st = statSync(file), s = `${st.ino}:${st.mtimeMs}`;
    if (s !== stamp) { cur = signerFromKey(createPrivateKey(readFileSync(file))); stamp = s; }
    return cur;
  };
  load();
  return { sign: d => load().sign(d), get publicKeyPem() { return load().publicKeyPem; } };
}

/** Retire the install key: keep only its public half (old audit entries still verify), switch to a new key. Every session
 *  token the old key signed stops working. */
export function rotateInstallKey(home: string): Signer {
  const file = keyFile(home), dir = retiredDir(home);
  if (existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const n = readdirSync(dir).filter(f => f.endsWith('.pub.pem')).length;
    const pub = createPublicKey(createPrivateKey(readFileSync(file))).export({ type: 'spki', format: 'pem' }).toString();
    writeFileSync(join(dir, `${String(n).padStart(4, '0')}-${new Date().toISOString().replace(/[:.]/g, '-')}.pub.pem`), pub);
  }
  writeKey(file);
  return installSigner(home);
}

/** Every public key this install has used, oldest first; the last one is current. */
export function installKeyring(home: string): string[] {
  const dir = retiredDir(home);
  const old = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.pub.pem')).sort().map(f => readFileSync(join(dir, f), 'utf8')) : [];
  return [...old, installSigner(home).publicKeyPem];
}

export function verifySignature(data: string, signature: string, publicKeyPem: string): boolean {
  try { return verify(null, Buffer.from(data), createPublicKey(publicKeyPem), Buffer.from(signature, 'base64url')); } catch { return false; }
}

// ---- agent session tokens: <base64url(claims)>.<base64url(signature)> ----

export interface SessionClaims {
  /** Agent identity, e.g. "acme-refund-bot/2.1". */
  sub: string;
  /** Token id, recorded on every audit entry. */
  jti: string;
  /** Unix seconds. */
  iat: number;
  exp: number;
  /** The policy version this session may run under; Mobius refuses actions if it runs another. */
  policy_version?: string;
  /** Who issued it (operator, team), free text. */
  iss?: string;
}

export function issueSession(s: Signer, claims: SessionClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${s.sign(body)}`;
}

export function verifySession(token: string, publicKeyPem: string, now = Date.now() / 1000): { ok: true; claims: SessionClaims } | { ok: false; reason: string } {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'malformed token' };
  if (!verifySignature(body, sig, publicKeyPem)) return { ok: false, reason: 'bad signature' };
  let c: SessionClaims;
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed claims' }; }
  if (typeof c.sub !== 'string' || typeof c.jti !== 'string' || typeof c.exp !== 'number') return { ok: false, reason: 'missing claims' };
  if (now >= c.exp) return { ok: false, reason: 'expired' };
  return { ok: true, claims: c };
}
