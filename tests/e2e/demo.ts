// Scripted demo for the README recording: Mobius drives the fixture app the way an agent would
// (observe → one action → verify), and prints each tool call. No LLM involved.
// Run: node tests/e2e/demo.ts <mobius-device-id>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DEVICE = process.argv[2] ?? 'mobius_readme';
// 'live' = real approval dialog on the Mac (a human decides); otherwise scripted answers.
const LIVE = process.argv[3] === 'live';
const APP = 'dev.mobius.mobius_fixture';

async function server(approval: 'approved' | 'rejected') {
  const c = new Client({ name: 'demo', version: '0' });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: ['packages/host/src/cli.ts', 'mcp'], stderr: 'ignore',
    env: { ...process.env, MOBIUS_DB: ':memory:', ...(LIVE ? {} : { MOBIUS_TEST_APPROVAL: approval }) } as Record<string, string>,
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await c.callTool({ name, arguments: { device_id: DEVICE, ...args } }, undefined, { timeout: 180_000 });
    const d = JSON.parse(r.content.find((x: any) => x.type === 'text').text);
    if (name !== 'observe') {
      const shown = { ...args }; delete (shown as any).device_id;
      console.log(`→ ${name} ${JSON.stringify(shown)}  ⇒ ${d.ok ? 'ok' : d.error?.code}${d.verified ? ' (verified)' : ''}  ${d.message ?? ''}`);
    }
    return d;
  };
  return { c, call };
}

const label = (e: any) => `${e.text ?? ''} ${e.label ?? ''} ${e.rid ?? ''}`.trim();
async function tapOn(call: any, re: RegExp, expect?: Record<string, string>) {
  for (let i = 0; i < 6; i++) {
    const o = await call('observe');
    const e = o.elements.find((x: any) => re.test(label(x)) && x.flags?.includes('clickable'));
    if (e) return call('tap', { element_id: e.id, ...(expect ? { expect } : {}) });
    if (i > 0) await call('scroll', { direction: i <= 3 ? 'down' : 'up' });
  }
  throw new Error(`not found: ${re}`);
}
async function typeInto(call: any, re: RegExp, text: string) {
  const o = await call('observe');
  const e = o.elements.find((x: any) => re.test(label(x)) && x.flags?.includes('editable'));
  return call('type', { element_id: e.id, text });
}
const closeKb = async (call: any) => { if ((await call('observe')).keyboard) await call('press_key', { key: 'back' }); };

console.log('# Scene 1: order food. "Place order" needs approval; the user rejects it.');
const r = await server('rejected');
await r.call('open_app', { app_id: APP });
await tapOn(r.call, /nav_services/, { text_visible: 'Food delivery' });
await tapOn(r.call, /svc_food/);
await typeInto(r.call, /Search dishes/, 'biryani');
await tapOn(r.call, /^Search$/);
await tapOn(r.call, /Paradise Biryani/);
await tapOn(r.call, /Add one Chicken Biryani/);
await tapOn(r.call, /View cart/);
await closeKb(r.call);
await tapOn(r.call, /^Continue/, { text_visible: 'Place order' });
await tapOn(r.call, /Place order/);
await r.c.close();

console.log('\n# Scene 2: book a cab, approved. The OTP is on screen but masked for the agent.');
const a = await server('approved');
await a.call('press_key', { key: 'back' }); await a.call('press_key', { key: 'back' });
await a.call('open_app', { app_id: APP });
for (let i = 0; i < 8; i++) { const o = await a.call('observe'); if (o.elements.some((e: any) => e.rid === 'nav_services')) break; await a.call('press_key', { key: 'back' }); }
await tapOn(a.call, /nav_services/);
await tapOn(a.call, /svc_cab/);
await typeInto(a.call, /Pickup/, 'Koramangala');
await typeInto(a.call, /^Drop/, 'Airport');
await closeKb(a.call);
await tapOn(a.call, /See rides/);
await tapOn(a.call, /^Bike/);
await tapOn(a.call, /Book ride/, { text_visible: 'Driver Ramesh' });
const done = await a.call('observe');
const st = done.elements.find((e: any) => /Driver Ramesh/.test(label(e)));
console.log(`  agent sees: "${st?.label}"`);
await a.c.close();
