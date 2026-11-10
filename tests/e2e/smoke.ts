// Live smoke test: spawns `mobius mcp`, drives the Settings app on the first connected Android device.
// Run: node tests/e2e/smoke.ts   (needs a running emulator/device)
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const c = new Client({ name: 'smoke', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['packages/host/src/cli.ts', 'mcp'], stderr: 'ignore',
  env: { ...process.env, MOBIUS_DB: ':memory:' } as Record<string, string> }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const t0 = Date.now();
  const r: any = await c.callTool({ name, arguments: args });
  const text = r.content.find((x: any) => x.type === 'text')?.text ?? '';
  console.log(`${name} ${Date.now() - t0}ms ${r.isError ? 'ERROR ' : ''}${text.length} chars`);
  return { r, data: JSON.parse(text) };
};

const tools = (await c.listTools()).tools.map(t => t.name);
console.log('tools:', tools.join(', '));
const { data: devs } = await call('device_list');
const dev = devs.devices.find((d: any) => d.platform === 'android');
assert.ok(dev, 'no android device');
const device_id = dev.device_id;

const open = await call('open_app', { device_id, app_id: 'com.android.settings' });
assert.equal(open.data.ok, true, JSON.stringify(open.data));
const { data: obs } = await call('observe', { device_id });
console.log('elements:', obs.elements.length, 'framework:', obs.framework, 'quality:', obs.tree_quality);
console.log(obs.elements.slice(0, 8).map((e: any) => JSON.stringify(e)).join('\n'));
const target = obs.elements.find((e: any) => /Network|Connected devices|Apps/.test(e.text ?? '') && e.flags?.includes('clickable'));
assert.ok(target, 'no clickable settings row');
const label = target.text.split(' · ')[0];
const tap = await call('tap', { device_id, element_id: target.id, expect: { text_visible: label } });
console.log('tap result:', JSON.stringify(tap.data));
assert.equal(tap.data.ok, true);
assert.equal(tap.data.state_changed, true);

// Stale id: the old element id must not silently tap something on the new screen.
const stale = await call('tap', { device_id, element_id: obs.elements.at(-1).id });
console.log('old-id tap:', JSON.stringify(stale.data.error ?? stale.data.message));

const back = await call('press_key', { device_id, key: 'back', expect: { app: 'com.android.settings' } });
assert.equal(back.data.ok, true);
const bad = await call('tap', { device_id, element_id: 'o999:e1' });
assert.equal(bad.data.error.code, 'ELEMENT_NOT_FOUND');
console.log('SMOKE OK');
await c.close();
