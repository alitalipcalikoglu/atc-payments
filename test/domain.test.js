import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { StripeSignature } from '../src/net/stripe-signature.js';
import { FakeStripe } from './fake-stripe.js';
import { manualClock, testService } from './helpers.js';

const WH = { WEBHOOK_OUT_URL: 'http://wh.test', WEBHOOK_OUT_API_KEY: 'k'.repeat(40) };
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e.code === c;
/** @type {FakeStripe} */ let fake;
before(async () => { fake = await new FakeStripe().start(); });
after(() => fake.close());

const audit = () => { /** @type {any[]} */ const buffer = /** @type {any[]} */ ([]); return { buffer, record: (/** @type {any} */ e) => { buffer.push(e); return true; } }; };
/** @param {ReturnType<typeof testService>} t @param {string} key @param {object} [body] */
const create = (t, key, body = { amount: 1000, currency: 'EUR', description: 'Order 42', metadata: { order: '42' } }) => t.service.idempotent('shop', key, 'create', body, (pk) => t.service.create(/** @type {any} */ (body), 'shop', pk).then((r) => ({ status: 201, body: r })));
const outboxTypes = (/** @type {any} */ t) => t.store.raw.prepare('SELECT type FROM outbox ORDER BY seq').all().map((/** @type {any} */ r) => r.type);

test('create: idempotency key required; replay returns the first answer; another body is refused; provider gets a derived key', async () => {
  const t = testService(fake, WH);
  await assert.rejects(t.service.idempotent('shop', undefined, 'create', {}, async () => ({ status: 201, body: {} })), code('IDEMPOTENCY_KEY_REQUIRED'));
  await assert.rejects(t.service.idempotent('shop', 'short', 'create', {}, async () => ({ status: 201, body: {} })), code('INVALID_ARGUMENT'));
  const before = fake.intents.size;
  const first = /** @type {any} */ (await create(t, 'order-42-attempt'));
  const { payment, clientSecret } = first.body;
  assert.deepEqual([first.status, first.replayed, payment.status, payment.amount, payment.currency, payment.created_by], [201, false, 'pending', 1000, 'eur', 'shop']);
  assert.match(clientSecret, /^pi_[0-9a-f]+_secret_/);
  const sent = fake.requests.at(-1);
  assert.deepEqual([sent?.idempotencyKey, sent?.params['metadata[atc_payment_id]'], sent?.params['metadata[order]'], sent?.params['automatic_payment_methods[enabled]']], ['atc-payments:shop:order-42-attempt', payment.id, '42', 'true']);
  const again = /** @type {any} */ (await create(t, 'order-42-attempt'));
  assert.deepEqual([again.replayed, again.body.payment.id, fake.intents.size], [true, payment.id, before + 1]);
  await assert.rejects(create(t, 'order-42-attempt', { amount: 2000, currency: 'eur' }), code('IDEMPOTENCY_MISMATCH'));
  assert.deepEqual(outboxTypes(t), ['payment.created']);
  await assert.rejects(create(t, 'bad-currency', { amount: 1000, currency: 'jpy' }), code('INVALID_ARGUMENT'));
  await assert.rejects(create(t, 'too-small', { amount: 10, currency: 'eur' }), code('INVALID_ARGUMENT'));
  await assert.rejects(create(t, 'meta-reserved', { amount: 100, currency: 'eur', metadata: { atc_x: '1' } }), code('INVALID_ARGUMENT'));
});

test('create: transient provider errors release the key; a retry reuses the provider key; a lost response never doubles the charge', async () => {
  const t = testService(fake, WH);
  fake.failNext = { count: 1, status: 503 };
  await assert.rejects(create(t, 'retry-me-please'), code('PROVIDER_ERROR'));
  assert.equal(t.store.idem('shop', 'retry-me-please'), undefined, 'key released');
  const ok = /** @type {any} */ (await create(t, 'retry-me-please'));
  assert.equal(ok.body.payment.status, 'pending');
  assert.deepEqual(fake.requests.slice(-2).map((r) => r.idempotencyKey), ['atc-payments:shop:retry-me-please', 'atc-payments:shop:retry-me-please']);
  // The service crashed after Stripe answered: the same provider key returns the same intent and payment.
  const a = await t.service.create({ amount: 700, currency: 'eur' }, 'shop', 'atc-payments:shop:lost-response');
  const b = await t.service.create({ amount: 700, currency: 'eur' }, 'shop', 'atc-payments:shop:lost-response');
  assert.equal(a.payment.id, b.payment.id);
  const declined = await create(t, 'declined-card', { amount: 402, currency: 'eur' }).catch((e) => e);
  assert.deepEqual([declined.code, declined.statusCode], ['PROVIDER_DECLINED', 402]);
  const replay = /** @type {any} */ (await create(t, 'declined-card', { amount: 402, currency: 'eur' }));
  assert.deepEqual([replay.status, replay.replayed, replay.body.error.code], [402, true, 'PROVIDER_DECLINED'], 'deterministic refusals are replayed');
});

