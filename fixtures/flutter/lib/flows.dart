// Mock real-world flows (food, cab, flights, trains, buses, ...). No network, no money.
// Data-driven: each flow is a list of steps rendered by a few generic screens.
import 'package:flutter/material.dart';

Widget _sid(String id, Widget child) => Semantics(identifier: id, container: true, child: child);

class Opt {
  const Opt(this.title, this.subtitle, this.price, {this.tags = const []});
  final String title, subtitle;
  final int price;
  final List<String> tags; // used by filters, e.g. 'nonstop', 'morning'
}

sealed class Step { const Step(this.title); final String title; }

class FieldsStep extends Step {
  const FieldsStep(super.title, this.fields, this.action, {this.toggles = const []});
  final List<(String label, String id, bool secret)> fields;
  final String action;
  final List<String> toggles; // filter switches, e.g. 'Non-stop only'
}

class PickStep extends Step {
  const PickStep(super.title, this.options, {this.key = 'choice', this.filterTag, this.sortable = false});
  final List<Opt> options;
  final String key;
  final String? filterTag; // applied when the matching toggle from a FieldsStep is on
  final bool sortable;
}

class QtyStep extends Step {
  const QtyStep(super.title, this.items, this.action);
  final List<Opt> items;
  final String action;
}

class SeatStep extends Step {
  const SeatStep(super.title, this.rows, this.cols, this.count, {this.taken = const {}});
  final List<String> rows;
  final int cols, count;
  final Set<String> taken;
}

class ConfirmStep extends Step {
  const ConfirmStep(super.title, this.commit, {this.secondary});
  final String commit; // the consequential button, e.g. "Place order"
  final String? secondary; // e.g. "Add to wishlist"
}

class Flow {
  const Flow(this.id, this.title, this.steps, this.done, {this.after = const []});
  final String id, title;
  final List<Step> steps;
  final String Function(Map<String, String> s) done;
  final List<String> after; // buttons on the done screen, e.g. "Cancel order"
}

String inr(int v) => '₹$v';

