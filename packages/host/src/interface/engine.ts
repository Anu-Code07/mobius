// Agent interface: one engine behind every front door (MCP, REST, SDKs). Each call goes through the same tool layer,
// so policy, approvals, verification and audit are identical whichever way an agent connects.
// ponytail: the engine reuses the MCP tool handlers in-process; split them into plain functions if a front door ever
// needs something MCP can't express.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Mobius } from '../infrastructure/registry.ts';
import { createServer } from './mcp.ts';
import type { SessionClaims } from '../observability/signing.ts';

export interface ToolInfo { name: string; description?: string; inputSchema: unknown }
export interface EngineResult { ok: boolean; result: unknown; image?: { data: string; mimeType: string } }
export interface Engine {
  tools(): Promise<ToolInfo[]>;
  /** Run one tool as `agent` (recorded in the audit trail). */
  call(tool: string, args: Record<string, unknown>, agent?: string, session?: SessionClaims | { invalid: string } | null): Promise<EngineResult>;
  close(): Promise<void>;
}

export async function createEngine(mobius: Mobius): Promise<Engine> {
  const server = createServer(mobius);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'mobius-engine', version: '0.1.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  // Identity per call, carried with the call itself (not a shared variable), so calls on different devices run at the
  // same time and each audit entry still names its own agent. Each device's own queue keeps its actions in order.
  const who = new AsyncLocalStorage<{ agent: string | null; session: SessionClaims | { invalid: string } | null }>();
  mobius.plane.agent = () => who.getStore()?.agent ?? null;
  mobius.plane.session = () => who.getStore()?.session ?? null;
  return {
    async tools() { return (await client.listTools()).tools.map(t => ({ name: t.name, ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema })); },
    call(tool, args, agent, session) {
      return who.run({ agent: agent ?? null, session: session ?? null }, async () => {
        const r: any = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 });
        const text = r.content?.find((c: any) => c.type === 'text')?.text ?? '{}';
        const img = r.content?.find((c: any) => c.type === 'image');
        let result: unknown; try { result = JSON.parse(text); } catch { result = { raw: text }; }
        return { ok: !r.isError, result, ...(img ? { image: { data: img.data, mimeType: img.mimeType } } : {}) };
      });
    },
    async close() { await client.close(); },
  };
}