test('webhooks: signature checked, each event once, state machine enforced, ledger and outbox written', async () => {
  const clock = manualClock();
  const a = audit();
  const t = testService(fake, WH, { now: clock.now, audit: a });
  const { payment } = /** @type {any} */ ((await create(t, 'webhook-flow-1')).body);
  const pi = payment.provider_id;
  const failed = fake.transition(pi, 'requires_payment_method', { error: 'Your card has insufficient funds.' });
  assert.equal(t.service.webhook(failed.body, failed.signature).outcome, 'applied');
  assert.deepEqual([t.service.get(payment.id).status, t.service.get(payment.id).last_error], ['pending', 'Your card has insufficient funds.']);
  const proc = fake.transition(pi, 'processing');
  t.service.webhook(proc.body, proc.signature);
  const ok = fake.transition(pi, 'succeeded');
  assert.deepEqual(t.service.webhook(ok.body, ok.signature), { id: JSON.parse(ok.body).id, type: 'payment_intent.succeeded', outcome: 'applied' });
  assert.equal(t.service.webhook(ok.body, ok.signature).outcome, 'duplicate');
  assert.deepEqual(t.store.ledgerOf(payment.id).map((l) => [l.kind, l.amount, l.currency, l.ref]), [['charge', 1000, 'eur', pi]]);
  const late = fake.event('payment_intent.processing', { ...fake.intents.get(pi), status: 'processing' });
  assert.equal(t.service.webhook(late.body, late.signature).outcome, 'ignored', 'out-of-order events do not move a payment back');
  assert.equal(t.service.get(payment.id).status, 'succeeded');
  assert.deepEqual(outboxTypes(t), ['payment.created', 'payment.failed', 'payment.processing', 'payment.succeeded']);
  assert.deepEqual(a.buffer.map((e) => e.action), ['atc-payments.payment.failed', 'atc-payments.payment.processing', 'atc-payments.payment.succeeded']);
  assert.deepEqual(a.buffer[2].actor, { type: 'provider', id: 'stripe' });

  const forged = fake.event('payment_intent.succeeded', fake.intents.get(pi), { secret: `whsec_${'x'.repeat(32)}` });
  assert.throws(() => t.service.webhook(forged.body, forged.signature), code('INVALID_SIGNATURE'));
  assert.throws(() => t.service.webhook(ok.body.replace('succeeded', 'canceled'), ok.signature), code('INVALID_SIGNATURE'));
  const stale = fake.event('payment_intent.succeeded', fake.intents.get(pi), { t: Math.floor(clock.now() / 1000) - 600 });
  assert.throws(() => t.service.webhook(stale.body, stale.signature), code('INVALID_SIGNATURE'));
  assert.equal(a.buffer.at(-1).action, 'atc-payments.webhook.rejected');
  assert.equal(a.buffer.at(-1).outcome, 'denied');
  const other = fake.event('payment_intent.succeeded', { id: 'pi_elsewhere', object: 'payment_intent', status: 'succeeded' });
  assert.equal(t.service.webhook(other.body, other.signature).outcome, 'unknown');
  const misc = fake.event('customer.created', { id: 'cus_1', object: 'customer' });
  assert.equal(t.service.webhook(misc.body, misc.signature).outcome, 'ignored');
  assert.deepEqual(t.store.events(10).map((/** @type {any} */ e) => e.outcome).sort(), ['applied', 'applied', 'applied', 'ignored', 'ignored', 'unknown']);
});

