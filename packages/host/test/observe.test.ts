import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { RawNode, RawScreen } from '../src/execution/connector.ts';
import { toRawNode } from '../src/execution/drivers/nodes.ts';
import { buildObservation, ObservationStore, scrub } from '../src/execution/observe.ts';

function screen(): RawScreen {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/checkout.raw.json', import.meta.url), 'utf8'));
  const root: RawNode = { cls: 'hierarchy', pkg: '', text: '', desc: '', resourceId: '', clickable: false, longClickable: false,
    enabled: true, focused: false, scrollable: false, checkable: false, checked: false, selected: false, password: false,
    bounds: { x: 0, y: 0, width: 1080, height: 2400 }, path: 'r', children: [] };
  raw.hierarchy.forEach((w: any, i: number) => { const n = toRawNode(w, `r.${i}`); if (n) root.children.push(n); });
  return { root, width: 1080, height: 2400, rotation: 0, foregroundApp: 'com.example.shop' };
}

const build = (store: ObservationStore) => {
  const { obs, fps } = buildObservation(screen(), 'dev1', 'android', store.nextId(), 'flutter');
  store.add(obs, fps);
  return obs;
};

test('hides status bar, redacts secrets, folds row text, drops invisible nodes', () => {
  const obs = build(new ObservationStore());
  const all = JSON.stringify(obs);
  assert.ok(!all.includes('482913'), 'notification OTP must not leak');
  assert.ok(!all.includes('4111 1111'), 'card number must be redacted');
  assert.ok(!all.includes('1234'), 'PIN field value must be redacted');
  assert.ok(!all.includes('Offscreen'));
  const pin = obs.elements.find(e => e.label === 'Enter UPI PIN')!;
  assert.equal(pin.sensitive, true);
  assert.equal(pin.text, '[redacted]');
  const coupon = obs.elements.find(e => e.label === 'Coupon code')!;
  assert.equal(coupon.sensitive, false);
  assert.equal(coupon.editable, true);
  const row = obs.elements.find(e => e.role === 'button' && e.text?.startsWith('Saved card'))!;
  assert.equal(row.text, 'Saved card · [redacted]', 'clickable row absorbs child text with the card number masked');
  assert.equal(obs.elements.filter(e => e.text === 'Saved card').length, 0, 'child text folded into the row, not repeated');
  assert.equal(obs.elements.find(e => e.text === 'Pay now')!.enabled, false);
});

test('duplicate text gets dup_index; resolve handles stale, ambiguous and re-render', () => {
  const store = new ObservationStore();
  const first = build(store);
  const oks = first.elements.filter(e => e.text === 'OK');
  assert.deepEqual(oks.map(e => e.dup_index), [0, 1]);
  assert.equal(store.resolve(oks[0]!.id).id, oks[0]!.id);

  const second = build(store); // identical re-render → new ids
  const checkoutOld = first.elements.find(e => e.text === 'Checkout')!;
  assert.equal(store.resolve(checkoutOld.id).id, second.elements.find(e => e.text === 'Checkout')!.id, 'unique match survives re-render');
  assert.throws(() => store.resolve(oks[0]!.id), (e: any) => e.code === 'AMBIGUOUS_TARGET', 'two OKs, no resource id → ambiguous');
  assert.throws(() => store.resolve('o42:e1'), (e: any) => e.code === 'ELEMENT_NOT_FOUND');

  // Same two OKs, but one scrolled far off-screen: the visible one is the target.
  const third = build(store);
  third.elements.filter(e => e.text === 'OK')[1]!.bounds = { x: 24, y: -8517, width: 77, height: 106 };
  assert.equal(store.resolve(oks[0]!.id).id, third.elements.filter(e => e.text === 'OK')[0]!.id);
});

test('screen hash is stable for the same screen', () => {
  const store = new ObservationStore();
  assert.equal(build(store).screen_hash, build(store).screen_hash);
});

test('scrub masks cards and OTP codes inside longer text', async () => {
  const { scrub } = await import('../src/execution/observe.ts');
  assert.equal(scrub('Your OTP is 482913. Do not share it.'), 'Your OTP is [redacted]. Do not share it.');
  assert.equal(scrub('Saved card\n4111 1111 1111 1111'), 'Saved card\n[redacted]');
  assert.equal(scrub('Order #12345 shipped'), 'Order #12345 shipped', 'ordinary numbers untouched');
});

