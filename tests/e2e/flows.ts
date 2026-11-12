// Drives every mock real-world flow in the fixture app through Mobius.
// MOBIUS_TEST_APPROVAL=rejected → every consequential commit must be stopped (and nothing committed).
// MOBIUS_TEST_APPROVAL=approved → every flow must complete and verify its confirmation.
// Run: MOBIUS_TEST_APPROVAL=approved [MOBIUS_DEVICE=<id>] node tests/e2e/flows.ts [app_id] [flow,flow]
import { connect, runner } from './lib.ts';

const APP = process.argv[2] ?? 'dev.mobius.mobius_fixture';
const ONLY = process.argv[3]?.split(',');
const MODE = process.env.MOBIUS_TEST_APPROVAL;
if (MODE !== 'approved' && MODE !== 'rejected') throw new Error('set MOBIUS_TEST_APPROVAL=approved|rejected');
const { c, call } = await connect();
const { check, report } = runner();
const IOS = /^[0-9A-F-]{36}$/i.test(process.env.MOBIUS_DEVICE ?? '');

const VALUES: [RegExp, string][] = [
  [/email_to/, 'manager@example.com'], [/email_subject/, 'Leave'], [/email_body/, 'On leave tomorrow'],
  [/search dishes/i, 'biryani'], [/pickup/i, 'Koramangala'], [/^drop/i, 'Airport'], [/full name/i, 'Riya Sharma'],
  [/^email$/i, 'riya@example.com'], [/from station/i, 'SBC'], [/to station/i, 'MAS'], [/passenger/i, 'Riya'], [/^age/i, '29'],
  [/pnr/i, '4521367890'], [/^from$/i, 'Bengaluru'], [/^to$/i, 'Goa'], [/^date/i, '20 Nov'], [/city/i, 'Goa'], [/check-in/i, '20 Nov'],
  [/nights/i, '2'], [/search products/i, 'usb c cable'], [/mobile number/i, '9876543210'], [/upi id/i, 'riya@upi'], [/amount/i, '500'],
  [/upi pin/i, '1234'], [/^message/i, 'Running 10 min late'], [/^title/i, 'Dentist'], [/^time/i, '4 pm'], [/subject/i, 'Leave'],
  [/body/i, 'On leave tomorrow'], [/coupon/i, ''],
];
const EXPECT_APPROVAL: Record<string, boolean> = {
  food: true, grocery: true, cab: true, flight: true, train: true, pnr: false, bus: true, hotel: true, movie: true,
  shop: true, bills: true, money: true, chat: true, calendar: false, email: true,
};
const DONE: Record<string, RegExp> = {
  food: /Order placed ORD-/, grocery: /Order placed GRC-/, cab: /Driver Ramesh/, flight: /Booking confirmed/, train: /Ticket booked/,
  pnr: /PNR 4521367890: CNF/, bus: /Bus booked/, hotel: /Hotel booked/, movie: /Tickets booked/, shop: /Order placed SHP-/,
  bills: /Recharge successful/, money: /Paid ₹500/, chat: /Delivered to/, calendar: /Event saved: Dentist/, email: /Email sent/,
};
const FLOWS = Object.keys(DONE).filter(f => !ONLY || ONLY.includes(f));

const obs = async () => (await call('observe', {})).data;
const label = (e: any) => `${e.text ?? ''} ${e.label ?? ''}`.trim();
const byRid = (o: any, rid: string) => o.elements.find((e: any) => e.rid === rid);
const ACTIONS = /^(Search|See rides|Search flights|Continue|Search trains|Check status|Search buses|Search hotels|See plans|Submit|View cart)/;
const COMMITS = /^(Place order|Book ride|Pay\b|Book ticket|Book now|Buy now|Send|Save event)/;
const btn = (o: any, re: RegExp) => o.elements.filter((e: any) => e.role === 'button' && re.test(label(e))).at(-1);
const back = async () => {
  if (!IOS) return call('press_key', { key: 'back' });
  const o = await obs(); const b = o.elements.find((e: any) => /^Back\b/.test(label(e)));
  return b ? call('tap', { element_id: b.id }) : null;
};
async function home() {
  await call('open_app', { app_id: APP });
  for (let i = 0; i < 12; i++) {
    const o = await obs();
    if (o.foreground_app !== APP) { await call('open_app', { app_id: APP }); continue; } // Back left the app
    if (byRid(o, 'nav_services')) return o;
    const h = byRid(o, 'home'); if (h) { await call('tap', { element_id: h.id }); continue; }
    await back();
  }
  throw new Error('cannot reach home');
}

/** Scroll a list until an element with this resource id appears (like a real user would). */
async function scrollTo(rid: string) {
  for (let i = 0; i < 6; i++) {
    const o = await obs();
    const e = byRid(o, rid);
    if (e) return e;
    await call('scroll', { direction: 'down' });
  }
  throw new Error(`${rid} not found after scrolling`);
}

