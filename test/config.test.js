import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults; empty Stripe settings disable the provider and webhooks', () => {
  const c = Config.fromEnv(testEnv({ PORT: '' }));
  assert.equal(c.port, 3019);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['shop', 'write'], ['dash', 'read']]);
  assert.deepEqual([c.stripe.secretKey, c.stripe.webhookSecret, c.stripe.apiUrl, c.stripe.toleranceSec, c.webhookOut], [null, null, 'https://api.stripe.com', 300, null]);
  assert.deepEqual([c.limits.currencies, c.limits.minAmount, c.limits.idempotencyHours], [['usd', 'eur', 'gbp', 'try'], 50, 24]);
  const s = Config.fromEnv(testEnv({ STRIPE_SECRET_KEY: `sk_test_${'a'.repeat(24)}`, STRIPE_WEBHOOK_SECRET: `whsec_${'b'.repeat(32)}`, CURRENCIES: 'EUR', WEBHOOK_OUT_URL: 'http://wh:3009/', WEBHOOK_OUT_API_KEY: 'k'.repeat(40) }));
  assert.deepEqual([Boolean(s.stripe.secretKey), Boolean(s.stripe.webhookSecret), s.limits.currencies, s.webhookOut?.url], [true, true, ['eur'], 'http://wh:3009']);
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ PAYMENTS_API_KEYS: '' }, /PAYMENTS_API_KEYS is required/);
  bad({ PAYMENTS_API_KEYS: `a:${'a'.repeat(40)}:admin` }, /must be read or write/);
  bad({ STRIPE_SECRET_KEY: 'pk_test_abcdefghijkl' }, /secret or restricted key/);
  bad({ STRIPE_WEBHOOK_SECRET: 'secret' }, /whsec_/);
  bad({ STRIPE_API_URL: 'https://api.stripe.com/v1' }, /origin/);
  bad({ CURRENCIES: 'euro' }, /three-letter/);
  bad({ WEBHOOK_OUT_URL: 'http://wh' }, /must be set together/);
  bad({ TLS_KEY_PATH: '/k.pem' }, /must be set together/);
});
