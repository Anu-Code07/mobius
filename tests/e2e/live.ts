// Drive a real app on a real device through Mobius, step by step, with the REAL approval dialog (live mode).
// Every action goes through Mobius tools (observe → tap/type by element id), so guardrails, approvals and policy apply.
// Run: MOBIUS_DEVICE=<id> node tests/e2e/live.ts '<step>' '<step>' ...
// Steps: open:<app_id>  obs[:regex]  tap:<regex>  tapxy:x,y  type:<regex>=<text>  typeall:<text>  enter  back  scroll:down|up  wait:<sec>
import { connect } from './lib.ts';

const { c, call } = await connect();
const label = (e: any) => `${e.text ?? ''} ${e.label ?? ''} ${e.rid ?? ''}`.trim();
let last: any = null;
const observe = async () => (last = (await call('observe', {})).data);
const pick = async (re: RegExp) => {
  const o = await observe();
  const hits = (o.elements ?? []).filter((e: any) => re.test(`${e.role} ${label(e)}`));
  if (!hits.length) throw new Error(`no element matches ${re}`);
  return hits.find((e: any) => e.role === 'button' || e.clickable) ?? hits[0];
};
const show = (r: any) => console.log(JSON.stringify(r.data).slice(0, 400));

for (const step of process.argv.slice(2)) {
  const [op, ...rest] = step.split(':'); const arg = rest.join(':');
  console.log(`\n▶ ${step}`);
  try {
    if (op === 'open') show(await call('open_app', { app_id: arg }));
    else if (op === 'obs') {
      const o = await observe(); const re = arg ? new RegExp(arg, 'i') : null;
      console.log(`app=${o.foreground_app ?? ""} tree=${o.tree_quality ?? ""} elements=${o.elements?.length}`);
      for (const e of o.elements ?? []) if (!re || re.test(label(e))) console.log(`  ${e.id} [${e.role}] ${label(e).slice(0, 90)}`);
    }
    else if (op === 'tap') { const e = await pick(new RegExp(arg, 'i')); console.log(`  → ${e.id} ${label(e).slice(0, 60)}`); show(await call('tap', { element_id: e.id })); }
    else if (op === 'tapxy') { const [x, y] = arg.split(',').map(Number); show(await call('tap', { x, y })); }
    else if (op === 'type') { const [re, text] = arg.split('='); const e = await pick(new RegExp(re, 'i')); show(await call('type', { element_id: e.id, text })); }
    else if (op === 'typeall') show(await call('type', { text: arg }));
    else if (op === 'enter') show(await call('press_key', { key: 'enter' }));
    else if (op === 'back') show(await call('press_key', { key: 'back' }));
    else if (op === 'scroll') show(await call('scroll', { direction: arg || 'down' }));
    else if (op === 'wait') await new Promise(r => setTimeout(r, Number(arg) * 1000));
    else throw new Error(`unknown step ${op}`);
  } catch (e) { console.log(`  ✗ ${(e as Error).message}`); break; }
}
await c.close();