test('refunds: only after success, partial then rest, never above what is left, pending refunds count, provider refunds recorded', async () => {
  const t = testService(fake, WH);
  const { payment } = /** @type {any} */ ((await create(t, 'refund-flow-01')).body);
  const refund = (/** @type {string} */ key, /** @type {object} */ body) => t.service.idempotent('shop', key, `refund:${payment.id}`, body, (pk) => t.service.refund(payment.id, /** @type {any} */ (body), 'shop', pk).then((r) => ({ status: 201, body: r })));
  await assert.rejects(refund('refund-too-early', {}), code('INVALID_STATE'));
  const s = fake.transition(payment.provider_id, 'succeeded');
  t.service.webhook(s.body, s.signature);
  const r1 = /** @type {any} */ ((await refund('refund-part-1', { amount: 300, reason: 'requested_by_customer' })).body);
  assert.deepEqual([r1.refund.status, r1.refund.amount, r1.payment.status, r1.payment.amount_refunded], ['succeeded', 300, 'partially_refunded', 300]);
  assert.equal(fake.requests.at(-1)?.idempotencyKey, 'atc-payments:shop:refund-part-1');
  await assert.rejects(refund('refund-too-much', { amount: 701 }), code('AMOUNT_EXCEEDS_REMAINING'));
  const r2 = /** @type {any} */ ((await refund('refund-second', { amount: 500 })).body);
  assert.equal(r2.refund.status, 'succeeded');
  const p2 = /** @type {any} */ ((await refund('refund-rest', {})).body);
  assert.deepEqual([p2.refund.amount, p2.payment.status, p2.payment.amount_refunded], [200, 'refunded', 1000]);
  await assert.rejects(refund('refund-after-full', {}), code('INVALID_STATE'));
  assert.deepEqual(t.store.ledgerOf(payment.id).map((l) => l.amount), [1000, -300, -500, -200]);
  assert.deepEqual(t.store.balance(), [{ currency: 'eur', charged: 1000, refunded: 1000, net: 0, entries: 4 }]);
  assert.ok(outboxTypes(t).includes('payment.refunded'));

  // A pending refund holds its amount until the provider settles it.
  const second = /** @type {any} */ ((await create(t, 'refund-flow-02', { amount: 2000, currency: 'eur' })).body).payment;
  const s2 = fake.transition(second.provider_id, 'succeeded');
  t.service.webhook(s2.body, s2.signature);
  const slow = await t.service.refund(second.id, { amount: 1234 }, 'shop', 'atc-payments:shop:slow-refund');
  assert.deepEqual([slow.refund.status, t.service.get(second.id).status], ['pending', 'succeeded']);
  await assert.rejects(t.service.refund(second.id, { amount: 767 }, 'shop', 'atc-payments:shop:x1'), code('AMOUNT_EXCEEDS_REMAINING'));
  const settled = fake.refundTo(slow.refund.provider_id, 'succeeded');
  assert.equal(t.service.webhook(settled.body, settled.signature).outcome, 'applied');
  assert.deepEqual([t.store.refund(slow.refund.id)?.status, t.service.get(second.id).amount_refunded], ['succeeded', 1234]);
  const dash = fake.event('refund.created', { id: 're_dashboard1', object: 'refund', amount: 100, payment_intent: second.provider_id, status: 'succeeded', reason: null });
  assert.equal(t.service.webhook(dash.body, dash.signature).outcome, 'applied');
  assert.deepEqual([t.store.refundByProvider('re_dashboard1')?.created_by, t.service.get(second.id).amount_refunded], ['stripe', 1334]);
});

test('cancel and sync; provider disabled; webhooks disabled', async () => {
  const t = testService(fake, WH);
  const { payment } = /** @type {any} */ ((await create(t, 'cancel-flow-1')).body);
  assert.equal((await t.service.cancel(payment.id)).status, 'canceled');
  assert.equal((await t.service.cancel(payment.id)).status, 'canceled', 'cancel is idempotent');
  const { payment: p2 } = /** @type {any} */ ((await create(t, 'sync-flow-01')).body);
  fake.intents.get(p2.provider_id).status = 'succeeded';
  const synced = await t.service.sync(p2.id);
  assert.deepEqual([synced.changed, synced.payment.status], [true, 'succeeded']);
  await assert.rejects(t.service.cancel(p2.id), code('INVALID_STATE'));
  const off = testService(null);
  await assert.rejects(off.service.create({ amount: 100, currency: 'eur' }, 'shop', 'k'), code('PROVIDER_DISABLED'));
  assert.throws(() => off.service.webhook('{}', 't=1,v1=x'), code('WEBHOOK_DISABLED'));
  assert.deepEqual([off.service.stats().provider, off.service.stats().webhooks], ['disabled', 'disabled']);
});