final flows = <Flow>[
  Flow('food', 'Food delivery', [
    const FieldsStep('Search food', [('Search dishes or restaurants', 'food_search', false)], 'Search'),
    const PickStep('Restaurants', [
      Opt('Paradise Biryani', '4.4★ · 30 min · ₹350 for two', 0),
      Opt('Meghana Foods', '4.6★ · 25 min · ₹500 for two', 0),
      Opt('Pizza Corner', '4.1★ · 20 min · ₹300 for two', 0),
    ], key: 'restaurant'),
    const QtyStep('Menu', [
      Opt('Chicken Biryani', 'Bestseller', 349), Opt('Veg Biryani', '', 249), Opt('Margherita Pizza', '', 199), Opt('Coke 500ml', '', 60),
    ], 'View cart'),
    const FieldsStep('Cart', [('Coupon code', 'coupon', false)], 'Continue'),
    const ConfirmStep('Checkout', 'Place order'),
  ], (s) => 'Order placed ORD-48213 · arriving in 32 min', after: ['Track order', 'Cancel order']),
  Flow('grocery', 'Groceries', [
    const QtyStep('Grocery', [
      Opt('Milk 1L', 'Amul', 66), Opt('Eggs x12', '', 96), Opt('Bread', 'Whole wheat', 50),
      Opt('Rice 1kg', 'Sona masoori', 72), Opt('Rice 500g', 'Sona masoori', 40), Opt('Atta 5kg', '', 289),
    ], 'View cart'),
    const PickStep('Delivery slot', [Opt('In 10 minutes', 'Express', 25), Opt('Today 6-8 pm', '', 0), Opt('Tomorrow 7-9 am', '', 0)], key: 'slot'),
    const ConfirmStep('Checkout', 'Place order'),
  ], (s) => 'Order placed GRC-90211 · ${s['slot']}'),
  Flow('cab', 'Book a cab', [
    const FieldsStep('Where to?', [('Pickup', 'pickup', false), ('Drop', 'drop', false)], 'See rides'),
    const PickStep('Choose a ride', [
      Opt('Bike', '3 min away', 89), Opt('Auto', '5 min away', 129), Opt('Mini', '4 min away', 199), Opt('Sedan', '8 min away', 259),
    ], key: 'ride', sortable: true),
    const ConfirmStep('Confirm ride', 'Book ride'),
  ], (s) => 'Driver Ramesh arriving in 4 min · OTP 4821 · ${s['ride']}', after: ['Share ride status', 'Cancel ride']),
  Flow('flight', 'Flights', [
    const FieldsStep('Search flights', [('From', 'from', false), ('To', 'to', false), ('Date', 'date', false)], 'Search flights',
        toggles: ['Non-stop only']),
    const PickStep('Flights', [
      Opt('IndiGo 6E-512', '06:10 → 08:55 · Non-stop', 5499, tags: ['nonstop', 'morning']),
      Opt('Air India AI-804', '09:30 → 14:10 · 1 stop', 4299, tags: ['morning']),
      Opt('Akasa QP-1102', '13:45 → 16:30 · Non-stop', 4899, tags: ['nonstop']),
      Opt('SpiceJet SG-136', '21:15 → 02:40 · 1 stop', 3999),
    ], key: 'flight', filterTag: 'nonstop', sortable: true),
    const FieldsStep('Traveller details', [('Full name', 'traveller_name', false), ('Email', 'traveller_email', false)], 'Continue'),
    const SeatStep('Pick a seat', ['1', '2', '3', '4', '5', '6'], 6, 1, taken: {'1A', '2C', '3F', '4D'}),
    const ConfirmStep('Review & pay', 'Pay'),
  ], (s) => 'Booking confirmed PNR K7QX2M · ${s['flight']} · seat ${s['seats']}', after: ['Web check-in']),
  Flow('train', 'Train tickets', [
    const FieldsStep('Search trains', [('From station', 'from_station', false), ('To station', 'to_station', false), ('Date', 'date', false)], 'Search trains'),
    const PickStep('Trains', [
      Opt('12007 Shatabdi Exp', '06:00 → 11:00 · CC · AVL 42', 1150),
      Opt('12639 Brindavan Exp', '07:40 → 13:45 · 3A · WL 12', 980),
      Opt('12657 Chennai Mail', '22:40 → 05:10 · 3A · AVL 8', 1040),
    ], key: 'train'),
    const FieldsStep('Passenger', [('Passenger name', 'passenger', false), ('Age', 'age', false)], 'Continue'),
    const ConfirmStep('Review', 'Book ticket'),
  ], (s) => 'Ticket booked · PNR 4521367890 · ${s['train']}', after: ['Cancel ticket']),
  Flow('pnr', 'PNR status', [
    const FieldsStep('Check PNR', [('10-digit PNR', 'pnr', false)], 'Check status'),
  ], (s) => 'PNR ${s['10-digit PNR']}: CNF · Coach B2 · Berth 34 · Chart prepared'),
  Flow('bus', 'Bus tickets', [
    const FieldsStep('Search buses', [('From', 'bus_from', false), ('To', 'bus_to', false), ('Date', 'date', false)], 'Search buses'),
    const PickStep('Buses', [
      Opt('VRL Travels', 'Sleeper AC · 21:30 → 07:00 · 4.3★', 1299), Opt('SRS Travels', 'Seater · 22:00 → 08:30 · 3.9★', 799),
      Opt('IntrCity SmartBus', 'Sleeper AC · 23:00 → 08:00 · 4.5★', 1499),
    ], key: 'bus', sortable: true),
    const SeatStep('Select seat', ['L', 'U'], 10, 1, taken: {'L2', 'L3', 'U7'}),
    const PickStep('Boarding point', [Opt('Majestic', '21:30', 0), Opt('Silk Board', '22:10', 0), Opt('Electronic City', '22:30', 0)], key: 'boarding'),
    const ConfirmStep('Review', 'Pay'),
  ], (s) => 'Bus booked · ${s['bus']} · seat ${s['seats']} · board at ${s['boarding']}'),
  Flow('hotel', 'Hotels', [
    const FieldsStep('Search hotels', [('City', 'city', false), ('Check-in', 'checkin', false), ('Nights', 'nights', false)], 'Search hotels'),
    const PickStep('Hotels', [
      Opt('Sea Breeze Resort', '4.2★ · Calangute · per night', 3800), Opt('Taj Holiday Village', '4.7★ · Candolim · per night', 14500),
      Opt('Zostel Goa', '4.5★ · Anjuna · per night', 1200),
    ], key: 'hotel', sortable: true),
    const ConfirmStep('Review', 'Book now'),
  ], (s) => 'Hotel booked · ${s['hotel']} · ref HTL-5521'),
  Flow('movie', 'Movie tickets', [
    const PickStep('Showtimes', [Opt('7:00 PM', 'PVR Forum · IMAX', 450), Opt('9:45 PM', 'INOX Garuda · 2D', 250)], key: 'show'),
    const SeatStep('Select 2 seats', ['A', 'B', 'C', 'D', 'E', 'F'], 8, 2, taken: {'D4', 'D5', 'C4'}),
    const ConfirmStep('Review', 'Pay'),
  ], (s) => 'Tickets booked · ${s['show']} · seats ${s['seats']}'),
  Flow('shop', 'Shopping', [
    const FieldsStep('Search products', [('Search products', 'shop_search', false)], 'Search'),
    const PickStep('Results', [
      Opt('USB-C cable 1m', '4.3★ · 12k ratings', 299), Opt('USB-C cable 2m braided', '4.5★ · 3k ratings', 449),
      Opt('USB-C cable 1m (no brand)', '3.1★ · 90 ratings', 149),
    ], key: 'product', sortable: true),
    const ConfirmStep('Product', 'Buy now', secondary: 'Add to wishlist'),
  ], (s) => 'Order placed SHP-77120 · ${s['product']}', after: ['Return item']),
  Flow('bills', 'Recharge & bills', [
    const FieldsStep('Mobile recharge', [('Mobile number', 'mobile', false)], 'See plans'),
    const PickStep('Plans', [
      Opt('₹199 plan', '1.5 GB/day · 28 days', 199), Opt('₹299 plan', '2 GB/day · 28 days', 299), Opt('₹719 plan', '2 GB/day · 84 days', 719),
    ], key: 'plan'),
    const ConfirmStep('Review', 'Pay'),
  ], (s) => 'Recharge successful · ${s['plan']}'),
  Flow('money', 'Send money', [
    const FieldsStep('Send money', [('To (UPI ID or name)', 'payee', false), ('Amount', 'amount', false)], 'Continue'),
    const ConfirmStep('Review', 'Pay'),
    const FieldsStep('Enter UPI PIN', [('UPI PIN', 'upi_pin', true)], 'Submit'),
  ], (s) => 'Paid ₹${s['Amount']} to ${s['To (UPI ID or name)']} · UTR 3301 2277'),
  Flow('chat', 'Messages', [
    const PickStep('Chats', [Opt('Mom', 'Call me when free', 0), Opt('Riya', 'See you at 7?', 0), Opt('Manager', 'Standup moved to 10', 0)], key: 'contact'),
    const FieldsStep('Message', [('Message', 'message', false)], 'Continue'),
    const ConfirmStep('Send message', 'Send'),
  ], (s) => 'Delivered to ${s['contact']}'),
  Flow('calendar', 'Calendar', [
    const FieldsStep('New event', [('Title', 'event_title', false), ('Date', 'event_date', false), ('Time', 'event_time', false)], 'Continue'),
    const ConfirmStep('Review event', 'Save event'),
  ], (s) => 'Event saved: ${s['Title']} on ${s['Date']} at ${s['Time']}'),
  Flow('email', 'Email', [
    const FieldsStep('Compose', [('To', 'email_to', false), ('Subject', 'email_subject', false), ('Body', 'email_body', false)], 'Continue'),
    const ConfirmStep('Review email', 'Send'),
  ], (s) => 'Email sent to ${s['To']}'),
];

