import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FakeStripe } from './fake-stripe.js';
import { READ_KEY, WRITE_KEY, buildApp, headers } from './helpers.js';

/** @type {FakeStripe} */ let fake;
before(async () => { fake = await new FakeStripe().start(); });
after(() => fake.close());

/** A succeeded payment with an open dispute delivered by webhook. @param {any} app */
async function disputed(app) {
  const res = await app.inject({ method: 'POST', url: '/v1/payments', headers: headers(WRITE_KEY, `dsp-${Math.random().toString(36).slice(2, 12)}`), payload: { amount: 4200, currency: 'EUR' } });
  const p = res.json().payment;
  const ok = fake.transition(p.provider.id, 'succeeded');
  await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', headers: { 'stripe-signature': ok.signature, 'content-type': 'application/json' }, payload: ok.body });
  const ev = fake.openDispute(p.provider.id, { reason: 'fraudulent' });
  const wh = await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', headers: { 'stripe-signature': ev.signature, 'content-type': 'application/json' }, payload: ev.body });
  assert.equal(wh.statusCode, 200, wh.body);
  return { payment: p, disputeId: JSON.parse(ev.body).data.object.id };
}

test('disputes: mirrored from webhooks, listed, shown on the payment, in stats', async () => {
  const { app } = await buildApp(fake);
  const { payment, disputeId } = await disputed(app);
  const list = (await app.inject({ url: '/v1/disputes?open=true', headers: headers(READ_KEY) })).json();
  assert.equal(list.items.length, 1);
  const d = list.items[0];
  assert.deepEqual([d.id, d.paymentId, d.amount, d.currency, d.reason, d.status], [disputeId, payment.id, 4200, 'eur', 'fraudulent', 'needs_response']);
  assert.ok(Date.parse(d.evidenceDueBy) > Date.now());
  assert.equal((await app.inject({ url: `/v1/payments/${payment.id}`, headers: headers(READ_KEY) })).json().disputes[0].id, disputeId);
  assert.deepEqual((await app.inject({ url: '/v1/stats', headers: headers(READ_KEY) })).json().disputes, { needs_response: 1 });
  // A later webhook updates the same row.
  const dp = fake.disputes.get(disputeId);
  dp.status = 'won';
  const upd = fake.event('charge.dispute.closed', dp);
  await app.inject({ method: 'POST', url: '/v1/webhooks/stripe', headers: { 'stripe-signature': upd.signature, 'content-type': 'application/json' }, payload: upd.body });
  assert.equal((await app.inject({ url: `/v1/disputes/${disputeId}`, headers: headers(READ_KEY) })).json().dispute.status, 'won');
  assert.equal((await app.inject({ url: '/v1/disputes?open=true', headers: headers(READ_KEY) })).json().items.length, 0);
  await app.close();
});

test('disputes: evidence is saved, merged and submitted through Stripe; closed disputes refuse more', async () => {
  const { app } = await buildApp(fake);
  const { disputeId } = await disputed(app);
  const draft = await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/evidence`, headers: headers(WRITE_KEY), payload: { evidence: { customer_name: 'Ayşe K.', product_description: 'Annual plan' } } });
  assert.equal(draft.statusCode, 200, draft.body);
  assert.equal(draft.json().dispute.status, 'needs_response');
  assert.equal(fake.disputes.get(disputeId).evidence.customer_name, 'Ayşe K.');
  const sent = (await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/evidence`, headers: headers(WRITE_KEY), payload: { evidence: { uncategorized_text: 'Logged in from the same device 14 times after purchase.' }, submit: true } })).json().dispute;
  assert.equal(sent.status, 'under_review');
  assert.deepEqual(Object.keys(sent.evidence).sort(), ['customer_name', 'product_description', 'uncategorized_text']);
  assert.equal(sent.submittedBy, 'shop');
  const again = await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/evidence`, headers: headers(WRITE_KEY), payload: { evidence: { customer_name: 'x' } } });
  assert.deepEqual([again.statusCode, again.json().error.code], [409, 'INVALID_STATE']);
  const bad = await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/evidence`, headers: headers(WRITE_KEY), payload: { evidence: { receipt: 'file_123' } } });
  assert.equal(bad.statusCode, 409, 'state is checked first');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/evidence`, headers: headers(READ_KEY), payload: { evidence: { customer_name: 'x' } } })).statusCode, 403);
  await app.close();
});

test('disputes: unknown evidence fields are refused; accepting concedes and closes as lost', async () => {
  const { app } = await buildApp(fake);
  const { disputeId } = await disputed(app);
  const bad = await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/evidence`, headers: headers(WRITE_KEY), payload: { evidence: { receipt: 'file_123' } } });
  assert.deepEqual([bad.statusCode, bad.json().error.code], [400, 'INVALID_ARGUMENT']);
  const acc = await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/accept`, headers: headers(WRITE_KEY) });
  assert.equal(acc.json().dispute.status, 'lost');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/disputes/${disputeId}/accept`, headers: headers(WRITE_KEY) })).statusCode, 409);
  assert.equal((await app.inject({ url: '/v1/disputes/dp_missing0000', headers: headers(READ_KEY) })).json().error.code, 'DISPUTE_NOT_FOUND');
  await app.close();
});
