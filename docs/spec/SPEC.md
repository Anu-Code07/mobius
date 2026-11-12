# Mobius Agent Safety Protocol (MASP) · v0.1 draft

An open protocol for letting AI agents operate real devices and apps safely. Mobius is the reference implementation. Any agent framework, device driver or app can implement the same pieces and interoperate:
- the same actions and risk classes
- the same approval semantics
- portable policies
- signed agent identities
- verifiable audit records

**Status:** draft, open for comment. The JSON Schemas in this folder are normative. Everything else is explanation.

## 1. Model

```
 Agent (Claude, GPT, Gemini, custom)
   │  MCP · REST            ← presents a signed session (§5)
   ▼
 Safety layer (Mobius)
   observe → classify (§2) → decide (§3) → approve (§4) → act → verify → audit (§6)
   │  driver interface
   ▼
 Device / app             ← may declare its sensitive actions (§7)
```

Rules every implementation must follow:

1. **Fail closed.** If anything is unknown, unreachable, unparseable or expired, the outcome is "no".
2. **Decide on what the action will actually hit.** Re-read the target right before acting. If it changed since the agent read it, refuse the action as stale (the agent must look again).
3. **Never trust the agent's description.** Approvals and audit are built from device state: the real control, text and amount.
4. **Screen content is data, never instructions.**
5. **Secrets never reach the model.** Mask passwords, PINs, OTPs, CVVs and card numbers in text, labels and screenshots. If a secret is on screen and can't be masked, withhold the screenshot.

## 2. Action classes

Every state-changing action is classified as one of:

`payment · booking · send · delete · account · install · permission · secret · unknown`

The class is chosen from these sources, strongest first:

| Layer | Source |
|---|---|
| 0 | **App declaration** (§7), which is authoritative. |
| 1 | The target, or anything under the touch point, names a commit. Wording is normalised first: NFKC, invisible characters removed, look-alike letters mapped, words split across views joined. Any language and icon glyphs count. |
| 2 | OS permission prompts ("Allow…"). |
| 3 | Targets that can't be identified: coordinate touches on unlabeled or invisible controls, and unlabeled controls on a screen showing an amount due. |
| 4 | Screen context: generic "Continue" or amount-only buttons on a checkout, "slide to…" controls, non-web links, newline-in-text (= submit). |

## 3. Decisions

`allow · approval_required · blocked`

- **Hard blocks** come from configured app categories (banking, credentials) and dangerous URL schemes. No rule can loosen a block.
- **Policy rules** ([policy.schema.json](policy.schema.json)) are evaluated in order, and the first match wins. A rule may scope by app, tool, action class, target and `max_amount`. The deciding rule's id is recorded: `builtin.*`, `app.declared`, or the rule's own id.
- **`dry_run`** turns `approval_required` into `allow` but still records the decision. Blocks still apply.

## 4. Approvals

An approval request ([approval-request.schema.json](approval-request.schema.json)) is shown to a human through a channel the agent can't operate: a native dialog, a webhook, a chat bot or a phone. With `approval_auth: device_owner`, approving also requires the human's biometric or password, so a script can't click "Approve" for them.

**After an approval, re-check the target.** If it changed while the human was deciding, refuse the action as stale. Automated approvals used in tests must never apply to physical devices.

## 5. Agent sessions

An operator issues a signed session ([session.schema.json](session.schema.json)): `base64url(claims) "." base64url(Ed25519(first part))`.

- The agent presents it with every call. Over MCP that's the server environment; over REST it's the `X-Mobius-Session` header.
- **Invalid, expired, revoked, or issued for a different `policy_version`?** The action is refused. The operator revokes a session by its `jti`; revocation takes effect on the next action.
- An operator may require a session, so anonymous agents can't act at all.
- The session's `sub` and `jti` are written into the audit record of every action taken under it.

## 6. Audit records

One JSON line per action ([audit-record.schema.json](audit-record.schema.json)):
- **Hash-chained:** each record includes the previous record's hash, so a removed or reordered entry breaks the chain.
- **Signed:** each record carries an Ed25519 signature from the install's key.
- **Portable:** anyone holding the public key can verify an exported log on any system. Rewriting an entry and recomputing every hash still fails the signature.
- **Key rotation:** a retired key's public half is kept, so older entries still verify. Signers only move forward: once a newer key has signed an entry, no later entry may carry a retired key's signature. Rotating the key ends every session it signed.
- **Redacted by construction:** records never contain typed text, secrets or screen content.

## 7. App declarations

An app can mark its sensitive controls itself, through the control's accessibility identifier (screen readers don't announce it):

```
mobius:<class>[:<amount>[:<CURRENCY>]]     e.g.  mobius:payment:438:INR      (iOS accessibilityIdentifier, Flutter Semantics identifier)
mobius_<class>[_<amount>[_<CURRENCY>]]     e.g.  com.shop:id/mobius_payment   (Android resource id)
```

A declaration is **authoritative**. It outranks the visible label, so a button relabelled "Close" can't hide a payment. A declared amount feeds amount rules.

Flutter: [`mobius_protect`](../../packages/mobius_protect) (`MobiusProtect(action: SensitiveAction.payment, amount: …, currency: 'INR', child: …)`).

## 8. Conformance

An implementation conforms to MASP 0.1 if:
- it follows §1–§7
- it passes the **[Break Mobius](../benchmark/README.md)** benchmark: every attack not marked "open" is defended, and every ordinary-action control passes without asking

The benchmark is the conformance suite. Published scores make implementations comparable.

## 9. Not yet in the protocol

These are deliberately out of scope for 0.1:
- multi-device workflows
- browser and desktop drivers (the protocol is driver-neutral, but only mobile is specified and tested)
- delegated approvals (who may approve what)
- a shared revocation list across machines (0.1 revocation is per install)
- a registry of declared actions per app

> Licensed under Apache-2.0 (see [LICENSE](LICENSE)): implement it freely in any tool.
