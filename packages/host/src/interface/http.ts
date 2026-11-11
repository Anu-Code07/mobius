// Agent interface: REST. For agents and platforms that don't speak MCP. Same engine, same safety.
//
//   GET  /v1/health                         liveness
//   GET  /v1/tools                          tools and their JSON input schemas
//   POST /v1/actions  {tool, arguments}     run one tool (observe, tap, type, …)
//   GET  /v1/audit?limit=50                 recent audit entries
//   GET  /v1/audit/export                   hash-chained audit as JSON lines
//   GET  /v1/audit/verify                   recompute the chain
//
// Every request needs `Authorization: Bearer <MOBIUS_API_TOKEN>`. `X-Mobius-Agent: name/version` names the agent in the audit.
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AuditLog } from '../observability/audit.ts';
import type { Engine } from './engine.ts';
import { verifySession } from '../observability/signing.ts';
import { isRevoked } from '../infrastructure/plane.ts';

const MAX_BODY = 1_000_000;

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let size = 0; const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) { rej(new Error('body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { res(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { rej(new Error('invalid JSON')); } });
    req.on('error', rej);
  });
}
const send = (res: ServerResponse, code: number, body: unknown, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createHttpServer(engine: Engine, audit: AuditLog, token: string, sessionKey?: string) {
  if (!token || token.length < 16) throw new Error('MOBIUS_API_TOKEN must be at least 16 characters');
  return httpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/v1/health') return send(res, 200, { ok: true });
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) return send(res, 401, { error: 'unauthorized' });
      const agent = String(req.headers['x-mobius-agent'] ?? 'rest-client').slice(0, 120);
      if (req.method === 'GET' && url.pathname === '/v1/tools') return send(res, 200, { tools: await engine.tools() });
      if (req.method === 'POST' && url.pathname === '/v1/actions') {
        const body = await readJson(req);
        if (typeof body.tool !== 'string') return send(res, 400, { error: 'body must be {"tool": string, "arguments": object}' });
        // A signed agent session, if presented, is the identity of record (and an invalid one is refused outright).
        const tok = req.headers['x-mobius-session'];
        let session = null;
        if (typeof tok === 'string' && tok) {
          // Read the key per request: after `mobius keys rotate`, tokens from the old key stop working immediately.
          const v = verifySession(tok, sessionKey ?? audit.signer.publicKeyPem);
          if (!v.ok) return send(res, 401, { error: `session token rejected: ${v.reason}` });
          if (isRevoked(v.claims.jti)) return send(res, 401, { error: 'session token rejected: revoked' });
          session = v.claims;
        }
        const r = await engine.call(body.tool, body.arguments ?? {}, session?.sub ?? agent, session);
        return send(res, r.ok ? 200 : 422, r);
      }
      if (req.method === 'GET' && url.pathname === '/v1/audit') return send(res, 200, { entries: audit.recent(Math.min(Number(url.searchParams.get('limit') ?? 50), 1000)) });
      if (req.method === 'GET' && url.pathname === '/v1/audit/export') return send(res, 200, audit.exportJsonl() + '\n', 'application/x-ndjson');
      if (req.method === 'GET' && url.pathname === '/v1/audit/verify') return send(res, 200, audit.verify());
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: (e as Error).message });
    }
  });
}
