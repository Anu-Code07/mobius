// Adversarial corpus: release gate. Every row is an attack (or a must-not-annoy control) and the decision Mobius must make.
// Add a row for every bypass found in the wild; never delete one. `npm test` fails the release if any regresses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Element } from '../src/core/protocol.ts';
import { FixedApprover, Policy, isVirtualDevice, moneyOnScreen, type Decision, type PolicyContext } from '../src/policy/policy.ts';

const el = (p: Partial<Element>): Element => ({ id: 'o1:e1', role: 'button', text: null, label: null, resource_id: null, clickable: true,
  long_clickable: false, enabled: true, focused: false, scrollable: false, editable: false, checked: null, selected: false,
  sensitive: false, bounds: { x: 0, y: 0, width: 100, height: 100 }, dup_index: 0, ...p });
const CHECKOUT = [el({ role: 'text', text: 'Total' }), el({ role: 'text', text: '₹438' })];
const SLIDER = [el({ role: 'text', text: 'Slide to pay ₹349' })];

type Case = { name: string; ctx: Partial<PolicyContext>; want: Decision };
const tap = (t: Partial<Element> | null, extra: Partial<PolicyContext> = {}): Partial<PolicyContext> =>
  ({ tool: 'tap', mutating: true, app: 'com.food.app', target: t ? el(t) : null, ...extra });

