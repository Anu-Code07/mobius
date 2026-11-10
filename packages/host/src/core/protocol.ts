// Mobius protocol: the contract shared by host, Android app and iOS app.
// Kotlin/Swift models must round-trip the golden fixtures in tests/fixtures.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const ErrorCode = z.enum([
  'INVALID_INPUT', 'DEVICE_NOT_FOUND', 'DEVICE_OFFLINE', 'DEVICE_LOCKED', 'SERVICE_DISABLED',
  'PERMISSION_REQUIRED', 'UNSUPPORTED_CAPABILITY', 'ELEMENT_NOT_FOUND', 'AMBIGUOUS_TARGET',
  'STALE_ELEMENT', 'SECURE_WINDOW', 'APP_NOT_INSTALLED', 'POLICY_BLOCKED', 'APPROVAL_REQUIRED',
  'APPROVAL_REJECTED', 'APPROVAL_EXPIRED', 'BUDGET_EXCEEDED', 'LOOP_DETECTED', 'RATE_LIMITED',
  'DUPLICATE_ACTION', 'TIMEOUT', 'CANCELLED', 'OUTCOME_UNKNOWN', 'FOREGROUND_REQUIRED', 'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const Platform = z.enum(['android', 'ios']);
export const Framework = z.enum(['native', 'flutter', 'react_native', 'unknown']);
export type Framework = z.infer<typeof Framework>;
export const TreeQuality = z.enum(['good', 'sparse', 'empty']);

export const Bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type Bounds = z.infer<typeof Bounds>;

export const Role = z.enum([
  'button', 'textbox', 'checkbox', 'switch', 'radio', 'image', 'text', 'list', 'tab', 'view',
]);

export const Element = z.object({
  id: z.string(),                 // "o12:e5" — valid only against observation o12 (or re-resolvable)
  role: Role,
  text: z.string().nullable(),
  label: z.string().nullable(),   // content-desc / accessibility label
  resource_id: z.string().nullable(),
  clickable: z.boolean(),
  long_clickable: z.boolean(),
  enabled: z.boolean(),
  focused: z.boolean(),
  scrollable: z.boolean(),
  editable: z.boolean(),
  checked: z.boolean().nullable(),
  selected: z.boolean(),
  sensitive: z.boolean(),         // true → text redacted at source
  bounds: Bounds,
  dup_index: z.number().int(),    // nth element with identical role+text+label
});
export type Element = z.infer<typeof Element>;

export const Observation = z.object({
  observation_id: z.string(),
  device_id: z.string(),
  platform: Platform,
  foreground_app: z.string().nullable(),
  screen: z.object({ width: z.number(), height: z.number(), rotation: z.number() }),
  screen_hash: z.string(),
  framework: Framework,
  tree_quality: TreeQuality,
  sources: z.array(z.enum(['a11y', 'flutter_vm', 'vision'])),
  elements: z.array(Element),
  untrusted_content: z.literal(true),
  truncated: z.boolean(),
  /** On-screen keyboard area when visible. Its keys are not listed as elements. */
  keyboard: Bounds.nullable(),
});
export type Observation = z.infer<typeof Observation>;

export const MobiusErrorBody = z.object({
  code: ErrorCode,
  message: z.string(),
  retryable: z.boolean(),
  hint: z.string().optional(),
});

export const ActionStatus = z.enum(['succeeded', 'failed', 'blocked', 'pending_approval', 'outcome_unknown']);

export const ActionResult = z.object({
  ok: z.boolean(),
  action_id: z.string(),
  status: ActionStatus,
  duration_ms: z.number(),
  state_changed: z.boolean().nullable(),
  foreground_app: z.string().nullable(),
  observation_id: z.string().nullable(),
  verified: z.boolean().nullable(),
  message: z.string(),
  error: MobiusErrorBody.optional(),
});
export type ActionResult = z.infer<typeof ActionResult>;

/** Post-action expectation; the host waits (state-based) until it holds or times out. */
export const Expect = z.object({
  text_visible: z.string().optional(),
  app: z.string().optional(),
  element_gone: z.string().optional(),
}).strict();
export type Expect = z.infer<typeof Expect>;

export const Capability = z.enum([
  'observe', 'screenshot', 'tap', 'type', 'scroll', 'swipe', 'press_key',
  'list_apps', 'open_app', 'open_url', 'wait_for', 'run_shortcut', 'device_action',
]);
export type Capability = z.infer<typeof Capability>;

export const Key = z.enum(['back', 'home', 'recents', 'enter', 'notifications']);
export type Key = z.infer<typeof Key>;