async function runFlow(flow: string): Promise<[boolean, string]> {
  const o0 = await home();
  await call('tap', { element_id: byRid(o0, 'nav_services').id });
  await call('tap', { element_id: (await scrollTo(`svc_${flow}`)).id });
  let o: any;
  const approvals: string[] = [];
  const log: string[] = [];
  for (let step = 0; step < 14; step++) {
    o = await obs();
    const status = o.elements.find((e: any) => /^Status:/.test(label(e)));
    if (status && DONE[flow]!.test(label(status))) {
      const leaked = flow === 'cab' && /OTP \d/.test(label(status));
      return [MODE === 'approved' && !leaked, `done: "${label(status).slice(8, 70)}" · ${log.join(' → ')}${leaked ? ' · OTP LEAKED' : ''}`];
    }
    // 1) form: fill empty editable fields, then press the action button
    const fields = o.elements.filter((e: any) => e.flags?.includes('editable'));
    const action = btn(o, ACTIONS);
    if (fields.length && action) {
      for (const f of fields) {
        if (f.text && f.text !== '[redacted]') continue;
        const v = VALUES.find(([re]) => re.test(f.rid ?? '') || re.test(f.label ?? ''))?.[1];
        if (!v) continue;
        const cur = (await obs()).elements.find((e: any) => e.rid === f.rid) ?? f;
        const r = (await call('type', { element_id: cur.id, text: v })).data;
        if (!r.ok) {
          if (r.error?.code === 'APPROVAL_REJECTED') return [MODE === 'rejected' && EXPECT_APPROVAL[flow] === true, `secret entry stopped at "${f.label}" · ${log.join(' → ')}`];
          return [false, `type ${f.label}: ${r.error?.code} ${r.error?.message}`];
        }
        if (cur.flags?.includes('sensitive')) approvals.push(`secret:${f.label}`);
      }
      if (IOS) { await call('swipe', { direction: 'down', distance: 100 }); } // dismiss keyboard
      o = await obs();
      const act = btn(o, ACTIONS) ?? action;
      const r = (await call('tap', { element_id: act.id })).data;
      log.push(`form→${label(act)}`);
      if (!r.ok) return [false, `action ${label(act)}: ${r.error?.code} ${r.error?.message}`];
      continue;
    }
    // 2) quantity picker
    const adds = o.elements.filter((e: any) => /^Add one /.test(label(e)));
    if (adds.length) {
      await call('tap', { element_id: adds[0].id });
      o = await obs(); const a2 = o.elements.filter((e: any) => /^Add one /.test(label(e)));
      await call('tap', { element_id: a2[Math.min(1, a2.length - 1)].id });
      o = await obs();
      const cart = btn(o, /^View cart/);
      const r = (await call('tap', { element_id: cart.id })).data;
      log.push(`qty→${label(cart)}`);
      if (!r.ok) return [false, `cart: ${r.error?.code}`];
      continue;
    }
    // 3) seats
    const free = o.elements.filter((e: any) => /^Seat \w+ available/.test(label(e)));
    if (free.length) {
      const need = /Select 2 seats/.test(JSON.stringify(o)) ? 2 : 1;
      for (let i = 0; i < need; i++) { o = await obs(); const f2 = o.elements.filter((e: any) => /^Seat \w+ available/.test(label(e))); await call('tap', { element_id: f2[0].id }); }
      o = await obs();
      const r = (await call('tap', { element_id: btn(o, /^Continue/).id })).data;
      log.push(`seats×${need}`);
      if (!r.ok) return [false, `seats: ${r.error?.code}`];
      continue;
    }
    // 4) confirm / commit
    const commit = btn(o, COMMITS);
    if (commit) {
      const r = (await call('tap', { element_id: commit.id })).data;
      log.push(`commit "${label(commit)}"`);
      if (r.error?.code === 'APPROVAL_REJECTED') {
        const after = await obs();
        const stillThere = !!btn(after, COMMITS);
        return [MODE === 'rejected' && EXPECT_APPROVAL[flow] === true && stillThere, `stopped at "${label(commit)}" (approval rejected, screen unchanged=${stillThere})`];
      }
      if (!r.ok) return [false, `commit: ${r.error?.code} ${r.error?.message}`];
      if (MODE === 'rejected' && EXPECT_APPROVAL[flow]) return [false, `"${label(commit)}" went through WITHOUT approval`];
      continue;
    }
    // 5) list: pick the cheapest priced option (or first)
    const opts = o.elements.filter((e: any) => e.flags?.includes('clickable') && e.role === 'button' && !/^(Back|Sort by)/.test(label(e)) && !/^(nav_|svc_|home|after_|sort_)/.test(e.rid ?? ''));
    if (opts.length) {
      const priced = opts.map((e: any) => ({ e, p: Number(/₹(\d+)/.exec(label(e))?.[1] ?? 'NaN') }));
      const pick = priced.filter(x => !isNaN(x.p) && x.p > 0).sort((a, b) => a.p - b.p)[0]?.e ?? opts[0];
      const r = (await call('tap', { element_id: pick.id })).data;
      log.push(`pick "${label(pick).split(/\n| · /)[0]}"`);
      if (!r.ok) return [false, `pick: ${r.error?.code}`];
      continue;
    }
    return [false, `stuck: ${o.elements.map(label).filter(Boolean).slice(0, 8).join(' | ')}`];
  }
  return [false, `too many steps · ${log.join(' → ')}`];
}

console.log(`mode=${MODE} device=${process.env.MOBIUS_DEVICE ?? 'default'}`);
for (const f of FLOWS) {
  if (MODE === 'rejected' && !EXPECT_APPROVAL[f]) {
    await check(`${f} (no approval needed)`, () => runFlow(f).then(([p, n]) => [n.startsWith('done') || p, n] as [boolean, string]));
  } else {
    await check(f, () => runFlow(f));
  }
}
await c.close();
process.exit(report() ? 1 : 0);