class ServicesScreen extends StatelessWidget {
  const ServicesScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Services')),
        body: ListView(children: [
          for (final f in flows)
            _sid('svc_${f.id}', ListTile(
              title: Text(f.title),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => FlowRunner(f, 0, const {}, 0))),
            )),
        ]),
      );
}

/// Renders step [i] of [flow]; [state] holds choices so far, [total] the running price.
class FlowRunner extends StatefulWidget {
  const FlowRunner(this.flow, this.i, this.state, this.total, {super.key});
  final Flow flow;
  final int i;
  final Map<String, String> state;
  final int total;
  @override
  State<FlowRunner> createState() => _FlowRunnerState();
}

class _FlowRunnerState extends State<FlowRunner> {
  final ctrls = <String, TextEditingController>{};
  final toggles = <String, bool>{};
  final qty = <String, int>{};
  final seats = <String>{};
  bool cheapestFirst = false;
  String status = '';

  Step get step => widget.flow.steps[widget.i];

  void next(Map<String, String> add, int addTotal) {
    final s = {...widget.state, ...add};
    final total = widget.total + addTotal;
    if (widget.i + 1 < widget.flow.steps.length) {
      Navigator.push(context, MaterialPageRoute(builder: (_) => FlowRunner(widget.flow, widget.i + 1, s, total)));
    } else {
      Navigator.push(context, MaterialPageRoute(builder: (_) => DoneScreen(widget.flow, s)));
    }
  }