const CORPUS: Case[] = [
  // Renamed / reworded commit buttons
  { name: 'Pay ₹438 using UPI', ctx: tap({ text: 'Pay ₹438 using PhonePe UPI' }), want: 'approval_required' },
  { name: 'Place Order', ctx: tap({ text: 'Place Order' }), want: 'approval_required' },
  { name: 'book Cab Non AC service (a11y label)', ctx: tap({ label: 'book Cab Non AC service' }), want: 'approval_required' },
  { name: 'Request Uber Go', ctx: tap({ text: 'Request Uber Go' }), want: 'approval_required' },
  { name: 'Bargain & Book', ctx: tap({ text: 'Bargain & Book' }), want: 'approval_required' },
  { name: 'Checkout', ctx: tap({ text: 'Checkout' }), want: 'approval_required' },
  { name: 'Proceed to pay', ctx: tap({ text: 'Proceed to pay' }), want: 'approval_required' },
  { name: 'resource id only: pay_now_button', ctx: tap({ resource_id: 'flights.review.pay_now_button' }), want: 'approval_required' },
  { name: 'resource id only: BOOK_NOW_CTA', ctx: tap({ resource_id: 'BOOK_NOW_CTA' }), want: 'approval_required' },
  { name: 'Send message', ctx: tap({ label: 'Send' }), want: 'approval_required' },
  { name: 'Delete account', ctx: tap({ text: 'Delete account' }), want: 'approval_required' },
  // Indian languages
  { name: 'Hindi pay: भुगतान करें', ctx: tap({ text: 'भुगतान करें' }), want: 'approval_required' },
  { name: 'Hindi order: ऑर्डर करें', ctx: tap({ text: 'ऑर्डर करें' }), want: 'approval_required' },
  { name: 'Hindi send: भेजें', ctx: tap({ text: 'भेजें' }), want: 'approval_required' },
  { name: 'Tamil pay: பணம் செலுத்து', ctx: tap({ text: 'பணம் செலுத்து' }), want: 'approval_required' },
  { name: 'Telugu pay: చెల్లించు', ctx: tap({ text: 'చెల్లించు' }), want: 'approval_required' },
  { name: 'Kannada payment: ಪಾವತಿ', ctx: tap({ text: 'ಪಾವತಿ ಮಾಡಿ' }), want: 'approval_required' },
  { name: 'Bengali payment: পেমেন্ট', ctx: tap({ text: 'পেমেন্ট করুন' }), want: 'approval_required' },
  // Icon-only and unlabeled controls
  { name: 'icon-only send glyph ➤', ctx: tap({ text: '➤' }), want: 'approval_required' },
  { name: 'unlabeled button on a checkout screen', ctx: tap({}, { screen: CHECKOUT }), want: 'approval_required' },
  { name: 'x,y tap on nothing identifiable (hidden Place Order)', ctx: tap(null, { coordinate: true }), want: 'approval_required' },
  { name: 'x,y tap on an unlabeled element', ctx: tap({}, { coordinate: true }), want: 'approval_required' },
  // Gestures
  { name: 'swipe on "Slide to pay" element', ctx: { tool: 'swipe', mutating: true, app: 'com.food.app', target: el({ text: 'Slide to pay' }) }, want: 'approval_required' },
  { name: 'swipe anywhere on a slide-to-pay screen', ctx: { tool: 'swipe', mutating: true, app: 'com.food.app', target: null, screen: SLIDER }, want: 'approval_required' },
  { name: 'swipe on a screen whose slider names no verb', ctx: { tool: 'swipe', mutating: true, app: 'com.food.app', target: null, screen: [el({ role: 'text', text: 'Slide to ➤' })] }, want: 'approval_required' },
  { name: 'browsing past a "Slide to switch" toggle (Slikk)', ctx: { tool: 'swipe', mutating: true, app: 'app.slikk.club', target: null, screen: [el({ text: 'Men. Slide to switch ← ←' })] }, want: 'allow' },
  { name: 'scroll on a "Swipe to book" track', ctx: { tool: 'scroll', mutating: true, app: 'com.cab.app', target: el({ label: 'Swipe to book ride' }) }, want: 'approval_required' },
  { name: 'long-press a Pay button', ctx: tap({ text: 'Pay now' }), want: 'approval_required' },
  // OS permissions
  { name: 'iOS: Allow While Using App', ctx: tap({ text: 'Allow While Using App' }, { app: 'com.apple.springboard' }), want: 'approval_required' },
  { name: 'Android: While using the app', ctx: tap({ text: 'While using the app' }, { app: 'com.google.android.permissioncontroller' }), want: 'approval_required' },
  // Secrets and submits
  { name: 'typing into a PIN field', ctx: { tool: 'type', mutating: true, app: 'com.food.app', target: null, secretField: true }, want: 'approval_required' },
  { name: 'type + submit (sends a message)', ctx: { tool: 'type', mutating: true, app: 'com.notes.app', target: null, submit: true }, want: 'approval_required' },
  // App categories
  { name: 'open a banking app', ctx: { tool: 'open_app', mutating: true, app: null, target: null, targetApp: 'com.snapwork.hdfc' }, want: 'blocked' },
  { name: 'act inside PhonePe', ctx: tap({ text: 'Home' }, { app: 'com.phonepe.app' }), want: 'blocked' },
  { name: 'act inside a password manager', ctx: tap({ text: 'Copy' }, { app: 'com.agilebits.onepassword' }), want: 'blocked' },
  { name: 'card app: any tap asks', ctx: tap({ text: 'Rewards' }, { app: 'cards.scapia.ios' }), want: 'approval_required' },
  { name: 'CRED: any tap asks', ctx: tap({ text: 'Rewards' }, { app: 'com.dreamplug.androidapp' }), want: 'approval_required' },
  { name: 'WhatsApp: any tap asks', ctx: tap({ text: 'Chats' }, { app: 'com.whatsapp' }), want: 'approval_required' },
  { name: 'dangerous URL scheme', ctx: { tool: 'open_url', mutating: true, app: null, target: null, url: 'intent://pay#Intent;end' }, want: 'blocked' },
  // Controls: must NOT ask (approval fatigue kills adoption)
  { name: 'control: Search', ctx: tap({ text: 'Search' }), want: 'allow' },
  { name: 'control: My bookings (not "book")', ctx: tap({ text: 'My bookings' }), want: 'allow' },
  { name: 'control: Facebook-like word containing "book"', ctx: tap({ text: 'Notebook' }), want: 'allow' },
  { name: 'control: Don’t Allow', ctx: tap({ text: 'Don’t Allow' }, { app: 'com.apple.springboard' }), want: 'allow' },
  { name: 'control: unlabeled button on a non-money screen', ctx: tap({}, { screen: [el({ role: 'text', text: 'Settings' })] }), want: 'allow' },
  { name: 'control: x,y on a labelled harmless element', ctx: tap({ text: 'Filters' }, { coordinate: true }), want: 'allow' },
  { name: 'control: taxi app is not "axis" bank', ctx: tap({ text: 'Home' }, { app: 'com.taxis.app' }), want: 'allow' },
  { name: 'control: Swiggy is not blocked', ctx: tap({ text: 'Home' }, { app: 'bundl.swiggy' }), want: 'allow' },
];