test('outbox: delivered with stable idempotency keys, retried with backoff; retention', async () => {
  const clock = manualClock();
  const t = testService(fake, WH, { now: clock.now });
  await create(t, 'outbox-flow-1');
  /** @type {any[]} */ const sent = [];
  let down = true;
  const publisher = /** @type {any} */ ({ publish: async (/** @type {any} */ e) => { if (down) throw new Error('atc-webhook-out responded 503'); sent.push({ type: e.type, key: `atc-payments:${e.seq}`, data: JSON.parse(e.data) }); } });
  assert.equal(await t.service.publishDue(publisher), 0);
  assert.deepEqual(t.service.stats().outbox, { pending: 1, dead: 0 });
  assert.equal(await t.service.publishDue(publisher), 0, 'waits for the backoff');
  down = false;
  clock.advance(1_500);
  assert.equal(await t.service.publishDue(publisher), 1);
  assert.deepEqual([sent[0].type, sent[0].key, sent[0].data.status, sent[0].data.amount], ['payment.created', 'atc-payments:1', 'pending', 1000]);
  clock.advance(31 * 86_400_000);
  assert.deepEqual(t.service.maintain(), { idempotency: 1, events: 0, outbox: 1 });
  assert.equal(StripeSignature.verify(undefined, '', 'x', { nowSec: 0, toleranceSec: 1 }).ok, false);
});

test('outbox: the last failed attempt publishes ops.payments.outbox_dead once', async () => {
  const clock = manualClock();
  /** @type {any[]} */ const ops = [];
  const t = testService(fake, { OUTBOX_MAX_ATTEMPTS: '2', ...WH }, { now: clock.now, ops: { publish: (/** @type {string} */ ty, /** @type {any} */ d) => ops.push([ty, d]) } });
  await create(t, 'outbox-dead-1');
  const publisher = /** @type {any} */ ({ publish: async () => { throw new Error('atc-webhook-out responded 503'); } });
  await t.service.publishDue(publisher);
  assert.deepEqual(ops, []);
  clock.advance(5_000);
  await t.service.publishDue(publisher);
  assert.deepEqual(ops.map((/** @type {[string, any]} */ [ty, d]) => [ty, d.type, d.attempts, d.error]), [['ops.payments.outbox_dead', 'payment.created', 2, 'atc-webhook-out responded 503']]);
  clock.advance(900_000);
  await t.service.publishDue(publisher);
  assert.equal(ops.length, 1, 'a dead event is not retried and not announced again');
  assert.deepEqual(t.service.stats().outbox, { pending: 0, dead: 1 });
});

test('list filters: e-mail, metadata, currency, amount range and creation window narrow the list together', async () => {
  const t = testService(fake, WH);
  const mk = async (/** @type {string} */ k, /** @type {any} */ body) => /** @type {any} */ (await create(t, k, body)).body.payment;
  const a = await mk('list-filter-a', { amount: 1000, currency: 'eur', customerEmail: 'Ana@Example.com', metadata: { order: '1001' } });
  const b = await mk('list-filter-b', { amount: 5000, currency: 'usd', customerEmail: 'bob@example.com', metadata: { order: '1002' } });
  const ids = (/** @type {any} */ q) => t.store.payments({ limit: 50, ...q }).map((/** @type {any} */ p) => p.id);
  assert.deepEqual(ids({ email: 'ana@example.com' }), [a.id], 'case-insensitive');
  assert.deepEqual(ids({ metaKey: 'order', metaValue: '1002' }), [b.id]);
  assert.deepEqual(ids({ currency: 'USD' }), [b.id]);
  assert.deepEqual(ids({ minAmount: 2000 }), [b.id]);
  assert.deepEqual(ids({ maxAmount: 2000 }), [a.id]);
  assert.deepEqual(ids({ metaKey: 'order', metaValue: '1001', currency: 'usd' }), [], 'filters combine');
  assert.deepEqual(ids({ from: Date.now() + 60_000 }), []);
  assert.equal(ids({ to: Date.now() + 60_000 }).length >= 2, true);
});

