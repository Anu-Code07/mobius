import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function connect() {
  const c = new Client({ name: 'e2e', version: '0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ['packages/host/src/cli.ts', 'mcp'], stderr: 'ignore',
    env: { ...process.env, MOBIUS_DB: ':memory:' } as Record<string, string> }));
  const dev = process.env.MOBIUS_DEVICE;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    if (dev && name !== 'device_list' && !('device_id' in args)) args = { ...args, device_id: dev };
    const r: any = await c.callTool({ name, arguments: args });
    const text = r.content.find((x: any) => x.type === 'text')?.text ?? '{}';
    let data: any; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { r, data };
  };
  return { c, call };
}

export function runner() {
  const results: { name: string; pass: boolean; ms: number; note: string }[] = [];
  const check = async (name: string, fn: () => Promise<[boolean, string]>) => {
    const t0 = Date.now();
    try { const [pass, note] = await fn(); results.push({ name, pass, ms: Date.now() - t0, note }); }
    catch (e) { results.push({ name, pass: false, ms: Date.now() - t0, note: `threw: ${(e as Error).message}` }); }
  };
  const report = () => {
    for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(42)} ${String(r.ms).padStart(6)}ms  ${r.note}`);
    const failed = results.filter(r => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    return failed;
  };
  return { check, report };
}

export const find = (obs: any, re: RegExp) =>
  obs.elements.find((e: any) => re.test(`${e.text ?? ''} ${e.label ?? ''} ${e.rid ?? ''}`));
