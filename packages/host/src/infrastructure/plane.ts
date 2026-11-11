// Infrastructure: session-wide limits and the kill switch, shared by every device a server drives.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mobiusHome } from '../observability/audit.ts';
import type { SessionClaims } from '../observability/signing.ts';

/** Shared across all devices of one server process: who the agent is, and its limits. */
export interface PlaneContext {
  session_id: string;
  /** MCP client name/version once the agent has connected. */
  agent: () => string | null;
  /** Mutating actions so far, and when the session began. */
  actions: number;
  started: number;
  max_actions: number;
  /** 0 = no limit. */
  max_minutes: number;
  /** The verified signed session of the agent making the current call (or an invalid-token reason). */
  session: () => SessionClaims | { invalid: string } | null;
  /** Refuse state-changing actions from agents without a valid signed session (MOBIUS_REQUIRE_SESSION=1). */
  require_session: boolean;
}
export const newPlaneContext = (agent: () => string | null = () => null): PlaneContext => ({
  session_id: `ses_${randomUUID().slice(0, 8)}`, agent, actions: 0, started: Date.now(),
  max_actions: Number(process.env.MOBIUS_MAX_ACTIONS ?? 1000), max_minutes: Number(process.env.MOBIUS_MAX_SESSION_MIN ?? 0),
  session: () => null, require_session: process.env.MOBIUS_REQUIRE_SESSION === '1',
});
/** `mobius stop` creates this file; every state-changing action is refused until `mobius resume`. */
export const killSwitchPath = () => join(mobiusHome(), 'STOP');
/** `mobius session revoke <jti>` appends here; a revoked session can't act, even before it expires. */
export const revokedPath = () => join(mobiusHome(), 'revoked');
// ponytail: re-read per check (a few lines, like the kill switch); index it if the list ever reaches thousands.
export const isRevoked = (jti: string) => existsSync(revokedPath()) && readFileSync(revokedPath(), 'utf8').split('\n').some(l => l.trim() === jti);