test('secret-field detection uses whole words (no "Passenger" false positive)', async () => {
  const { toRawNode } = await import('../src/execution/drivers/nodes.ts');
  const field = (hint: string) => toRawNode({ class: 'android.widget.EditText', editable: true, hint, visible: true, rect: { x: 0, y: 0, width: 10, height: 10 } }, 'r')!;
  assert.equal(field('Passenger name').password, false);
  assert.equal(field('Password').password, true);
  assert.equal(field('Enter UPI PIN').password, true);
  assert.equal(field('One-time code').password, true);
});

test('tap point of an element partly above the screen stays on screen', async () => {
  const { center } = await import('../src/execution/session.ts');
  const p = center({ bounds: { x: 10, y: -40, width: 60, height: 60 } } as any);
  assert.ok(p.y >= 0 && p.y <= 20, `y=${p.y}`);
});

test('element ids survive a Mobius restart (identity hashes on disk, no screen text)', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'mobius-ids-'));
  process.env.MOBIUS_HOME = home;
  try {
    const first = new ObservationStore('dev1');
    const { obs, fps } = buildObservation(screen(), 'dev1', 'android', first.nextId(), 'flutter');
    first.add(obs, fps);
    const checkout = obs.elements.find(e => e.text === 'Checkout')!;
    const file = readFileSync(join(home, 'obs', 'dev1.json'), 'utf8');
    assert.ok(!file.includes('Checkout'), 'no screen text on disk');

    const second = new ObservationStore('dev1'); // a new process
    const again = buildObservation(screen(), 'dev1', 'android', second.nextId(), 'flutter');
    assert.notEqual(again.obs.observation_id, obs.observation_id, 'ids keep counting, never collide');
    second.add(again.obs, again.fps);
    assert.equal(second.resolve(checkout.id).text, 'Checkout');
    const ok = obs.elements.find(e => e.text === 'OK')!;
    assert.throws(() => second.resolve(ok.id), (e: any) => e.code === 'AMBIGUOUS_TARGET', 'same ambiguity rules as within a process');
  } finally { rmSync(home, { recursive: true }); delete process.env.MOBIUS_HOME; }
});

test('tapping a big card avoids the clickable item drawn at its center', async () => {
  const { center } = await import('../src/execution/session.ts');
  const el = (id: string, x: number, y: number, w: number, h: number, clickable = true) => ({ id, bounds: { x, y, width: w, height: h }, clickable, editable: false }) as any;
  const card = el('c', 0, 478, 393, 422);
  const burger = el('b', 150, 600, 150, 233); // covers the card's center (196.5, 689)
  const p = center(card, [card, burger]);
  assert.ok(!(p.x >= 150 && p.x <= 300 && p.y >= 600 && p.y <= 833), `tap point ${JSON.stringify(p)} hits the burger`);
  assert.ok(p.y >= 478 && p.y <= 900, 'still inside the card');
  assert.deepEqual(center(card), { x: 196.5, y: 689 }, 'no screen given: plain center');
});

test('ids from the agent\'s observe survive the polls of a slow action (settle/verify)', () => {
  const store = new ObservationStore();
  const seen = build(store);
  for (let i = 0; i < 30; i++) build(store); // ~3 s of 100 ms settle/verify polls
  const el = seen.elements.find(e => e.clickable)!;
  assert.equal(store.resolve(el.id).text, el.text);
});

test('tap point: clipped to the screen, off floating bars, refused when covered or off screen', async () => {
  const { center } = await import('../src/execution/session.ts');
  const el = (id: string, x: number, y: number, w: number, h: number, more: any = {}) => ({ id, role: 'button', clickable: true, bounds: { x, y, width: w, height: h }, ...more }) as any;
  const size = { width: 393, height: 852 };
  // Row half below the screen, its visible strip under the floating search toolbar (iOS 26 Settings).
  const general = el('e26', 16, 836, 361, 57), vpn = el('e24', 16, 745, 361, 57);
  const toolbar = el('e36', 0, 766, 393, 86, { role: 'view', clickable: false, label: 'Toolbar' });
  const search = el('e37', 32, 781, 328, 38, { role: 'textbox', editable: true });
  const screen = [vpn, general, toolbar, search];
  assert.throws(() => center(general, screen, size), /covered|off screen/);
  const p = center(vpn, screen, size); // partly under the toolbar: tap its uncovered top
  assert.ok(p.y >= 745 && p.y < 766, `y=${p.y}`);
  assert.throws(() => center(el('e9', 16, 900, 361, 57), screen, size), /off screen/);
  const q = center(el('e1', 300, 10, 200, 40), [], size); // wider than the screen: center of the visible part
  assert.ok(q.x <= 393 && q.x >= 300, `x=${q.x}`);
});

