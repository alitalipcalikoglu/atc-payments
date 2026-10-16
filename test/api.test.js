import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeStripe } from './fake-stripe.js';
import { READ_KEY, WRITE_KEY, buildApp, headers } from './helpers.js';

/** @type {FakeStripe} */ let fake;
before(async () => { fake = await new FakeStripe().start(); });
after(() => fake.close());

test('API: probes report the provider; disabled provider answers 503', async (t) => {
  const off = await buildApp(null);
  t.after(() => off.app.close());
  assert.deepEqual(JSON.parse((await off.app.inject({ url: '/ready' })).body), { status: 'ok', provider: 'disabled', webhooks: 'disabled', webhookOut: 'disabled' });
  const res = await off.app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY, 'disabled-provider'), payload: { amount: 100, currency: 'eur' } });
  assert.deepEqual([res.statusCode, JSON.parse(res.body).error.code], [503, 'PROVIDER_DISABLED']);
  assert.equal((await off.app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode, 503);
  const on = await buildApp(fake);
  t.after(() => on.app.close());
  assert.equal(JSON.parse((await on.app.inject({ url: '/ready' })).body).provider, 'stripe');
  assert.equal(JSON.parse((await on.app.inject({ url: '/v1/info' })).body).service, 'atc-payments');
  assert.equal((await on.app.inject({ url: '/openapi.yaml' })).statusCode, 200);
});

