/// Declare sensitive actions so AI agents operating your app through Mobius must get a human's approval.
///
/// Mobius normally infers risk from what a button says. A declaration is authoritative instead: an agent (or an
/// attacker relabelling a button) can't talk its way past it, and the declared amount feeds amount rules such as
/// "allow food payments up to ₹200". It's carried in the control's accessibility identifier (Android resource id,
/// iOS accessibilityIdentifier), which screen readers don't announce, so users see no change.
library;

import 'package:flutter/widgets.dart';

/// What a control does when tapped. Matches Mobius action classes.
enum SensitiveAction { payment, booking, send, delete, account, install, secret }

/// The identifier Mobius reads: `mobius:<action>[:<amount>[:<CURRENCY>]]`.
String mobiusIdentifier(SensitiveAction action, {num? amount, String? currency}) {
  assert(currency == null || amount != null, 'currency needs an amount');
  assert(currency == null || RegExp(r'^[A-Za-z]{3}$').hasMatch(currency), 'currency is an ISO 4217 code, e.g. INR');
  final a = amount == null ? '' : ':${amount is int || amount == amount.roundToDouble() ? amount.toInt() : amount}';
  return 'mobius:${action.name}$a${currency == null ? '' : ':${currency.toUpperCase()}'}';
}

/// Wrap the control that commits the action.
///
/// ```dart
/// MobiusProtect(
///   action: SensitiveAction.payment,
///   amount: total,
///   currency: 'INR',
///   child: FilledButton(onPressed: pay, child: Text('Pay ₹$total')),
/// )
/// ```
class MobiusProtect extends StatelessWidget {
  const MobiusProtect({super.key, required this.action, this.amount, this.currency, required this.child});

  final SensitiveAction action;
  final num? amount;
  final String? currency;
  final Widget child;

  @override
  Widget build(BuildContext context) =>
      Semantics(identifier: mobiusIdentifier(action, amount: amount, currency: currency), container: true, child: child);
}