test('scrub: OTP after the code word and before it ("482913 is your OTP"); amounts are left alone', () => {
  for (const t of ['482913 is your OTP for login', 'Your code is 482913', '4829 is the verification code']) assert.doesNotMatch(scrub(t), /\d{4}/, t);
  for (const t of ['Pay ₹1499 · Enter UPI PIN', 'Total ₹349', 'PNR 4521367890']) assert.equal(scrub(t), t, t);
});

test('tap point: the keyboard covers what is under it; a center under an overlay is refused, not tapped', async () => {
  const { center } = await import('../src/execution/session.ts');
  const el = (id: string, x: number, y: number, w: number, h: number, more: any = {}) => ({ id, role: 'button', clickable: true, bounds: { x, y, width: w, height: h }, ...more }) as any;
  const size = { width: 1080, height: 2400 };
  const cont = el('e1', 0, 1700, 1080, 150);
  assert.throws(() => center(cont, [cont], size, { x: 0, y: 1600, width: 1080, height: 800 }), /keyboard/);
  // A floating action button over the middle of a row: some corners are free, but the row's middle is covered.
  const row = el('e2', 0, 500, 1080, 200), fab = el('e3', 340, 450, 400, 300);
  const p = center(row, [row, fab], size);
  assert.ok(!(p.x >= 340 && p.x <= 740 && p.y >= 450 && p.y <= 750), `tap avoided the FAB: ${p.x},${p.y}`);
});

test('the observation shown to the agent is never evicted by internal polls', () => {
  const store = new ObservationStore();
  const seen = build(store);
  store.shown = seen.observation_id;
  for (let i = 0; i < 200; i++) build(store);
  const el = seen.elements.find(e => e.clickable)!;
  assert.equal(store.resolve(el.id).text, el.text);
});

test('keyboard area is the keys, not a full-screen transparent IME window (Android 15 edge-to-edge)', () => {
  const node = (resourceId: string, x: number, y: number, w: number, h: number, children: RawNode[] = []): RawNode => ({ cls: 'android.widget.FrameLayout', pkg: '', text: '', desc: '', resourceId,
    clickable: false, longClickable: false, enabled: true, focused: false, scrollable: false, checkable: false, checked: false, selected: false, password: false,
    bounds: { x, y, width: w, height: h }, path: 'r', children });
  const s = screen();
  s.root!.children.push(node('com.google.android.inputmethod.latin:id/root', 0, 63, 1080, 1794, [node('', 0, 1088, 1080, 748)]));
  const { obs } = buildObservation(s, 'dev1', 'android', 'o1', 'native');
  assert.deepEqual(obs.keyboard, { x: 0, y: 1088, width: 1080, height: 748 });
});

test('nested same-box wrappers resolve as one control; separate look-alikes stay ambiguous', () => {
  const node = (label: string, x: number, y: number, w: number, h: number, children: RawNode[] = []): RawNode => ({ cls: 'Other', pkg: '', text: '', desc: label, resourceId: '',
    clickable: true, longClickable: false, enabled: true, focused: false, scrollable: false, checkable: false, checked: false, selected: false, password: false,
    bounds: { x, y, width: w, height: h }, path: 'r', children });
  const shot = (kids: RawNode[]): RawScreen => ({ root: node('', 0, 0, 393, 852, kids), width: 393, height: 852, rotation: 0, foregroundApp: 'com.myntra.Myntra' });
  const store = new ObservationStore();
  const nested = () => shot([node('HPSearchBar', 12, 91, 238, 40, [node('HPSearchBar', 12, 91, 230, 40)])]);
  const a = buildObservation(nested(), 'd', 'ios', store.nextId(), 'native'); store.add(a.obs, a.fps);
  const id = a.obs.elements.filter(e => e.label === 'HPSearchBar').at(-1)!.id;
  const b = buildObservation(nested(), 'd', 'ios', store.nextId(), 'native'); store.add(b.obs, b.fps);
  assert.equal(store.resolve(id).label, 'HPSearchBar');

  const store2 = new ObservationStore();
  const apart = () => shot([node('Buy', 10, 100, 100, 40), node('Buy', 10, 600, 100, 40)]);
  const c = buildObservation(apart(), 'd', 'ios', store2.nextId(), 'native'); store2.add(c.obs, c.fps);
  const id2 = c.obs.elements.find(e => e.label === 'Buy')!.id;
  const d = buildObservation(apart(), 'd', 'ios', store2.nextId(), 'native'); store2.add(d.obs, d.fps);
  assert.throws(() => store2.resolve(id2), /AMBIGUOUS|matches 2/);
});
