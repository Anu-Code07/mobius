import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobius_protect/mobius_protect.dart';

void main() {
  test('identifier format matches what Mobius reads', () {
    expect(mobiusIdentifier(SensitiveAction.payment, amount: 438, currency: 'inr'), 'mobius:payment:438:INR');
    expect(mobiusIdentifier(SensitiveAction.payment, amount: 438.5, currency: 'INR'), 'mobius:payment:438.5:INR');
    expect(mobiusIdentifier(SensitiveAction.send), 'mobius:send');
  });

  testWidgets('the declaration is on the button, whatever its label says', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: MobiusProtect(
          action: SensitiveAction.payment,
          amount: 438,
          currency: 'INR',
          child: ElevatedButton(onPressed: () {}, child: const Text('Close')), // a misleading label
        ),
      ),
    ));
    final node = tester.getSemantics(find.byType(MobiusProtect));
    expect(node.identifier, 'mobius:payment:438:INR');
    handle.dispose();
  });
}