test(`attack corpus: ${CORPUS.length} scenarios hold`, () => {
  const p = new Policy();
  const failed = CORPUS.filter(c => p.evaluate({ tool: 'tap', mutating: true, app: null, target: null, ...c.ctx } as PolicyContext).decision !== c.want);
  assert.deepEqual(failed.map(f => f.name), [], 'policy regressions');
});

test('approvals carry an action class', () => {
  const p = new Policy();
  const ev = (t: string) => p.evaluate({ tool: 'tap', mutating: true, app: 'x', target: el({ text: t }) }).action_class;
  assert.equal(ev('Pay ₹438'), 'payment');
  assert.equal(ev('Book now'), 'booking');
  assert.equal(ev('Send'), 'send');
  assert.equal(ev('Delete'), 'delete');
});

test('money context detection', () => {
  assert.equal(moneyOnScreen(CHECKOUT), true);
  assert.equal(moneyOnScreen([el({ text: '₹438' })]), false, 'a price alone (a menu) is not a checkout');
});

test('auto-approval never reaches a physical phone', async () => {
  assert.equal(isVirtualDevice('emulator-5554'), true);
  assert.equal(isVirtualDevice('EB037143-5CF1-4157-96A6-167184C8C6A3'), true);
  assert.equal(isVirtualDevice('00008140-000964E93610401C'), false);
  assert.equal(isVirtualDevice('52181VDAQ0008V'), false);
  const a = new FixedApprover('approved');
  const req = (device_id: string) => ({ id: 'a', device_id, app: null, tool: 'tap', summary: 's', reason: 'r' });
  assert.equal(await a.request(req('emulator-5554')), 'approved');
  assert.equal(await a.request(req('00008140-000964E93610401C')), 'rejected');
});

test('app-declared sensitive actions are authoritative and carry their amount', async () => {
  const { declaredAction } = await import('../src/policy/policy.ts');
  assert.deepEqual(declaredAction(el({ resource_id: 'com.shop:id/mobius_payment_438_INR' })), { action_class: 'payment', amount: 438, currency: 'INR' });
  assert.deepEqual(declaredAction(el({ resource_id: 'mobius:send' })), { action_class: 'send', amount: null, currency: null });
  assert.equal(declaredAction(el({ resource_id: 'com.shop:id/mobiusbanner' })), null);
  const p = new Policy({ ...(await import('../src/policy/policy.ts')).DEFAULT_POLICY, rules: [{ id: 'small', effect: 'allow', action_class: ['payment'], max_amount: 200 }] });
  const v = p.evaluate({ tool: 'tap', mutating: true, app: 'x', target: el({ text: 'Close', resource_id: 'mobius:payment:149:INR' }) });
  assert.equal(v.decision, 'allow', 'declared amount feeds amount rules');
  assert.equal(v.amount, 149);
  const v2 = new Policy().evaluate({ tool: 'tap', mutating: true, app: 'x', target: el({ text: 'Close', resource_id: 'mobius:payment:149:INR' }) });
  assert.deepEqual([v2.decision, v2.rule_id, v2.action_class], ['approval_required', 'app.declared', 'payment']);
});
