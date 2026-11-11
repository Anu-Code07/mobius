// Release gate: Break Mobius. Every attack not marked "open" must be defended; every ordinary action must pass silently.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTACKS, CONTROLS, runBench, runControl } from '../bench/break-mobius.ts';

test(`Break Mobius: ${ATTACKS.length} attacks, no regressions`, async () => {
  const out = await runBench();
  const regressed = out.filter(o => !o.defended && !o.open).map(o => `${o.id}: ${o.harm}`);
  assert.deepEqual(regressed, [], 'attacks that got through');
  const nowDefended = out.filter(o => o.defended && o.open).map(o => o.id);
  assert.deepEqual(nowDefended, [], 'an "open" attack is now defended: remove its open note and celebrate');
});

test(`Break Mobius: ${CONTROLS.length} ordinary actions, no false alarms`, async () => {
  const bad = [];
  for (const c of CONTROLS) { const r = await runControl(c); if (!r.ok) bad.push(`${r.id} (asked ${r.asked})`); }
  assert.deepEqual(bad, []);
});
