import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StripeClient } from '../src/net/stripe-client.js';

// Contract check against the real Stripe API in TEST mode. Skipped unless STRIPE_TEST_SECRET_KEY (sk_test_...) is set;
// run it before upgrading STRIPE API_VERSION or when the fake's shapes may have drifted. It creates, reads and cancels
// one PaymentIntent and lists its refunds; no money moves.
const key = process.env.STRIPE_TEST_SECRET_KEY ?? '';
const skip = !/^sk_test_/.test(key) && 'set STRIPE_TEST_SECRET_KEY=sk_test_... to run against the real Stripe test mode';

test('live Stripe (test mode): the shapes the service depends on', { skip }, async () => {
  const c = new StripeClient({ secretKey: key, apiUrl: 'https://api.stripe.com', timeoutMs: 15_000 });
  const idem = `atc-live-${Date.now()}`;
  const pi = await c.createPaymentIntent({ amount: 500, currency: 'eur', description: 'atc-payments contract check', metadata: { atc_payment_id: 'pay_contract' } }, idem);
  assert.match(pi.id, /^pi_/);
  assert.equal(pi.status, 'requires_payment_method');
  assert.equal(typeof pi.client_secret, 'string');
  assert.equal(pi.latest_charge, null, 'latest_charge is an id (or null), never an object');
  const again = await c.retrievePaymentIntent(pi.id);
  assert.equal(again.id, pi.id);
  assert.deepEqual(await c.listRefunds(pi.id), []);
  const cleared = await c.clearPersonalData(pi.id, ['atc_payment_id']);
  assert.equal(cleared.description === '' || cleared.description === null, true);
  assert.equal(cleared.metadata.atc_payment_id, undefined, 'an empty string unsets a metadata key');
  const canceled = await c.cancelPaymentIntent(pi.id, `${idem}-cancel`);
  assert.equal(canceled.status, 'canceled');
});
