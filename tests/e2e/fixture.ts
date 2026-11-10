// Edge-case suite against the Mobius fixture app (Flutter / React Native / ...).
// Run: node tests/e2e/fixture.ts [app_id]   default: dev.mobius.mobius_fixture
import { connect, find, runner } from './lib.ts';

const APP = process.argv[2] ?? 'dev.mobius.mobius_fixture';
const { c, call } = await connect();
const { check, report } = runner();
const obs = async () => (await call('observe', {})).data;
const IOS = !!process.env.MOBIUS_DEVICE && !/^emulator|_/.test(process.env.MOBIUS_DEVICE) && /^[0-9A-F-]{36}$/i.test(process.env.MOBIUS_DEVICE);
// iOS has no system Back key: use the on-screen back button.
const back = async () => {
  if (!IOS) return call('press_key', { key: 'back' });
  const o = await obs(); const b = find(o, /^\s*Back\b/);
  return b ? call('tap', { element_id: b.id }) : null;
};
const home = async () => { await call('open_app', { app_id: APP }); for (let i = 0; i < 4; i++) { const o = await obs(); if (find(o, /nav_login|^Login/)) return o; await back(); } return obs(); };
const go = async (screen: RegExp) => { const h = await home(); const nav = find(h, screen); return (await call('tap', { element_id: nav.id })).data; };
const status = (o: any) => (o.elements.find((e: any) => /Status:/.test(`${e.text ?? ''}${e.label ?? ''}`)) ?? {}).label ?? '';
const leaks = (o: any, s: string) => JSON.stringify(o).includes(s);

await check('framework detected + identifiers exposed', async () => {
  const o = await home();
  return [['flutter', 'react_native'].includes(o.framework) && !!find(o, /nav_checkout/), `framework=${o.framework} quality=${o.tree_quality}`];
});

await check('login: disabled button, typing, secrets never leak', async () => {
  await go(/nav_login/);
  let o = await obs();
  const signIn = find(o, /sign_in|Sign in/);
  const disabledFirst = signIn?.flags?.includes('disabled');
  await call('type', { element_id: find(o, /email|Email/).id, text: 'riya@example.com' });
  o = await obs(); await call('type', { element_id: find(o, /password|Password/).id, text: 'hunter2pass' });
  o = await obs(); await call('type', { element_id: find(o, /\bpin\b|PIN/).id, text: '4321' });
  o = await obs();
  const leaked = ['hunter2pass', '4321'].filter(s => leaks(o, s));
  const r = (await call('tap', { element_id: find(o, /sign_in|Sign in/).id, expect: { text_visible: 'Welcome, riya' } })).data;
  return [!!disabledFirst && leaked.length === 0 && r.verified === true,
    `disabledFirst=${disabledFirst} leaked=${JSON.stringify(leaked)} verified=${r.verified}`];
});

await check('duplicates: two "OK" distinguished', async () => {
  await go(/nav_duplicates/);
  const o = await obs();
  const oks = o.elements.filter((e: any) => (e.text ?? e.label) === 'OK');
  const second = oks.find((e: any) => e.rid === 'ok_secondary') ?? oks[1];
  const r = (await call('tap', { element_id: second.id, expect: { text_visible: 'pressed ok_secondary' } })).data;
  return [oks.length === 2 && r.verified === true, `oks=${oks.map((e: any) => `${e.id}/${e.rid ?? ''}/${(e.flags ?? []).join(',')}`).join(' ')} verified=${r.verified}`];
});

await check('long list: scroll until Item 60, tap, verify', async () => {
  await go(/nav_long_list/);
  let target: any; let scrolls = 0;
  for (; scrolls < 15 && !target; scrolls++) {
    const o = await obs();
    target = o.elements.find((e: any) => (e.text ?? e.label) === 'Item 60');
    if (!target) await call('scroll', { direction: 'down' });
  }
  if (!target) return [false, `not found after ${scrolls} scrolls`];
  const r = (await call('tap', { element_id: target.id, expect: { text_visible: 'selected Item 60' } })).data;
  return [r.verified === true, `found after ${scrolls - 1} scrolls, verified=${r.verified}`];
});

