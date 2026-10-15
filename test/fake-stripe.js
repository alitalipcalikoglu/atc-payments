import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { StripeSignature } from '../src/net/stripe-signature.js';

/**
 * A local stand-in for the parts of the Stripe API this service uses: payment intents (create,
 * retrieve, cancel), refunds, idempotency keys, bearer auth, Stripe-shaped errors, and signed
 * webhook events. Tests never talk to the real Stripe and never need real keys.
 *
 * Standalone (manual checks): `node test/fake-stripe.js 12111` prints the key and signing secret;
 * `POST /_fake/payment_intents/<id>` with `status=succeeded` moves an intent and answers the event.
 */
export class FakeStripe {
  static SECRET_KEY = `sk_test_${'f'.repeat(24)}`;
  static WEBHOOK_SECRET = `whsec_${'w'.repeat(32)}`;

  constructor() {
    /** @type {Map<string, any>} */ this.intents = new Map();
    /** @type {Map<string, any>} */ this.refunds = new Map();
    /** @type {Map<string, any>} */ this.disputes = new Map();
    /** @type {Map<string, { status: number, body: any }>} */ this.idempotency = new Map();
    /** @type {{ method: string, path: string, idempotencyKey: string|null, params: Record<string, string> }[]} */ this.requests = [];
    /** Answer the next N requests with this status (transient-failure tests). */
    this.failNext = { count: 0, status: 500 };
    this.server = createServer((req, res) => this.#handle(req, res));
    this.url = '';
  }

  async start(port = 0) {
    await new Promise((r) => this.server.listen(port, '127.0.0.1', () => r(undefined)));
    this.url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (this.server.address()).port}`;
    return this;
  }

  close() {
    return new Promise((r) => { this.server.closeAllConnections(); this.server.close(() => r(undefined)); });
  }

  /** Move an intent to a status and return a signed `payment_intent.*` event for it. @param {string} id @param {string} status @param {{ error?: string, type?: string }} [o] */
  transition(id, status, o = {}) {
    const pi = this.intents.get(id);
    pi.status = status;
    pi.last_payment_error = o.error ? { message: o.error, type: 'card_error' } : null;
    const type = o.type ?? { succeeded: 'payment_intent.succeeded', processing: 'payment_intent.processing', canceled: 'payment_intent.canceled', requires_payment_method: 'payment_intent.payment_failed' }[status] ?? 'payment_intent.updated';
    return this.event(type, pi);
  }

  /** Move a refund to a status and return a signed `refund.updated` event. @param {string} id @param {string} status */
  refundTo(id, status) {
    const re = this.refunds.get(id);
    re.status = status;
    if (status === 'failed') re.failure_reason = 'expired_or_canceled_card';
    return this.event(status === 'failed' ? 'refund.failed' : 'refund.updated', re);
  }

  /**
   * Open a dispute on a succeeded intent and return the signed `charge.dispute.created` event.
   * @param {string} intentId @param {{ reason?: string, status?: string, amount?: number }} [o]
   */
  openDispute(intentId, o = {}) {
    const pi = this.intents.get(intentId);
    const id = `dp_${randomBytes(12).toString('hex')}`;
    const dp = { id, object: 'dispute', amount: o.amount ?? pi.amount, currency: pi.currency, payment_intent: pi.id, charge: `ch_${pi.id.slice(3)}`, reason: o.reason ?? 'product_not_received', status: o.status ?? 'needs_response',
      evidence: {}, evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86_400, submission_count: 0 } };
    this.disputes.set(id, dp);
    return this.event('charge.dispute.created', dp);
  }

  /** A signed event delivery. @param {string} type @param {any} object @param {{ secret?: string, t?: number }} [o] */
  event(type, object, o = {}) {
    const body = JSON.stringify({ id: `evt_${randomBytes(12).toString('hex')}`, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object: structuredClone(object) } });
    const t = o.t ?? Math.floor(Date.now() / 1000);
    return { body, signature: StripeSignature.header(body, o.secret ?? FakeStripe.WEBHOOK_SECRET, t) };
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  #handle(req, res) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (/** @type {number} */ status, /** @type {any} */ body) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
      const fail = (/** @type {number} */ status, /** @type {string} */ type, /** @type {string} */ message, /** @type {string} */ code = '') => send(status, { error: { type, message, code } });
      const params = Object.fromEntries(new URLSearchParams(raw));
      const path = String(req.url).split('?')[0];
      const key = /** @type {string|undefined} */ (req.headers['idempotency-key']) ?? null;
      this.requests.push({ method: String(req.method), path, idempotencyKey: key, params });
      if (req.headers.authorization !== `Bearer ${FakeStripe.SECRET_KEY}`) return fail(401, 'invalid_request_error', 'Invalid API Key provided');
      // Manual checks only: move an intent the way a customer's browser would (`status=succeeded`).
      const manual = /^\/_fake\/payment_intents\/([^/]+)$/.exec(path);
      if (manual && req.method === 'POST') {
        const pi = this.intents.get(manual[1]);
        if (!pi) return fail(404, 'invalid_request_error', 'no such intent');
        return send(200, JSON.parse(this.transition(pi.id, params.status, { error: params.error }).body));
      }
      if (this.failNext.count > 0) { this.failNext.count--; return fail(this.failNext.status, 'api_error', 'Something went wrong on our end'); }
      const replay = key ? this.idempotency.get(`${req.method} ${path} ${key}`) : undefined;
      if (replay) return send(replay.status, replay.body);
      const remember = (/** @type {number} */ status, /** @type {any} */ body) => { if (key) this.idempotency.set(`${req.method} ${path} ${key}`, { status, body }); send(status, body); };
      const metadata = Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]));

      if (req.method === 'POST' && path === '/v1/payment_intents') {
        if (!params.amount || !params.currency) return fail(400, 'invalid_request_error', 'Missing required param: amount.', 'parameter_missing');
        if (params.amount === '402') return remember(402, { error: { type: 'card_error', message: 'Your card was declined.', code: 'card_declined', decline_code: 'generic_decline' } });
        const id = `pi_${randomBytes(12).toString('hex')}`;
        const pi = { id, object: 'payment_intent', amount: Number(params.amount), currency: params.currency, status: 'requires_payment_method', client_secret: `${id}_secret_${randomBytes(8).toString('hex')}`, description: params.description ?? null, receipt_email: params.receipt_email ?? null, metadata, last_payment_error: null, latest_charge: null };
        this.intents.set(id, pi);
        return remember(200, pi);
      }
      const intent = /^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/.exec(path);
      if (intent) {
        const pi = this.intents.get(intent[1]);
        if (!pi) return fail(404, 'invalid_request_error', `No such payment_intent: '${intent[1]}'`, 'resource_missing');
        // Real shape: latest_charge is only an id; refunds are read through GET /v1/refunds.
        if (req.method === 'GET' && !intent[2]) return send(200, { ...pi, latest_charge: pi.status === 'succeeded' ? `ch_${pi.id.slice(3)}` : null });
        if (req.method === 'POST' && !intent[2]) {
          // Update: empty strings unset a field or a metadata key, as the real API does.
          if ('receipt_email' in params) pi.receipt_email = params.receipt_email || null;
          if ('description' in params) pi.description = params.description || null;
          for (const [k, v] of Object.entries(metadata)) { if (v === '') delete pi.metadata[k]; else pi.metadata[k] = v; }
          return remember(200, pi);
        }
        if (req.method === 'POST' && intent[2]) {
          if (pi.status === 'succeeded' || pi.status === 'canceled') return remember(400, { error: { type: 'invalid_request_error', message: `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`, code: 'payment_intent_unexpected_state' } });
          pi.status = 'canceled';
          return remember(200, pi);
        }
      }
      const dispute = /^\/v1\/disputes\/([^/]+)(\/close)?$/.exec(path);
      if (dispute && req.method === 'POST') {
        const dp = this.disputes.get(decodeURIComponent(dispute[1]));
        if (!dp) return fail(404, 'invalid_request_error', `No such dispute: '${dispute[1]}'`, 'resource_missing');
        if (!['needs_response', 'warning_needs_response'].includes(dp.status)) return fail(400, 'invalid_request_error', `This dispute is already ${dp.status}.`, 'dispute_already_closed');
        if (dispute[2]) { dp.status = 'lost'; return send(200, dp); }
        for (const [k, v] of Object.entries(params)) { const m = /^evidence\[([a-z_]+)\]$/.exec(k); if (m) dp.evidence[m[1]] = v; }
        if (params.submit === 'true') { dp.status = 'under_review'; dp.evidence_details.submission_count++; }
        return send(200, dp);
      }
      if (req.method === 'GET' && path === '/v1/refunds') {
        const q = new URL(String(req.url), 'http://x').searchParams;
        const all = [...this.refunds.values()].filter((r) => r.payment_intent === q.get('payment_intent'));
        const start = q.get('starting_after') ? all.findIndex((r) => r.id === q.get('starting_after')) + 1 : 0;
        const limit = Number(q.get('limit') ?? 10);
        return send(200, { object: 'list', url: '/v1/refunds', data: all.slice(start, start + limit), has_more: start + limit < all.length });
      }
      if (req.method === 'POST' && path === '/v1/refunds') {
        const pi = this.intents.get(params.payment_intent);
        if (!pi) return fail(404, 'invalid_request_error', `No such payment_intent: '${params.payment_intent}'`, 'resource_missing');
        if (pi.status !== 'succeeded') return remember(400, { error: { type: 'invalid_request_error', message: 'This PaymentIntent has not succeeded.', code: 'charge_not_refundable' } });
        const id = `re_${randomBytes(12).toString('hex')}`;
        const re = { id, object: 'refund', amount: Number(params.amount ?? pi.amount), currency: pi.currency, payment_intent: pi.id, reason: params.reason ?? null, status: Number(params.amount) === 1234 ? 'pending' : 'succeeded', metadata, failure_reason: null };
        this.refunds.set(id, re);
        return remember(200, re);
      }
      fail(404, 'invalid_request_error', `Unrecognized request URL (${req.method}: ${path})`);
    });
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const f = await new FakeStripe().start(Number(process.argv[2] ?? 12111));
  console.log(JSON.stringify({ url: f.url, STRIPE_SECRET_KEY: FakeStripe.SECRET_KEY, STRIPE_WEBHOOK_SECRET: FakeStripe.WEBHOOK_SECRET }));
}