  TextEditingController ctrl(String id) => ctrls.putIfAbsent(id, () => TextEditingController()..addListener(() => setState(() {})));

  @override
  Widget build(BuildContext context) {
    final st = step;
    final body = switch (st) {
      FieldsStep() => _fields(st),
      PickStep() => _pick(st),
      QtyStep() => _qty(st),
      SeatStep() => _seats(st),
      ConfirmStep() => _confirm(st),
    };
    return Scaffold(appBar: AppBar(title: Text(st.title)), body: body);
  }

  Widget _status(String s) => _sid('status', Padding(padding: const EdgeInsets.all(12), child: Text('Status: $s')));

  Widget _fields(FieldsStep st) {
    final filled = st.fields.where((f) => !f.$2.contains('coupon')).every((f) => ctrl(f.$2).text.isNotEmpty);
    return ListView(padding: const EdgeInsets.all(16), children: [
      for (final f in st.fields)
        Padding(padding: const EdgeInsets.only(bottom: 12), child: _sid(f.$2, TextField(
          controller: ctrl(f.$2), obscureText: f.$3,
          decoration: InputDecoration(labelText: f.$1, border: const OutlineInputBorder()),
        ))),
      for (final t in st.toggles)
        _sid('toggle_${t.toLowerCase().replaceAll(' ', '_')}', SwitchListTile(title: Text(t), value: toggles[t] ?? false, onChanged: (v) => setState(() => toggles[t] = v))),
      _sid('action_${st.action.toLowerCase().replaceAll(' ', '_')}', FilledButton(
        onPressed: filled ? () => next({for (final f in st.fields) f.$1: ctrl(f.$2).text, for (final t in st.toggles) t: '${toggles[t] ?? false}'},
            int.tryParse(ctrl('amount').text) ?? 0) : null, // money flow: amount feeds the total
        child: Text(st.action),
      )),
    ]);
  }

  Widget _pick(PickStep st) {
    var opts = st.options;
    final filterOn = st.filterTag != null && widget.state.values.contains('true') && widget.state.entries.any((e) => e.value == 'true');
    if (filterOn) opts = opts.where((o) => o.tags.contains(st.filterTag)).toList();
    if (cheapestFirst) opts = [...opts]..sort((a, b) => a.price.compareTo(b.price));
    return Column(children: [
      if (st.sortable)
        _sid('sort_price', SwitchListTile(title: const Text('Sort by price (low to high)'), value: cheapestFirst, onChanged: (v) => setState(() => cheapestFirst = v))),
      Expanded(child: ListView(children: [
        for (final o in opts)
          ListTile(
            title: Text(o.title),
            subtitle: Text(o.subtitle),
            trailing: o.price > 0 ? Text(inr(o.price)) : null,
            onTap: () => next({st.key: o.title}, o.price),
          ),
      ])),
    ]);
  }