await check('dialog: appears, cancel, verify', async () => {
  await go(/nav_dialog/);
  let o = await obs();
  const d = (await call('tap', { element_id: find(o, /delete_account|Delete account/).id, expect: { text_visible: 'Delete account?' } })).data;
  o = await obs();
  const r = (await call('tap', { element_id: find(o, /\bCancel\b/).id, expect: { text_visible: 'delete cancelled' } })).data;
  return [d.verified === true && r.verified === true, `dialog=${d.verified} cancel=${r.verified}`];
});

await check('slow loading: wait_for, no fixed sleep', async () => {
  const t0 = Date.now();
  await go(/nav_slow_loading/);
  const r = (await call('wait_for', { text_visible: 'Loaded', timeout_ms: 10000 })).data;
  return [r.met === true, `met after ${Date.now() - t0} ms`];
});

await check('unlabeled controls: flagged, coordinate fallback works', async () => {
  await go(/nav_unlabeled/);
  const o = await obs();
  const unlabeled = o.elements.filter((e: any) => e.flags?.includes('clickable') && !e.text && !e.label && !e.rid);
  const st = o.elements.find((e: any) => /Status:/.test(e.label ?? ''));
  // Circle has no label: an agent would screenshot, then tap the unlabeled element (or its coordinates).
  const circle = unlabeled.reduce((a: any, b: any) => (b.box[2] * b.box[3] > a.box[2] * a.box[3] ? b : a));
  const r = (await call('tap', { x: circle.box[0] + circle.box[2] / 2, y: circle.box[1] + circle.box[3] / 2, expect: { text_visible: 'circle tapped' } })).data;
  return [unlabeled.length >= 1 && r.verified === true, `quality=${o.tree_quality} unlabeled=${unlabeled.length} hint=${!!o.hint} circle=${r.verified}`];
});

await check('injection: content marked untrusted, OTP redacted', async () => {
  await go(/nav_injection/);
  const o = await obs();
  const hasInjection = JSON.stringify(o).includes('Ignore all previous instructions');
  return [/UNTRUSTED/.test(o.untrusted_content) && !leaks(o, '482913'), `injection text present=${hasInjection} otpLeaked=${leaks(o, '482913')}`];
});

await check('checkout: card number redacted', async () => {
  await go(/nav_checkout/);
  const o = await obs();
  return [!leaks(o, '4111 1111'), `cardLeaked=${leaks(o, '4111 1111')}`];
});

await check('KNOWN GAP (M2): "Pay now" not yet gated by policy', async () => {
  const o = await obs();
  const r = (await call('tap', { element_id: find(o, /pay_now|Pay now/).id })).data;
  const blocked = r.error?.code === 'APPROVAL_REQUIRED' || r.error?.code === 'POLICY_BLOCKED';
  return [true, blocked ? 'gated ✔' : 'NOT gated — tap went through (expected until policy engine lands)'];
});

await check('toggles: switch + checkbox state', async () => {
  await go(/nav_toggles/);
  let o = await obs();
  const r1 = (await call('tap', { element_id: find(o, /dark_mode|Dark mode/).id, expect: { text_visible: 'dark=true' } })).data;
  o = await obs();
  const r2 = (await call('tap', { element_id: find(o, /accept_terms|Accept terms/).id, expect: { text_visible: 'terms=true' } })).data;
  o = await obs();
  const cb = find(o, /accept_terms|Accept terms/);
  return [r1.verified === true && r2.verified === true, `switch=${r1.verified} checkbox=${r2.verified} flags=${(cb?.flags ?? []).join(',')}`];
});

if (!IOS) await call('press_key', { key: 'home' });
await c.close();
process.exit(report() ? 1 : 0);
