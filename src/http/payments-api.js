import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { PaymentError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';
import { AuditMetrics } from '../audit-metrics.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */
/** @typedef {import('fastify').FastifyReply} FastifyReply */

/**
 * HTTP surface. `/v1/*` needs a bearer key: `read` lists payments, refunds, the ledger and
 * provider events; `write` creates (Idempotency-Key required), cancels, syncs and refunds
 * (Idempotency-Key required). `POST /v1/webhooks/stripe` takes no key; the Stripe signature is the
 * authentication.
 */
export class PaymentsApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/payment-service.js').PaymentService} deps.service
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('../audit/durable-audit.js').AuditSink} [deps.audit]
   */
  constructor({ config, audit, service, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    app.setErrorHandler(createErrorHandler(PaymentError));
    app.addHook('onSend', AuditClient.hook(/** @type {any} */ (this.audit)));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    registerProbes(app, () => this.db.ping(), {
      cacheMs: PaymentsApi.READY_CACHE_MS,
      extra: () => ({ provider: this.service.enabled ? 'stripe' : 'disabled', webhooks: config.stripe.webhookSecret ? 'enabled' : 'disabled', webhookOut: config.webhookOut ? 'enabled' : 'disabled' }),
    });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, { service: 'atc-payments', version: this.version, capabilities: ['stripe', 'payment-intents', 'refunds', 'idempotency-keys', 'signed-webhooks', 'ledger', 'webhook-out-events'], schemaVersion: this.db.schemaVersion });
    await app.register((wh) => this.#registerWebhooks(wh));
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** The raw body is what Stripe signed, so this route reads it as a string. @param {FastifyInstance} wh */
  async #registerWebhooks(wh) {
    wh.removeAllContentTypeParsers();
    wh.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));
    wh.post('/v1/webhooks/stripe', async (request) => {
      const raw = typeof request.body === 'string' ? request.body : '';
      const r = this.service.webhook(raw, /** @type {string|undefined} */ (request.headers['stripe-signature']), { ip: request.ip });
      return { received: true, ...r };
    });
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const write = { preHandler: ApiKeyAuth.require('write') };
    const pid = (/** @type {FastifyRequest} */ r) => /** @type {{ id: string }} */ (r.params).id;
    const idem = (/** @type {FastifyRequest} */ r) => /** @type {string|undefined} */ (r.headers['idempotency-key']);
    const target = (/** @type {FastifyRequest} */ r) => ({ type: 'payment', id: pid(r) });
    /** @param {FastifyReply} reply @param {import('../domain/payment-service.js').IdempotentResult} out */
    const send = (reply, out) => reply.code(out.status).header('idempotent-replayed', String(out.replayed)).send(out.body);
    const detail = (/** @type {string} */ id) => {
      const p = s.get(id);
      return { payment: Views.payment(p), refunds: s.store.refundsOf(p.id).map(Views.refund), ledger: s.store.ledgerOf(p.id).map(Views.ledger), refundable: ['succeeded', 'partially_refunded'].includes(p.status) ? p.amount - p.amount_refunded - s.store.pendingRefunded(p.id) : 0 };
    };

    api.post('/payments', { config: { audit: AuditClient.route('atc-payments.payment.create', (_r, b) => (b?.payment?.id ? { type: 'payment', id: b.payment.id } : null), (_r, b) => (b?.payment ? { amount: b.payment.amount, currency: b.payment.currency } : undefined)) }, ...write, schema: { body: Schemas.create } }, async (request, reply) => {
      const body = /** @type {any} */ (request.body);
      const out = await s.idempotent(request.apiKey.id, idem(request), 'create', body, async (providerKey) => {
        const r = await s.create(body, request.apiKey.id, providerKey);
        return { status: 201, body: { payment: Views.payment(r.payment), clientSecret: r.clientSecret } };
      });
      return send(reply, out);
    });

    api.get('/payments', { ...read, schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = /** @type {{ status?: string, limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 50;
      const [at, id] = q.cursor ? q.cursor.split('~') : [];
      const rows = s.store.payments({ status: q.status, before: q.cursor ? { at: Number(at), id } : undefined, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map(Views.payment), nextCursor: rows.length > limit && last ? `${last.created_at}~${last.id}` : null };
    });

    api.get('/payments/:id', { ...read, schema: { params: Schemas.paymentParams } }, async (request) => detail(pid(request)));

    api.post('/payments/:id/cancel', { config: { audit: AuditClient.route('atc-payments.payment.cancel', target) }, ...write, schema: { params: Schemas.paymentParams } }, async (request) => {
      await s.cancel(pid(request));
      return detail(pid(request));
    });

    api.post('/payments/:id/sync', { config: { audit: AuditClient.route('atc-payments.payment.sync', target, (_r, b) => ({ status: b?.payment?.status })) }, ...write, schema: { params: Schemas.paymentParams } }, async (request) => {
      const r = await s.sync(pid(request));
      return { ...detail(pid(request)), changed: r.changed };
    });

    api.post('/payments/:id/refunds', { config: { audit: AuditClient.route('atc-payments.refund.create', (_r, b) => (b?.refund?.id ? { type: 'refund', id: b.refund.id } : null), (r, b) => ({ payment: pid(r), amount: b?.refund?.amount, status: b?.refund?.status })) }, ...write, schema: { params: Schemas.paymentParams, body: Schemas.refund } }, async (request, reply) => {
      const body = /** @type {any} */ (request.body ?? {});
      const id = pid(request);
      const out = await s.idempotent(request.apiKey.id, idem(request), `refund:${id}`, body, async (providerKey) => {
        const r = await s.refund(id, body, request.apiKey.id, providerKey);
        return { status: 201, body: { refund: Views.refund(r.refund), payment: Views.payment(r.payment) } };
      });
      return send(reply, out);
    });

    api.get('/ledger', { ...read, schema: { querystring: Schemas.ledgerQuery } }, async (request) => {
      const q = /** @type {{ limit?: string, cursor?: string }} */ (request.query);
      const limit = q.limit ? Number(q.limit) : 50;
      const rows = s.store.ledgerPage(q.cursor ? Number(q.cursor) : Number.MAX_SAFE_INTEGER, limit + 1);
      const page = rows.slice(0, limit);
      return { items: page.map(Views.ledger), balance: s.store.balance(), nextCursor: rows.length > limit ? String(page.at(-1)?.seq) : null };
    });

    api.get('/provider-events', { ...read, schema: { querystring: Schemas.eventsQuery } }, async (request) => {
      const q = /** @type {{ limit?: string }} */ (request.query);
      return { items: s.store.events(q.limit ? Number(q.limit) : 50).map(Views.event) };
    });

    api.get('/stats', read, async () => s.stats());
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (_request, reply) => {
      const st = this.service.stats();
      const label = (/** @type {string} */ v) => v.replace(/[\\"\n]/g, '\\$&');
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP payments_total Payments by status.',
        '# TYPE payments_total gauge',
        ...Object.entries(st.byStatus).map(([k, v]) => `payments_total{status="${label(k)}"} ${v}`),
        '# HELP payments_ledger_net Net ledger balance (minor units) by currency.',
        '# TYPE payments_ledger_net gauge',
        ...st.balance.map((b) => `payments_ledger_net{currency="${label(b.currency)}"} ${b.net}`),
        '# HELP payments_outbox_pending Events waiting for atc-webhook-out; dead = attempts used up.',
        '# TYPE payments_outbox_pending gauge',
        `payments_outbox_pending{state="pending"} ${st.outbox.pending}`,
        `payments_outbox_pending{state="dead"} ${st.outbox.dead}`,
        '# HELP payments_provider_enabled Whether STRIPE_SECRET_KEY is set.',
        '# TYPE payments_provider_enabled gauge',
        `payments_provider_enabled ${st.provider === 'stripe' ? 1 : 0}`,
        ...AuditMetrics.lines(this.audit),
        '# HELP payments_process_uptime_seconds Process uptime.',
        '# TYPE payments_process_uptime_seconds gauge',
        `payments_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
