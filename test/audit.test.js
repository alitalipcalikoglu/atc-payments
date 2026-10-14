import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { FakeStripe } from './fake-stripe.js';
import { READ_KEY, WRITE_KEY, buildApp, headers } from './helpers.js';

const silent = { warn() {}, error() {} };
/** @type {FakeStripe} */ let fake;
before(async () => { fake = await new FakeStripe().start(); });
after(() => fake.close());

test('API: creates, syncs, refunds, provider transitions and rejected webhooks are audit events; reads are not', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp(fake, undefined, { audit });
  t.after(() => app.close());
  const h = { ...headers(WRITE_KEY, 'audit-create-01'), 'user-agent': 'test-agent' };
  const p = JSON.parse((await app.inject({ method: 'POST', url: '/v1/payments', headers: h, payload: { amount: 900, currency: 'eur' } })).body).payment;
  await app.inject({ url: '/v1/payments', headers: headers(READ_KEY) });
  const ev = fake.transition(p.provider.id, 'succeeded');
  await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: ev.body, headers: { 'content-type': 'application/json', 'stripe-signature': ev.signature } });
  await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', payload: ev.body, headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=00' } });
  await app.inject({ method: 'POST', url: `/v1/payments/${p.id}/refunds`, headers: headers(WRITE_KEY, 'audit-refund-01'), payload: { amount: 100 } });
  await app.inject({ method: 'POST', url: `/v1/payments/${p.id}/sync`, headers: headers(WRITE_KEY) });
  assert.deepEqual(audit.buffer.map((e) => [e.action, e.outcome ?? 'success']), [
    ['atc-payments.payment.create', 'success'], ['atc-payments.payment.succeeded', 'success'], ['atc-payments.webhook.rejected', 'denied'],
    ['atc-payments.refund.create', 'success'], ['atc-payments.payment.sync', 'success'],
  ]);
  const [create, provider, , refund] = audit.buffer;
  assert.deepEqual([create.actor, create.target, create.meta], [{ type: 'apikey', id: 'shop' }, { type: 'payment', id: p.id }, { amount: 900, currency: 'eur' }]);
  assert.deepEqual([provider.actor, provider.target], [{ type: 'provider', id: 'stripe' }, { type: 'payment', id: p.id }]);
  const rm = /** @type {any} */ (refund.meta);
  assert.deepEqual([rm.payment, rm.amount, rm.status], [p.id, 100, 'succeeded']);
  const n = audit.buffer.length;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(READ_KEY, 'audit-denied-01'), payload: { amount: 900, currency: 'eur' } })).statusCode, 403);
  assert.deepEqual([audit.buffer.length, audit.buffer.at(-1)?.outcome], [n + 1, 'denied']);
});