test('anonymize: e-mail, description and metadata go here and at Stripe; amounts and the ledger stay; a provider failure changes nothing', async () => {
  const t = testService(fake, WH, { audit: audit() });
  const p = /** @type {any} */ (await create(t, 'anonymize-1', { amount: 2500, currency: 'eur', description: 'Ana, order 7', customerEmail: 'ana@example.com', metadata: { order: '7', note: 'x' } })).body.payment;
  const ok = fake.transition(p.provider_id, 'succeeded');
  t.service.webhook(ok.body, ok.signature);
  fake.failNext = { count: 1, status: 503 };
  await assert.rejects(t.service.anonymize(p.id, 'shop'), code('PROVIDER_ERROR'));
  assert.equal(t.service.get(p.id).customer_email, 'ana@example.com', 'nothing changed after the provider failure');
  const after = await t.service.anonymize(p.id, 'shop');
  assert.deepEqual([after.customer_email, after.description, after.metadata, after.amount, after.status], [null, '', '{}', 2500, 'succeeded']);
  const pi = fake.intents.get(p.provider_id);
  assert.deepEqual([pi.receipt_email, pi.description, Object.keys(pi.metadata).filter((k) => !k.startsWith('atc_'))], [null, null, []], 'cleared at the provider too');
  assert.equal(t.store.balance().find((/** @type {any} */ b) => b.currency === 'eur')?.net, 2500, 'the ledger is untouched');
});

test('reconcile: differences between this service and Stripe are listed and, with repair, synced', async () => {
  const t = testService(fake, WH);
  const p = /** @type {any} */ (await create(t, 'reconcile-1', { amount: 3000, currency: 'eur' })).body.payment;
  const win = { from: Date.now() - 60_000, to: Date.now() + 60_000 };
  assert.deepEqual((await t.service.reconcile(win)).mismatches, [], 'in step after creating');
  fake.transition(p.provider_id, 'succeeded'); // Stripe moves on, the webhook is lost
  const r = await t.service.reconcile(win);
  assert.deepEqual(r.mismatches.map((m) => [m.id, m.local.status, m.provider.status]), [[p.id, 'pending', 'succeeded']]);
  assert.equal(t.service.get(p.id).status, 'pending', 'a report alone changes nothing');
  const fixed = await t.service.reconcile({ ...win, repair: true });
  assert.deepEqual([fixed.repaired, t.service.get(p.id).status], [1, 'succeeded']);
  assert.deepEqual((await t.service.reconcile(win)).mismatches, []);
});

test('dispute webhook: announced as payment.disputed without moving the payment; unknown intents are recorded as unknown', async () => {
  const t = testService(fake, WH);
  const p = /** @type {any} */ (await create(t, 'dispute-1', { amount: 1500, currency: 'eur' })).body.payment;
  const ok = fake.transition(p.provider_id, 'succeeded');
  t.service.webhook(ok.body, ok.signature);
  const dispute = { id: 'dp_1Abc', object: 'dispute', amount: 1500, currency: 'eur', reason: 'fraudulent', status: 'needs_response', payment_intent: p.provider_id, charge: 'ch_1' };
  const ev = fake.event('charge.dispute.created', dispute);
  assert.equal(t.service.webhook(ev.body, ev.signature).outcome, 'applied');
  assert.equal(t.service.get(p.id).status, 'succeeded');
  const row = t.store.raw.prepare("SELECT data FROM outbox WHERE type = 'payment.disputed'").get();
  assert.deepEqual(JSON.parse(/** @type {any} */ (row).data), { id: p.id, dispute: { id: 'dp_1Abc', status: 'needs_response', reason: 'fraudulent', amount: 1500, currency: 'eur', event: 'charge.dispute.created' } });
  const other = fake.event('charge.dispute.created', { ...dispute, payment_intent: 'pi_foreign' });
  assert.equal(t.service.webhook(other.body, other.signature).outcome, 'unknown');
});
