// The spec (docs/spec) and the implementation must agree: schemas parse, real records and the example policy fit them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../src/observability/audit.ts';
import { DEFAULT_POLICY } from '../src/policy/policy.ts';

const spec = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'spec', f), 'utf8'));

test('policy: every implemented field is in the schema, and the example policy fits it', () => {
  const s = spec('policy.schema.json');
  for (const k of Object.keys(DEFAULT_POLICY)) assert.ok(k in s.properties, `schema is missing policy field ${k}`);
  const example = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'policy.example.json'), 'utf8'));
  for (const k of Object.keys(example)) assert.ok(k in s.properties, `example uses unknown field ${k}`);
  const ruleProps = s.$defs.rule.properties;
  for (const r of example.rules) {
    for (const k of Object.keys(r)) assert.ok(k in ruleProps, `rule ${r.id} uses unknown field ${k}`);
    assert.ok(s.$defs.decision.enum.includes(r.effect));
  }
});

test('audit: a real record has exactly the schema fields', () => {
  const a = new AuditLog(':memory:');
  a.record({ action_id: 'a1', device_id: 'd', tool: 'tap', params: {}, status: 'blocked', error_code: 'APPROVAL_REJECTED', duration_ms: 1, decision: 'approval_required', rule_id: 'app.declared', action_class: 'payment', amount: 438 });
  const rec = JSON.parse(a.exportJsonl());
  const s = spec('audit-record.schema.json');
  for (const k of s.required) assert.ok(k in rec, `record lacks required ${k}`);
  for (const k of Object.keys(rec)) assert.ok(k in s.properties, `record has unspecified field ${k}`);
});

test('sessions and approvals: schemas parse and name the fields the code uses', () => {
  assert.deepEqual(spec('session.schema.json').required, ['sub', 'jti', 'iat', 'exp']);
  assert.ok('virtual_device' in spec('approval-request.schema.json').properties);
});
