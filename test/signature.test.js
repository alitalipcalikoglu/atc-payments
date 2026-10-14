import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaymentState } from '../src/domain/payment-state.js';
import { StripeClient } from '../src/net/stripe-client.js';
import { StripeSignature } from '../src/net/stripe-signature.js';

const SECRET = `whsec_${'s'.repeat(32)}`;
const body = '{"id":"evt_123456","type":"payment_intent.succeeded"}';
const now = 1_800_000_000;
const verify = (/** @type {string|undefined} */ h, b = body) => StripeSignature.verify(h, b, SECRET, { nowSec: now, toleranceSec: 300 });

test('signature: valid, several v1 values, tampered body, wrong secret, old or future timestamp, malformed', () => {
  assert.deepEqual(verify(StripeSignature.header(body, SECRET, now)), { ok: true });
  assert.deepEqual(verify(`t=${now},v1=${'0'.repeat(64)},v1=${StripeSignature.sign(body, SECRET, now)}`), { ok: true }, 'secret rotation sends two v1');
  assert.equal(verify(StripeSignature.header(body, SECRET, now), `${body} `).ok, false);
  assert.equal(verify(StripeSignature.header(body, `whsec_${'x'.repeat(32)}`, now)).ok, false);
  assert.deepEqual(verify(StripeSignature.header(body, SECRET, now - 301)), { ok: false, reason: 'signature timestamp outside the tolerance' });
  assert.equal(verify(StripeSignature.header(body, SECRET, now + 301)).ok, false);
  for (const h of [undefined, '', 'v1=abc', `t=${now}`, `t=x,v1=${'a'.repeat(64)}`, `t=${now},v0=${'a'.repeat(64)}`]) assert.equal(verify(h).ok, false, String(h));
});

test('state machine: allowed and refused transitions, provider mapping', () => {
  assert.equal(PaymentState.can('pending', 'succeeded'), true);
  assert.equal(PaymentState.can('processing', 'pending'), true, 'a failed payment returns to pending');
  assert.equal(PaymentState.can('succeeded', 'pending'), false, 'no going back');
  assert.equal(PaymentState.can('succeeded', 'canceled'), false);
  assert.equal(PaymentState.can('refunded', 'partially_refunded'), false);
  assert.equal(PaymentState.can('canceled', 'succeeded'), false);
  assert.deepEqual(['requires_payment_method', 'requires_action', 'processing', 'succeeded', 'canceled', 'weird'].map((s) => PaymentState.fromProvider(s)), ['pending', 'pending', 'processing', 'succeeded', 'canceled', null]);
  assert.deepEqual([PaymentState.afterRefund(1000, 300), PaymentState.afterRefund(1000, 1000)], ['partially_refunded', 'refunded']);
});

test('stripe client: bracket form encoding', () => {
  assert.equal(StripeClient.encode({ amount: 1000, currency: 'eur', metadata: { order: '42', note: 'a b' }, automatic_payment_methods: { enabled: true }, skip: undefined }).toString(),
    'amount=1000&currency=eur&metadata%5Border%5D=42&metadata%5Bnote%5D=a+b&automatic_payment_methods%5Benabled%5D=true');
});
