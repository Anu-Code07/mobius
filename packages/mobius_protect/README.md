# mobius_protect

Declare the sensitive actions in your Flutter app, so any AI agent operating it through [Mobius](https://github.com/Anu-Code07/mobius) must get a human's approval before paying, booking, sending or deleting, **whatever the button says**.

```dart
MobiusProtect(
  action: SensitiveAction.payment,
  amount: total,
  currency: 'INR',
  child: FilledButton(onPressed: pay, child: Text('Pay ₹$total')),
)
```

How it works:
- **Carried in the accessibility identifier.** The declaration goes in the control's identifier (`mobius:payment:438:INR`): the Android resource id or the iOS `accessibilityIdentifier`. Screen readers don't announce it, so users see no change.
- **Authoritative.** Mobius treats a declaration as the truth. A misleading label like "Close" on a Pay button can't get past it.
- **Feeds amount rules.** The declared amount drives rules like "allow food payments up to ₹200".

Actions: `payment · booking · send · delete · account · install · secret`.

Not on Flutter? Set the same identifier yourself:
- **Android:** a resource id like `mobius_payment_438_INR`.
- **iOS:** `accessibilityIdentifier = "mobius:payment:438:INR"`.