test('API: create with Idempotency-Key, replay, list, detail, webhook, refund, ledger, events, stats, metrics', async (t) => {
  const { app } = await buildApp(fake);
  t.after(() => app.close());
  const body = { amount: 2500, currency: 'usd', customerEmail: 'ada@example.com', metadata: { order: 'A-1' } };
  assert.equal((await app.inject({ url: '/v1/payments' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(READ_KEY, 'read-key-create'), payload: body })).statusCode, 403);
  const missing = await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY), payload: body });
  assert.deepEqual([missing.statusCode, JSON.parse(missing.body).error.code], [400, 'IDEMPOTENCY_KEY_REQUIRED']);
  const res = await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY, 'order-A-1-create'), payload: body });
  assert.equal(res.statusCode, 201);
  const { payment, clientSecret } = JSON.parse(res.body);
  assert.deepEqual([payment.status, payment.customerEmail, payment.metadata, payment.provider.name, res.headers['idempotent-replayed']], ['pending', 'ada@example.com', { order: 'A-1' }, 'stripe', 'false']);
  assert.match(clientSecret, /_secret_/);
  const replay = await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY, 'order-A-1-create'), payload: body });
  assert.deepEqual([replay.statusCode, JSON.parse(replay.body).payment.id, replay.headers['idempotent-replayed']], [201, payment.id, 'true']);
  assert.equal(JSON.parse((await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY, 'order-A-1-create'), payload: { ...body, amount: 1 } })).body).error.code, 'IDEMPOTENCY_MISMATCH');
  const other = await app.inject({ method: 'POST', url: '/v1/payments', headers: { ...headers(WRITE_KEY, 'order-A-1-create'), 'x-access-token': 'someone-else' }, payload: body });
  assert.deepEqual([other.statusCode, JSON.parse(other.body).error.code, other.body.includes(clientSecret)], [409, 'IDEMPOTENCY_MISMATCH', false], 'another caller behind the same key never gets the stored client secret');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY, 'bad-body-key'), payload: { amount: 1.5, currency: 'usd' } })).statusCode, 400);

  const detail = JSON.parse((await app.inject({ url: `/v1/payments/${payment.id}`, headers: headers(READ_KEY) })).body);
  assert.equal(JSON.stringify(detail).includes('_secret_'), false, 'client secret only in the create response');
  assert.deepEqual([detail.refunds, detail.ledger, detail.refundable], [[], [], 0]);

  const ev = fake.transition(payment.provider.id, 'succeeded');
  const bad = await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: ev.body, headers: { 'content-type': 'application/json', 'stripe-signature': ev.signature.replace(/v1=./, 'v1=0') } });
  assert.deepEqual([bad.statusCode, JSON.parse(bad.body).error.code], [400, 'INVALID_SIGNATURE']);
  const hook = await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: ev.body, headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': ev.signature } });
  assert.deepEqual([hook.statusCode, JSON.parse(hook.body).outcome], [200, 'applied']);
  assert.equal(JSON.parse((await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: ev.body, headers: { 'content-type': 'application/json', 'stripe-signature': ev.signature } })).body).outcome, 'duplicate');

  const rf = await app.inject({ method: 'POST', url: `/v1/payments/${payment.id}/refunds`, headers: headers(WRITE_KEY, 'order-A-1-refund-1'), payload: { amount: 500 } });
  assert.equal(rf.statusCode, 201);
  assert.deepEqual([JSON.parse(rf.body).refund.status, JSON.parse(rf.body).payment.status], ['succeeded', 'partially_refunded']);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/payments/${payment.id}/refunds`, headers: headers(WRITE_KEY), payload: {} })).statusCode, 400);
  const after = JSON.parse((await app.inject({ url: `/v1/payments/${payment.id}`, headers: headers(READ_KEY) })).body);
  assert.deepEqual([after.refunds.length, after.ledger.map((/** @type {any} */ l) => l.amount), after.refundable], [1, [2500, -500], 2000]);
  const ledger = JSON.parse((await app.inject({ url: '/v1/ledger?limit=1', headers: headers(READ_KEY) })).body);
  assert.deepEqual([ledger.items[0].amount, ledger.balance[0].net, typeof ledger.nextCursor], [-500, 2000, 'string']);
  const list = JSON.parse((await app.inject({ url: '/v1/payments?status=partially_refunded', headers: headers(READ_KEY) })).body);
  assert.deepEqual(list.items.map((/** @type {any} */ p) => p.id), [payment.id]);
  const events = JSON.parse((await app.inject({ url: '/v1/provider-events', headers: headers(READ_KEY) })).body);
  assert.equal(events.items[0].outcome, 'applied');
  assert.equal(events.nextCursor, null, 'one event, one page');
  const older = JSON.parse((await app.inject({ url: `/v1/provider-events?cursor=${encodeURIComponent(`${Date.parse(events.items[0].receivedAt)}~${events.items[0].id}`)}`, headers: headers(READ_KEY) })).body);
  assert.deepEqual([older.items, older.nextCursor], [[], null], 'the cursor excludes the row it names');
  const stats = JSON.parse((await app.inject({ url: '/v1/stats', headers: headers(READ_KEY) })).body);
  assert.deepEqual([stats.provider, stats.byStatus.partially_refunded, stats.volume24h[0].amount, stats.outbox.pending], ['stripe', 1, 2500, 0], 'without atc-webhook-out nothing is queued');
  assert.match((await app.inject({ url: '/metrics', headers: headers(READ_KEY) })).body, /payments_ledger_net\{currency="usd"\} 2000/);
  const sync = JSON.parse((await app.inject({ method: 'POST', url: `/v1/payments/${payment.id}/sync`, headers: headers(WRITE_KEY) })).body);
  assert.deepEqual([sync.changed, sync.payment.status], [false, 'partially_refunded']);
  assert.equal(JSON.parse((await app.inject({ method: 'POST', url: `/v1/payments/${payment.id}/cancel`, headers: headers(WRITE_KEY) })).body).error.code, 'INVALID_STATE');
  assert.equal((await app.inject({ url: '/v1/payments/pay_nope', headers: headers(READ_KEY) })).statusCode, 400);
});

test('API: list filters, anonymize and reconciliation (write keys only for the last two)', async (t) => {
  const { app } = await buildApp(fake);
  t.after(() => app.close());
  const post = (/** @type {string} */ k, /** @type {any} */ b) => app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY, k), payload: b });
  const a = JSON.parse((await post('api-filter-aaaa', { amount: 1100, currency: 'eur', customerEmail: 'filter@example.com', metadata: { order: 'F-1' } })).body).payment;
  await post('api-filter-bbbb', { amount: 9900, currency: 'eur', metadata: { order: 'F-2' } });
  const list = async (/** @type {string} */ q) => JSON.parse((await app.inject({ url: `/v1/payments?${q}`, headers: { authorization: `Bearer ${READ_KEY}` } })).body);
  assert.deepEqual((await list('email=FILTER@example.com')).items.map((/** @type {any} */ p) => p.id), [a.id]);
  assert.deepEqual((await list('metaKey=order&metaValue=F-2')).items.length, 1);
  assert.equal((await list('minAmount=5000&currency=eur')).items.every((/** @type {any} */ p) => p.amount >= 5000), true);
  assert.equal((await app.inject({ url: '/v1/payments?metaKey=bad%20key', headers: { authorization: `Bearer ${READ_KEY}` } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/payments/${a.id}/anonymize`, headers: { authorization: `Bearer ${READ_KEY}` } })).statusCode, 403);
  const gone = JSON.parse((await app.inject({ method: 'POST', url: `/v1/payments/${a.id}/anonymize`, headers: { authorization: `Bearer ${WRITE_KEY}` } })).body);
  assert.deepEqual([gone.payment.customerEmail, gone.payment.metadata], [null, {}]);
  const rec = await app.inject({ method: 'POST', url: '/v1/reconciliation', headers: { authorization: `Bearer ${WRITE_KEY}` }, payload: { from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() } });
  assert.deepEqual([rec.statusCode, JSON.parse(rec.body).mismatches], [200, []]);
  const bad = await app.inject({ method: 'POST', url: '/v1/reconciliation', headers: { authorization: `Bearer ${WRITE_KEY}` }, payload: { from: '2030-01-02T00:00:00Z', to: '2030-01-01T00:00:00Z' } });
  assert.equal(bad.statusCode, 400);
});
