// Regenerates README screenshots + the real Mobius JSON shown next to them.
// Drives the fixture app THROUGH Mobius on a (headless) Android emulator, captures with adb.
// Run: node tests/e2e/screenshots.ts <mobius-device-id> <adb-serial>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [DEVICE = 'Pixel_9_Pro', SERIAL = 'emulator-5556'] = process.argv.slice(2);
const APP = 'dev.mobius.mobius_fixture';
const OUT = 'docs/images';
mkdirSync(OUT, { recursive: true });
execFileSync('adb', ['-s', SERIAL, 'shell', 'am', 'force-stop', APP]); // clean app state

async function server(approval: 'approved' | 'rejected') {
  const c = new Client({ name: 'readme', version: '0' });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: ['packages/host/src/cli.ts', 'mcp'], stderr: 'ignore',
    env: { ...process.env, MOBIUS_DB: ':memory:', MOBIUS_TEST_APPROVAL: approval } as Record<string, string>,
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t0 = Date.now();
    const r: any = await c.callTool({ name, arguments: { device_id: DEVICE, ...args } }, undefined, { timeout: 180_000 });
    if (Date.now() - t0 > 8000) console.log(`slow ${name} ${JSON.stringify(args)} ${Date.now() - t0}ms`);
    return JSON.parse(r.content.find((x: any) => x.type === 'text').text);
  };
  return { c, call };
}

const shot = (name: string) => {
  const png = execFileSync('adb', ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 << 20 });
  writeFileSync(`${OUT}/${name}.png`, png);
  execFileSync('sips', ['-Z', '900', `${OUT}/${name}.png`], { stdio: 'ignore' });
};
const save = (name: string, data: unknown) => writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 2) + '\n');
const label = (e: any) => `${e.text ?? ''} ${e.label ?? ''} ${e.rid ?? ''}`.trim();

async function walk(call: (n: string, a?: Record<string, unknown>) => Promise<any>, steps: (RegExp | { type: RegExp; text: string })[]) {
  for (const s of steps) {
    let done = false;
    for (let i = 0; i < 7 && !done; i++) {
      const o = await call('observe');
      if (s instanceof RegExp) {
        const e = o.elements.find((x: any) => s.test(label(x)) && x.flags?.includes('clickable'));
        if (e) { await call('tap', { element_id: e.id }); done = true; continue; }
      } else {
        const e = o.elements.find((x: any) => s.type.test(label(x)) && x.flags?.includes('editable'));
        if (e) { await call('type', { element_id: e.id, text: s.text }); done = true; continue; }
      }
      // miss: re-check once (screen may be mid-transition), then search down, then up
      if (i === 0) continue;
      await call('scroll', { direction: i <= 3 ? 'down' : 'up' });
    }
  }
}

// Close the keyboard only if Mobius reports one; a stray Back would navigate away.
const closeKb = async (call: any) => { if ((await call('observe')).keyboard) await call('press_key', { key: 'back' }); };

const home = async (call: any) => {
  await call('open_app', { app_id: APP });
  for (let i = 0; i < 8; i++) {
    const o = await call('observe');
    if (o.elements.some((e: any) => e.rid === 'nav_services')) return;
    await call('press_key', { key: 'back' });
  }
};

// --- read-only + rejected-approval shots ---
const { c, call } = await server('rejected');
await home(call);
shot('01-home');
save('01-home.observe', await call('observe'));

await walk(call, [/nav_services/]);
shot('02-services');

await home(call);
await walk(call, [/nav_services/, /svc_food/, { type: /Search dishes/, text: 'biryani' }, /^Search\b/, /Paradise Biryani/, /Add one Chicken Biryani/, /View cart/, /^Continue/]);
await closeKb(call);
let o = await call('observe');
if (!o.elements.some((e: any) => /Place order/.test(label(e)))) { await walk(call, [/^Continue/]); o = await call('observe'); }
shot('03-food-checkout');
const place = o.elements.find((e: any) => /Place order/.test(label(e)));
save('03-food-place-order.rejected', await call('tap', { element_id: place.id }));

await home(call);
await walk(call, [/nav_injection/]);
shot('04-injection');
save('04-injection.observe', await call('observe'));

await home(call);
await walk(call, [/nav_services/, /svc_flight/, { type: /^\s*From/, text: 'BLR' }, { type: /^\s*To/, text: 'DEL' }, { type: /Date/, text: '20 Nov' }]);
await closeKb(call);
await walk(call, [/toggle_non-stop_only|Non-stop only/, /Search flights/]);
shot('05-flights-nonstop');
await c.close();

// --- approved: completed booking; the OTP is on the device but masked for the agent ---
const a = await server('approved');
await home(a.call);
await walk(a.call, [/nav_services/, /svc_cab/, { type: /Pickup/, text: 'Koramangala' }, { type: /^\s*Drop/, text: 'Airport' }]);
await closeKb(a.call);
await walk(a.call, [/See rides/, /^\s*Bike/]);
o = await a.call('observe');
const book = o.elements.find((e: any) => /Book ride/.test(label(e)));
save('06-cab-book.approved', await a.call('tap', { element_id: book.id }));
shot('06-cab-booked');
save('06-cab-booked.observe', await a.call('observe'));
await home(a.call);
await a.c.close();
console.log('screenshots written to', OUT);
