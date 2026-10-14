import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StripeClient, StripeError } from '../src/net/stripe-client.js';
import { StripeSignature } from '../src/net/stripe-signature.js';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { PaymentService } from '../src/domain/payment-service.js';
import { PaymentStore } from '../src/store/payment-store.js';
import { cardDeclined, event, paymentIntent, rateLimited, refund, refundList } from './fixtures/stripe.js';
import { testEnv } from './helpers.js';

const json = (/** @type {number} */ status, /** @type {unknown} */ body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** @param {(url: URL, init: any) => Response} handler */
const client = (handler) => {
  /** @type {{ url: URL, init: any }[]} */ const calls = [];
  const c = new StripeClient({ secretKey: `sk_test_${'a'.repeat(24)}`, apiUrl: 'https://api.stripe.test', timeoutMs: 1000 }, /** @type {any} */ (async (/** @type {string} */ u, /** @type {any} */ init) => { const url = new URL(u); calls.push({ url, init }); return handler(url, init); }));
  return { c, calls };
};

test('listRefunds: reads GET /v1/refunds?payment_intent=…, follows has_more with starting_after', async () => {
  const pages = [refundList([refund({ id: 're_1' }), refund({ id: 're_2' })], true), refundList([refund({ id: 're_3' })])];
  const { c, calls } = client(() => json(200, pages.shift()));
  const all = await c.listRefunds('pi_3PqXyz2eZvKYlo2C0abcd123');
  assert.deepEqual(all.map((r) => r.id), ['re_1', 're_2', 're_3']);
  assert.deepEqual(calls.map((x) => [x.init.method, x.url.pathname, x.url.searchParams.get('payment_intent'), x.url.searchParams.get('starting_after'), x.url.searchParams.get('limit')]), [['GET', '/v1/refunds', 'pi_3PqXyz2eZvKYlo2C0abcd123', null, '100'], ['GET', '/v1/refunds', 'pi_3PqXyz2eZvKYlo2C0abcd123', 're_2', '100']]);
  assert.equal(calls[0].init.headers['stripe-version'], '2024-06-20');
});

test('errors: card errors keep the decline code; 429 and 5xx are transient; a non-JSON body is a safe error', async () => {
  const declined = await client(() => json(402, cardDeclined)).c.createPaymentIntent({ amount: 100, currency: 'eur', metadata: {} }, 'k').catch((e) => e);
  assert.ok(declined instanceof StripeError);
  assert.deepEqual([declined.status, declined.code, declined.type, declined.transient], [402, 'insufficient_funds', 'card_error', false]);
  const limited = await client(() => json(429, rateLimited)).c.retrievePaymentIntent('pi_1').catch((e) => e);
  assert.deepEqual([limited.transient, limited.code], [true, 'rate_limit']);
  const html = await client(() => new Response('<html>bad gateway</html>', { status: 502 })).c.retrievePaymentIntent('pi_1').catch((e) => e);
  assert.deepEqual([html.transient, html.message], [true, 'Stripe responded 502']);
});

test('sync against real-shaped payloads: latest_charge is an id, refunds come from the list endpoint, dashboard refunds are recorded', async () => {
  const config = Config.fromEnv(testEnv({ STRIPE_SECRET_KEY: `sk_test_${'a'.repeat(24)}`, STRIPE_WEBHOOK_SECRET: `whsec_${'b'.repeat(32)}` }));
  const db = new Database(':memory:');
  const store = new PaymentStore(db);
  const pi = paymentIntent({ status: 'succeeded', amount_received: 2500, latest_charge: 'ch_3PqXyz2eZvKYlo2C0mno012' });
  const { c } = client((url) => (url.pathname === '/v1/refunds' ? json(200, refundList([refund({ id: 're_dash', amount: 700, metadata: {} })])) : json(200, pi)));
  const service = new PaymentService({ config, store, stripe: c });
  const now = Date.now();
  store.insertPayment({ id: 'pay_x', provider_id: pi.id, status: 'processing', provider_status: 'processing', amount: 2500, currency: 'eur', amount_refunded: 0, description: '', customer_email: null, metadata: '{}', last_error: null, created_by: 'shop', created_at: now, updated_at: now });
  const r = await service.sync('pay_x');
  assert.deepEqual([r.changed, r.payment.status, r.payment.amount_refunded], [true, 'partially_refunded', 700]);
  assert.deepEqual(store.ledgerOf('pay_x').map((l) => [l.kind, l.amount]), [['charge', 2500], ['refund', -700]]);
  assert.equal(store.refundByProvider('re_dash')?.created_by, 'stripe');
});

test('webhook with real-shaped events: signature over the raw body, refund.created from the dashboard, payment_intent.succeeded', () => {
  const secret = `whsec_${'b'.repeat(32)}`;
  const config = Config.fromEnv(testEnv({ STRIPE_SECRET_KEY: `sk_test_${'a'.repeat(24)}`, STRIPE_WEBHOOK_SECRET: secret }));
  const db = new Database(':memory:');
  const store = new PaymentStore(db);
  const service = new PaymentService({ config, store, stripe: null });
  const pi = paymentIntent({ status: 'processing' });
  const now = Date.now();
  store.insertPayment({ id: 'pay_y', provider_id: pi.id, status: 'processing', provider_status: 'processing', amount: 2500, currency: 'eur', amount_refunded: 0, description: '', customer_email: null, metadata: '{}', last_error: null, created_by: 'shop', created_at: now, updated_at: now });
  const deliver = (/** @type {string} */ type, /** @type {unknown} */ object) => {
    const raw = JSON.stringify(event(type, object));
    return service.webhook(raw, StripeSignature.header(raw, secret, Math.floor(Date.now() / 1000)));
  };
  assert.equal(deliver('payment_intent.succeeded', paymentIntent({ status: 'succeeded', latest_charge: 'ch_1' })).outcome, 'applied');
  assert.equal(deliver('refund.created', refund({ amount: 500 })).outcome, 'applied');
  assert.equal(store.payment('pay_y')?.amount_refunded, 500);
});