  Widget _qty(QtyStep st) {
    final count = qty.values.fold(0, (a, b) => a + b);
    final sum = st.items.fold(0, (a, o) => a + o.price * (qty[o.title] ?? 0));
    return Column(children: [
      _status('$count items · ${inr(sum)}'),
      Expanded(child: ListView(children: [
        for (final o in st.items)
          ListTile(
            title: Text('${o.title} · ${inr(o.price)}'),
            subtitle: o.subtitle.isEmpty ? null : Text(o.subtitle),
            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
              IconButton(tooltip: 'Remove one ${o.title}', icon: const Icon(Icons.remove),
                  onPressed: (qty[o.title] ?? 0) > 0 ? () => setState(() => qty[o.title] = qty[o.title]! - 1) : null),
              Text('${qty[o.title] ?? 0}'),
              IconButton(tooltip: 'Add one ${o.title}', icon: const Icon(Icons.add), onPressed: () => setState(() => qty[o.title] = (qty[o.title] ?? 0) + 1)),
            ]),
          ),
      ])),
      Padding(padding: const EdgeInsets.all(16), child: _sid('action_view_cart', FilledButton(
        onPressed: count > 0 ? () => next({'items': qty.entries.where((e) => e.value > 0).map((e) => '${e.value}x ${e.key}').join(', ')}, sum) : null,
        child: Text('${st.action} ($count)'),
      ))),
    ]);
  }

  Widget _seats(SeatStep st) => Column(children: [
        _status('selected ${seats.isEmpty ? 'none' : seats.join(', ')}'),
        Expanded(child: SingleChildScrollView(child: Wrap(spacing: 6, runSpacing: 6, alignment: WrapAlignment.center, children: [
          for (final r in st.rows)
            for (var c = 1; c <= st.cols; c++)
              () {
                final id = st.cols <= 6 ? '$r${String.fromCharCode(64 + c)}' : '$r$c';
                final taken = st.taken.contains(id), sel = seats.contains(id);
                return Semantics(label: 'Seat $id${taken ? ' taken' : sel ? ' selected' : ' available'}', button: true, excludeSemantics: true,
                  child: InkWell(
                    onTap: taken ? null : () => setState(() { if (sel) { seats.remove(id); } else if (seats.length < st.count) { seats.add(id); } }),
                    child: Container(width: 44, height: 44, alignment: Alignment.center,
                      color: taken ? Colors.grey : sel ? Colors.green : Colors.indigo.shade100, child: Text(id)),
                  ));
              }(),
        ]))),
        Padding(padding: const EdgeInsets.all(16), child: _sid('action_continue', FilledButton(
          onPressed: seats.length == st.count ? () => next({'seats': seats.join(', ')}, 0) : null,
          child: const Text('Continue'),
        ))),
      ]);

  Widget _confirm(ConfirmStep st) => ListView(padding: const EdgeInsets.all(16), children: [
        for (final e in widget.state.entries)
          if (e.value.isNotEmpty && e.value != 'false') ListTile(dense: true, title: Text(e.key), subtitle: Text(e.value)),
        ListTile(title: const Text('Total'), trailing: Text(inr(widget.total))),
        if (status.isNotEmpty) _status(status),
        _sid('commit', FilledButton(onPressed: () => next({}, 0), child: Text(st.commit == 'Pay' ? 'Pay ${inr(widget.total)}' : st.commit))),
        if (st.secondary != null)
          _sid('secondary', OutlinedButton(onPressed: () => setState(() => status = '${st.secondary} done'), child: Text(st.secondary!))),
      ]);
}

class DoneScreen extends StatefulWidget {
  const DoneScreen(this.flow, this.state, {super.key});
  final Flow flow;
  final Map<String, String> state;
  @override
  State<DoneScreen> createState() => _DoneState();
}

class _DoneState extends State<DoneScreen> {
  String? extra;
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Done')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          _sid('status', Text('Status: ${widget.flow.done(widget.state)}')),
          if (extra != null) _sid('status_extra', Text('Status: $extra')),
          for (final a in widget.flow.after)
            _sid('after_${a.toLowerCase().replaceAll(' ', '_')}', OutlinedButton(onPressed: () => setState(() => extra = '$a done'), child: Text(a))),
          _sid('home', TextButton(onPressed: () => Navigator.popUntil(context, (r) => r.isFirst), child: const Text('Back to home'))),
        ]),
      );
}
