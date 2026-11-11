import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ephemeralSigner, installKeyring, installSigner, verifySignature, type Signer } from './signing.ts';

export interface AuditEntry {
  action_id: string;
  device_id: string;
  tool: string;
  /** Already redacted by the caller: never typed text, tokens or screen content. */
  params: Record<string, unknown>;
  status: string;
  error_code: string | null;
  duration_ms: number;
  /** Who acted: MCP client name/version + this server session. */
  agent?: string | null;
  session_id?: string | null;
  /** Policy outcome for the action, when it was gated. */
  decision?: string | null;
  rule_id?: string | null;
  action_class?: string | null;
  amount?: number | null;
  /** Signed agent session token id (jti), when the agent presented one. */
  agent_session?: string | null;
}

const COLS = ['action_id', 'ts', 'device_id', 'tool', 'params', 'status', 'error_code', 'duration_ms',
  'agent', 'session_id', 'decision', 'rule_id', 'action_class', 'amount', 'agent_session', 'prev_hash', 'hash', 'sig'] as const;
type Row = Record<(typeof COLS)[number], string | number | null>;

/** Hash of a row's content chained to the previous row: editing or deleting any past entry breaks every hash after it. */
const HASHED = COLS.filter(c => c !== 'hash' && c !== 'sig' && c !== 'agent_session');
/** Hash of a row's content chained to the previous row. (agent_session joined later; it is covered by the signature.) */
const rowHash = (r: Row) => createHash('sha256').update(JSON.stringify(HASHED.map(c => r[c]))).digest('hex');
/** What the install key signs: the chained hash plus the session id. */
const signed = (r: Row) => `${r.hash}|${r.agent_session ?? ''}`;

/** Verify an exported log anywhere, with only the install's public key(s): chain intact and every entry signed.
 *  With a keyring (oldest key first, after rotations), entries must move forward through it: once a newer key has signed,
 *  a retired key can't sign anything later. So a leaked retired key can't append to or rewrite the log after its rotation. */
export function verifyExport(jsonl: string, keys: string | string[]): { ok: boolean; rows: number; legacy_unsigned?: number; broken_at?: string; reason?: string } {
  const ring = typeof keys === 'string' ? [keys] : keys;
  const rows = jsonl.split('\n').filter(Boolean).map(l => JSON.parse(l) as Row);
  let prev = 'genesis', legacy = 0, signedSeen = false, floor = 0;
  for (const r of rows) {
    if (r.prev_hash !== prev || rowHash(r) !== r.hash) return { ok: false, rows: rows.length, broken_at: String(r.action_id), reason: 'chain broken (entry edited, removed or reordered)' };
    if (!r.sig && !signedSeen) legacy++; // written before signing existed
    else {
      const k = r.sig ? ring.findIndex((key, i) => i >= floor && verifySignature(signed(r), String(r.sig), key)) : -1;
      if (k < 0) return { ok: false, rows: rows.length, broken_at: String(r.action_id), reason: 'signature missing, not from this install, or from a key already retired' };
      floor = k; signedSeen = true;
    }
    prev = String(r.hash);
  }
  return { ok: true, rows: rows.length, ...(legacy ? { legacy_unsigned: legacy } : {}) };
}

/** Append-only, hash-chained action log. `:memory:` in tests. */
export class AuditLog {
  private db: DatabaseSync;
  readonly signer: Signer;
  /** Public keys that may have signed this log, oldest first. */
  readonly keyring: () => string[];
  constructor(path = process.env.MOBIUS_DB ?? defaultPath(), signer?: Signer) {
    this.db = new DatabaseSync(path);
    const install = !signer && path !== ':memory:';
    this.signer = signer ?? (install ? installSigner(mobiusHome()) : ephemeralSigner());
    this.keyring = install ? () => installKeyring(mobiusHome()) : () => [this.signer.publicKeyPem];
    this.db.exec(`CREATE TABLE IF NOT EXISTS actions (
      action_id TEXT PRIMARY KEY, ts TEXT NOT NULL, device_id TEXT NOT NULL, tool TEXT NOT NULL,
      params TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, duration_ms INTEGER NOT NULL)`);
    // Upgrade older logs in place: new columns are nullable; rows before the upgrade simply aren't chained.
    const have = new Set((this.db.prepare('PRAGMA table_info(actions)').all() as { name: string }[]).map(c => c.name));
    for (const c of COLS) if (!have.has(c)) this.db.exec(`ALTER TABLE actions ADD COLUMN ${c} ${c === 'amount' ? 'REAL' : 'TEXT'}`);
  }

  record(e: AuditEntry) {
    const prev = this.db.prepare('SELECT hash FROM actions WHERE hash IS NOT NULL ORDER BY rowid DESC LIMIT 1').get() as { hash: string } | undefined;
    const r: Row = {
      action_id: e.action_id, ts: new Date().toISOString(), device_id: e.device_id, tool: e.tool, params: JSON.stringify(e.params),
      status: e.status, error_code: e.error_code, duration_ms: e.duration_ms, agent: e.agent ?? null, session_id: e.session_id ?? null,
      decision: e.decision ?? null, rule_id: e.rule_id ?? null, action_class: e.action_class ?? null, amount: e.amount ?? null,
      agent_session: e.agent_session ?? null, prev_hash: prev?.hash ?? 'genesis', hash: null, sig: null,
    };
    r.hash = rowHash(r);
    r.sig = this.signer.sign(signed(r));
    this.db.prepare(`INSERT INTO actions (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).run(...COLS.map(c => r[c]));
  }

  recent(limit = 50) {
    return this.db.prepare('SELECT * FROM actions ORDER BY rowid DESC LIMIT ?').all(limit);
  }

  /** All chained rows, oldest first, as JSON lines (for export to a SIEM / evidence store). */
  exportJsonl(): string {
    return (this.db.prepare('SELECT * FROM actions WHERE hash IS NOT NULL ORDER BY rowid').all() as Row[]).map(r => JSON.stringify(r)).join('\n');
  }

  /** Recompute the chain and check every signature against this install's keys (current and retired). */
  verify(): ReturnType<typeof verifyExport> {
    return verifyExport(this.exportJsonl(), this.keyring());
  }

  /** Old unsigned check, kept for logs written before signing existed. */
  verifyChainOnly(): { ok: boolean; rows: number; broken_at?: string } {
    const rows = this.db.prepare('SELECT * FROM actions WHERE hash IS NOT NULL ORDER BY rowid').all() as Row[];
    let prev = 'genesis';
    for (const r of rows) {
      if (r.prev_hash !== prev || rowHash(r) !== r.hash) return { ok: false, rows: rows.length, broken_at: String(r.action_id) };
      prev = String(r.hash);
    }
    return { ok: true, rows: rows.length };
  }
}

export function mobiusHome() {
  const dir = process.env.MOBIUS_HOME ?? join(homedir(), '.mobius');
  mkdirSync(dir, { recursive: true });
  return dir;
}
const defaultPath = () => join(mobiusHome(), 'mobius.db');
