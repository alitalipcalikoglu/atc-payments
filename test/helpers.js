import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { PaymentService } from '../src/domain/payment-service.js';
import { PaymentsApi } from '../src/http/payments-api.js';
import { StripeClient } from '../src/net/stripe-client.js';
import { PaymentStore } from '../src/store/payment-store.js';
import { FakeStripe } from './fake-stripe.js';

export const WRITE_KEY = 'w'.repeat(40);
export const READ_KEY = 'r'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return { PORT: '0', LOG_LEVEL: 'silent', DB_PATH: ':memory:', PAYMENTS_API_KEYS: `shop:${WRITE_KEY}:write,dash:${READ_KEY}:read`, ...overrides };
}

/** A clock tests move by hand. */
export function manualClock(start = Date.now()) {
  const c = { t: start, now: () => c.t, advance: (/** @type {number} */ ms) => { c.t += ms; } };
  return c;
}

/**
 * Service wired to a running fake Stripe (provider and webhooks enabled), unless `fake` is null.
 * @param {FakeStripe|null} fake @param {Record<string, string>} [overrides] @param {{ now?: () => number, audit?: any, ops?: any }} [o]
 */
export function testService(fake, overrides = {}, o = {}) {
  const config = Config.fromEnv(testEnv(fake ? { STRIPE_SECRET_KEY: FakeStripe.SECRET_KEY, STRIPE_WEBHOOK_SECRET: FakeStripe.WEBHOOK_SECRET, STRIPE_API_URL: fake.url, ...overrides } : overrides));
  const db = new Database(':memory:');
  const store = new PaymentStore(db);
  const stripe = config.stripe.secretKey ? new StripeClient({ secretKey: config.stripe.secretKey, apiUrl: config.stripe.apiUrl, timeoutMs: config.stripe.timeoutMs }) : null;
  const service = new PaymentService({ config, store, stripe, audit: o.audit, ops: o.ops, now: o.now });
  return { config, db, store, service };
}

/** @param {FakeStripe|null} fake @param {Record<string, string>} [overrides] @param {object} [deps] @param {{ now?: () => number }} [o] */
export async function buildApp(fake, overrides, deps = {}, o = {}) {
  const t = testService(fake, overrides, { ...o, audit: /** @type {any} */ (deps).audit });
  const app = await new PaymentsApi({ ...t, version: readServiceVersion(import.meta.url), ...deps }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key @param {string} [idem] */
export function headers(key, idem) {
  return { authorization: `Bearer ${key}`, ...(idem ? { 'idempotency-key': idem } : {}) };
}
