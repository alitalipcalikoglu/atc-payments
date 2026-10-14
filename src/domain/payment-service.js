import { createHash, randomBytes } from 'node:crypto';
import { StripeSignature } from '../net/stripe-signature.js';
import { StripeError } from '../net/stripe-client.js';
import { PaymentError } from './errors.js';
import { PaymentState } from './payment-state.js';

/** @typedef {import('../types.js').PaymentRow} PaymentRow */
/** @typedef {import('../types.js').RefundRow} RefundRow */
/** @typedef {import('../types.js').PaymentStatus} PaymentStatus */
/** @typedef {import('../types.js').RefundStatus} RefundStatus */
/** @typedef {{ status: number, body: unknown, replayed: boolean }} IdempotentResult */

/**
 * Payments through Stripe. Creates and refunds need a client idempotency key: the first request
 * runs, the same key with the same body replays the stored answer, the same key with another body
 * is refused. The provider gets an idempotency key derived from it, so a retry after a lost
 * response never charges or refunds twice. Webhooks (signature checked, each event id once) and
 * explicit syncs move payments through {@link PaymentState}; money movements are appended to the
 * ledger exactly once; every change queues an event for atc-webhook-out in the same transaction.
 */
export class PaymentService {
  static IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,255}$/;
  static METADATA_LIMITS = Object.freeze({ keys: 20, key: 40, value: 500 });
  static REFUND_REASONS = Object.freeze(['duplicate', 'fraudulent', 'requested_by_customer']);

  /**
   * @param {object} deps
   * @param {import('../config.js').Config} deps.config
   * @param {import('../store/payment-store.js').PaymentStore} deps.store
   * @param {import('../net/stripe-client.js').StripeClient|null} deps.stripe
   * @param {import('../audit/durable-audit.js').AuditSink} [deps.audit]
   * @param {{ publish: (type: string, data?: unknown) => boolean }} [deps.ops]  Operational events (best effort, unlike the outbox).
   * @param {() => number} [deps.now]
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, store, stripe, audit, ops, now = Date.now, logger }) {
    this.config = config;
    this.ops = ops ?? { publish: () => false };
    this.store = store;
    this.stripe = stripe;
    this.audit = audit;
    this.now = now;
    this.logger = logger;
  }

  get enabled() { return this.stripe !== null; }

  /** @param {string} id @returns {PaymentRow} */
  get(id) {
    const p = this.store.payment(id);
    if (!p) throw new PaymentError('PAYMENT_NOT_FOUND', `no payment "${id}"`);
    return p;
  }

  /**
   * Run `fn` once per (API key, idempotency key). Deterministic outcomes (success, or a 4xx
   * refusal) are stored and replayed; transient failures release the key so the client can retry.
   * @param {string} keyId @param {string|undefined} idemKey @param {string} scope @param {unknown} body
   * @param {(providerKey: string) => Promise<{ status: number, body: unknown }>} fn
   * @returns {Promise<IdempotentResult>}
   */
  async idempotent(keyId, idemKey, scope, body, fn) {
    if (!idemKey) throw new PaymentError('IDEMPOTENCY_KEY_REQUIRED', 'send an Idempotency-Key header (8-255 characters) with this request');
    if (!PaymentService.IDEMPOTENCY_KEY.test(idemKey)) throw new PaymentError('INVALID_ARGUMENT', 'Idempotency-Key must be 8-255 characters of letters, digits and ._:-');
    const hash = createHash('sha256').update(`${scope}\n${PaymentService.canonical(body)}`).digest('hex');
    const existing = this.store.idem(keyId, idemKey);
    if (existing) {
      if (existing.scope !== scope || existing.request_hash !== hash) throw new PaymentError('IDEMPOTENCY_MISMATCH', 'this Idempotency-Key was used with a different request');
      if (existing.state === 'in_progress') throw new PaymentError('IDEMPOTENCY_IN_PROGRESS', 'a request with this Idempotency-Key is still running');
      return { status: Number(existing.status_code), body: JSON.parse(String(existing.response)), replayed: true };
    }
    this.store.idemStart(keyId, idemKey, scope, hash, this.now());
    try {
      const out = await fn(`atc-payments:${keyId}:${idemKey}`);
      this.store.idemDone(keyId, idemKey, out.status, out.body);
      return { ...out, replayed: false };
    } catch (err) {
      if (err instanceof PaymentError && err.statusCode < 500) this.store.idemDone(keyId, idemKey, err.statusCode, { error: { code: err.code, message: err.message } });
      else this.store.idemDrop(keyId, idemKey);
      throw err;
    }
  }

  /**
   * @param {{ amount: number, currency: string, description?: string, customerEmail?: string, metadata?: Record<string, string> }} input
   * @param {string} by @param {string} providerKey
   */
  async create(input, by, providerKey) {
    const stripe = this.#provider();
    const currency = input.currency.toLowerCase();
    const { minAmount, maxAmount, currencies } = this.config.limits;
    if (!currencies.includes(currency)) throw new PaymentError('INVALID_ARGUMENT', `currency must be one of ${currencies.join(', ')}`);
    if (input.amount < minAmount || input.amount > maxAmount) throw new PaymentError('INVALID_ARGUMENT', `amount must be between ${minAmount} and ${maxAmount} (minor units)`);
    const metadata = PaymentService.#metadata(input.metadata ?? {});
    const id = PaymentService.#id('pay', this.now());
    const intent = await this.#call(() => stripe.createPaymentIntent({ amount: input.amount, currency, description: input.description, receiptEmail: input.customerEmail, metadata: { ...metadata, atc_payment_id: id } }, providerKey));
    // A replayed provider key returns the intent of the first attempt (and its payment id).
    const known = this.store.byProvider(String(intent.id));
    if (known) return { payment: known, clientSecret: String(intent.client_secret ?? '') };
    const now = this.now();
    /** @type {PaymentRow} */
    const p = {
      id: String(intent.metadata?.atc_payment_id ?? id), provider_id: String(intent.id), status: 'pending', provider_status: String(intent.status ?? ''),
      amount: input.amount, currency, amount_refunded: 0, description: input.description ?? '', customer_email: input.customerEmail ?? null,
      metadata: JSON.stringify(metadata), last_error: null, created_by: by, created_at: now, updated_at: now,
    };
    this.store.tx(() => {
      this.store.insertPayment(p);
      this.#queue('payment.created', this.#event(p), now);
    });
    const after = this.#applyIntent(this.get(p.id), intent, null).payment;
    return { payment: after, clientSecret: String(intent.client_secret ?? '') };
  }

  /** Cancel at the provider; a canceled payment is returned as it is. @param {string} id */
  async cancel(id) {
    const p = this.get(id);
    if (p.status === 'canceled') return p;
    if (!PaymentState.cancelable(p.status)) throw new PaymentError('INVALID_STATE', `a ${p.status} payment cannot be canceled`);
    const stripe = this.#provider();
    const intent = await this.#call(() => stripe.cancelPaymentIntent(p.provider_id, `atc-payments:cancel:${p.id}`));
    return this.#applyIntent(p, intent, null).payment;
  }

  /** Read the intent from the provider and apply its status (when webhooks were missed). @param {string} id */
  async sync(id) {
    const p = this.get(id);
    const stripe = this.#provider();
    const intent = await this.#call(() => stripe.retrievePaymentIntent(p.provider_id));
    const r = this.#applyIntent(p, intent, null);
    for (const re of await this.#call(() => stripe.listRefunds(p.provider_id))) this.#applyProviderRefund(re, null);
    return { payment: this.get(id), changed: r.applied };
  }

  /**
   * Refund all that is left, or `amount` of it.
   * @param {string} id @param {{ amount?: number, reason?: string }} input @param {string} by @param {string} providerKey
   * @returns {Promise<{ refund: RefundRow, payment: PaymentRow }>}
   */
  async refund(id, input, by, providerKey) {
    const p = this.get(id);
    if (!PaymentState.refundable(p.status)) throw new PaymentError('INVALID_STATE', `a ${p.status} payment cannot be refunded`);
    const remaining = p.amount - p.amount_refunded - this.store.pendingRefunded(p.id);
    const amount = input.amount ?? remaining;
    if (amount <= 0 || amount > remaining) throw new PaymentError('AMOUNT_EXCEEDS_REMAINING', `at most ${remaining} can be refunded`, { remaining });
    if (input.reason && !PaymentService.REFUND_REASONS.includes(input.reason)) throw new PaymentError('INVALID_ARGUMENT', `reason must be one of ${PaymentService.REFUND_REASONS.join(', ')}`);
    const stripe = this.#provider();
    const rid = PaymentService.#id('rf', this.now());
    const re = await this.#call(() => stripe.createRefund({ paymentIntent: p.provider_id, amount, reason: input.reason, metadata: { atc_payment_id: p.id, atc_refund_id: rid } }, providerKey));
    const known = this.store.refundByProvider(String(re.id));
    if (!known) {
      const now = this.now();
      this.store.tx(() => {
        this.store.insertRefund({ id: String(re.metadata?.atc_refund_id ?? rid), payment_id: p.id, provider_id: String(re.id), status: 'pending', amount: Number(re.amount ?? amount), reason: input.reason ?? null, failure_reason: null, created_by: by, created_at: now, updated_at: now });
      });
    }
    this.#applyProviderRefund(re, null);
    const refund = /** @type {RefundRow} */ (this.store.refundByProvider(String(re.id)));
    return { refund, payment: this.get(p.id) };
  }

  /**
   * Verify and apply one webhook delivery. Synchronous after verification, so two deliveries of the
   * same event cannot interleave.
   * @param {string} raw @param {string|undefined} signature @param {{ ip?: string }} [ctx]
   * @returns {{ id: string, type: string, outcome: 'applied'|'ignored'|'unknown'|'duplicate' }}
   */
  webhook(raw, signature, ctx = {}) {
    const secret = this.config.stripe.webhookSecret;
    if (!secret) throw new PaymentError('WEBHOOK_DISABLED', 'STRIPE_WEBHOOK_SECRET is not set; webhooks are disabled');
    const v = StripeSignature.verify(signature, raw, secret, { nowSec: Math.floor(this.now() / 1000), toleranceSec: this.config.stripe.toleranceSec });
    if (!v.ok) {
      this.audit?.record({ action: 'atc-payments.webhook.rejected', outcome: 'denied', actor: { type: 'provider', id: 'stripe' }, ip: ctx.ip, meta: { reason: v.reason } });
      throw new PaymentError('INVALID_SIGNATURE', v.reason);
    }
    /** @type {any} */
    let event;
    try { event = JSON.parse(raw); } catch { throw new PaymentError('INVALID_ARGUMENT', 'webhook body is not JSON'); }
    const eventId = String(event?.id ?? '');
    const type = String(event?.type ?? '');
    if (!/^evt_[A-Za-z0-9]{6,}$/.test(eventId) || !type) throw new PaymentError('INVALID_ARGUMENT', 'webhook body is not a Stripe event');
    if (this.store.eventSeen(eventId)) return { id: eventId, type, outcome: 'duplicate' };
    const obj = event.data?.object ?? {};
    const actor = { eventId, type };
    /** @type {{ outcome: 'applied'|'ignored'|'unknown', paymentId: string|null, detail: string|null }} */
    let r = { outcome: 'ignored', paymentId: null, detail: 'event type not handled' };
    if (type.startsWith('payment_intent.') && obj.object === 'payment_intent') {
      const p = this.store.byProvider(String(obj.id));
      if (!p) r = { outcome: 'unknown', paymentId: null, detail: 'payment intent not created through this service' };
      else {
        const a = this.#applyIntent(p, obj, actor);
        r = { outcome: a.applied ? 'applied' : 'ignored', paymentId: p.id, detail: a.detail };
      }
    } else if (type.startsWith('refund.') && obj.object === 'refund') {
      const a = this.#applyProviderRefund(obj, actor);
      r = { outcome: a.outcome, paymentId: a.paymentId, detail: a.detail };
    }
    this.store.eventInsert(eventId, type, r.paymentId, r.outcome, r.detail, this.now());
    return { id: eventId, type, outcome: r.outcome };
  }

  /** Deliver due outbox events. @param {import('../net/webhook-publisher.js').WebhookPublisher} publisher @param {number} [limit] */
  async publishDue(publisher, limit = 50) {
    let sent = 0;
    for (const e of this.store.outboxDue(this.now(), this.config.limits.outboxMaxAttempts, limit)) {
      try {
        await publisher.publish(e);
        this.store.outboxSent(e.seq, this.now());
        sent++;
      } catch (err) {
        const backoff = Math.min(600_000, 1_000 * 2 ** e.attempts);
        const error = err instanceof Error ? err.message : String(err);
        this.store.outboxFailed(e.seq, this.now() + backoff, error);
        if (e.attempts + 1 >= this.config.limits.outboxMaxAttempts) this.ops.publish('ops.payments.outbox_dead', { source: 'atc-payments', seq: e.seq, type: e.type, attempts: e.attempts + 1, error: error.slice(0, 300) });
      }
    }
    return sent;
  }

  /** Drop expired idempotency keys, old provider events and delivered outbox rows. */
  maintain() {
    const now = this.now();
    const days = this.config.limits.eventRetentionDays * 86_400_000;
    return {
      idempotency: this.store.idemPrune(now - this.config.limits.idempotencyHours * 3_600_000),
      events: this.store.eventsPrune(now - days),
      outbox: this.store.outboxPrune(now - days),
    };
  }

  stats() {
    return {
      provider: this.enabled ? 'stripe' : 'disabled', webhooks: this.config.stripe.webhookSecret ? 'enabled' : 'disabled', webhookOut: this.config.webhookOut ? 'enabled' : 'disabled',
      byStatus: this.store.byStatus(), volume24h: this.store.volume(this.now() - 86_400_000), balance: this.store.balance(),
      outbox: this.store.outboxStats(this.config.limits.outboxMaxAttempts), currencies: this.config.limits.currencies,
    };
  }

  /** Stable JSON for hashing: object keys sorted, recursively. @param {unknown} v @returns {string} */
  static canonical(v) {
    if (Array.isArray(v)) return `[${v.map((x) => PaymentService.canonical(x)).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${PaymentService.canonical(/** @type {any} */ (v)[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
  }

  /**
   * Apply a PaymentIntent's provider status. Refused transitions are reported, not applied.
   * @param {PaymentRow} p @param {any} intent @param {{ eventId: string, type: string }|null} source
   * @returns {{ applied: boolean, detail: string|null, payment: PaymentRow }}
   */
  #applyIntent(p, intent, source) {
    const to = PaymentState.fromProvider(String(intent.status ?? ''));
    if (!to) return { applied: false, detail: `unknown provider status "${intent.status}"`, payment: p };
    const error = intent.last_payment_error?.message ? String(intent.last_payment_error.message).slice(0, 500) : null;
    if (p.status === to && (to !== 'pending' || error === p.last_error)) return { applied: false, detail: `already ${to}`, payment: p };
    if (!PaymentState.can(p.status, to)) return { applied: false, detail: `transition ${p.status} → ${to} not allowed`, payment: p };
    const now = this.now();
    this.store.tx(() => {
      this.store.setStatus(p.id, to, String(intent.status), to === 'pending' ? error : null, now);
      if (to === 'succeeded') this.store.ledger(p.id, 'charge', p.amount, p.currency, p.provider_id, now);
      const after = /** @type {PaymentRow} */ (this.store.payment(p.id));
      this.#queue(to === 'pending' && error ? 'payment.failed' : `payment.${to}`, this.#event(after), now);
    });
    const action = to === 'pending' && error ? 'failed' : to;
    if (source) this.audit?.record({ action: `atc-payments.payment.${action}`, actor: { type: 'provider', id: 'stripe' }, target: { type: 'payment', id: p.id }, meta: { event: source.type, eventId: source.eventId } });
    return { applied: true, detail: null, payment: this.get(p.id) };
  }

  /**
   * Apply a provider Refund object. Refunds made elsewhere (the Stripe dashboard) for a payment of
   * this service are recorded too. Succeeded is final here.
   * @param {any} re @param {{ eventId: string, type: string }|null} source
   * @returns {{ outcome: 'applied'|'ignored'|'unknown', paymentId: string|null, detail: string|null }}
   */
  #applyProviderRefund(re, source) {
    const to = /** @type {RefundStatus|null} */ ({ pending: 'pending', requires_action: 'pending', succeeded: 'succeeded', failed: 'failed', canceled: 'canceled' }[String(re.status)] ?? null);
    if (!to) return { outcome: 'ignored', paymentId: null, detail: `unknown refund status "${re.status}"` };
    let r = this.store.refundByProvider(String(re.id));
    const p = r ? this.store.payment(r.payment_id) : this.store.byProvider(String(re.payment_intent ?? ''));
    if (!p) return { outcome: 'unknown', paymentId: null, detail: 'refund of a payment not created through this service' };
    const now = this.now();
    const inserted = !r;
    if (!r) {
      const created = { id: PaymentService.#id('rf', now), payment_id: p.id, provider_id: String(re.id), status: /** @type {RefundStatus} */ ('pending'), amount: Number(re.amount), reason: re.reason ?? null, failure_reason: null, created_by: 'stripe', created_at: now, updated_at: now };
      this.store.insertRefund(created);
      r = created;
    }
    if (r.status === to) return inserted ? { outcome: 'applied', paymentId: p.id, detail: 'refund made at the provider recorded' } : { outcome: 'ignored', paymentId: p.id, detail: `refund already ${to}` };
    if (r.status !== 'pending') return { outcome: 'ignored', paymentId: p.id, detail: `refund ${r.status} → ${to} not applied` };
    const refund = r;
    this.store.tx(() => {
      this.store.setRefund(refund.id, to, to === 'failed' ? String(re.failure_reason ?? 'failed') : null, now);
      if (to === 'succeeded') {
        const cur = /** @type {PaymentRow} */ (this.store.payment(p.id));
        const refunded = Math.min(cur.amount, cur.amount_refunded + refund.amount);
        this.store.ledger(p.id, 'refund', -refund.amount, cur.currency, refund.provider_id, now);
        if (PaymentState.can(cur.status, PaymentState.afterRefund(cur.amount, refunded))) this.store.setRefunded(p.id, PaymentState.afterRefund(cur.amount, refunded), refunded, now);
        const after = /** @type {PaymentRow} */ (this.store.payment(p.id));
        this.#queue('refund.succeeded', { refund: { id: refund.id, amount: refund.amount, currency: cur.currency }, payment: this.#event(after) }, now);
        if (after.status === 'refunded') this.#queue('payment.refunded', this.#event(after), now);
      } else if (to !== 'pending') {
        this.#queue(`refund.${to}`, { refund: { id: refund.id, amount: refund.amount, failureReason: re.failure_reason ?? null }, payment: { id: p.id } }, now);
      }
    });
    if (source) this.audit?.record({ action: `atc-payments.refund.${to}`, actor: { type: 'provider', id: 'stripe' }, target: { type: 'refund', id: refund.id }, meta: { payment: p.id, event: source.type, eventId: source.eventId } });
    return { outcome: 'applied', paymentId: p.id, detail: null };
  }

  /** Queue an event for atc-webhook-out (inside the caller's transaction); nothing when it is not configured. @param {string} type @param {unknown} data @param {number} now */
  #queue(type, data, now) {
    if (this.config.webhookOut) this.store.outbox(type, data, now);
  }

  /** @param {PaymentRow} p */
  #event(p) {
    return { id: p.id, status: p.status, amount: p.amount, currency: p.currency, amountRefunded: p.amount_refunded, metadata: JSON.parse(p.metadata), providerId: p.provider_id };
  }

  #provider() {
    if (!this.stripe) throw new PaymentError('PROVIDER_DISABLED', 'STRIPE_SECRET_KEY is not set; payments are disabled');
    return this.stripe;
  }

  /** Map provider failures: declines 402, other refusals 422, transient 502. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  async #call(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof StripeError)) throw err;
      if (err.transient) throw new PaymentError('PROVIDER_ERROR', `payment provider failed: ${err.message}`, { providerStatus: err.status });
      if (err.status === 402 || err.type === 'card_error') throw new PaymentError('PROVIDER_DECLINED', err.message, { providerCode: err.code });
      throw new PaymentError('PROVIDER_REJECTED', err.message, { providerStatus: err.status, providerCode: err.code });
    }
  }

  /** @param {Record<string, unknown>} m @returns {Record<string, string>} */
  static #metadata(m) {
    const L = PaymentService.METADATA_LIMITS;
    const entries = Object.entries(m);
    if (entries.length > L.keys) throw new PaymentError('INVALID_ARGUMENT', `metadata may have at most ${L.keys} keys`);
    for (const [k, v] of entries) {
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k) || k.startsWith('atc_')) throw new PaymentError('INVALID_ARGUMENT', `metadata key "${k}" must be 1-${L.key} letters, digits or _.- and not start with atc_`);
      if (typeof v !== 'string' || v.length > L.value) throw new PaymentError('INVALID_ARGUMENT', `metadata value of "${k}" must be a string up to ${L.value} characters`);
    }
    return /** @type {Record<string, string>} */ (Object.fromEntries(entries));
  }

  /** @param {string} prefix @param {number} now */
  static #id(prefix, now) {
    return `${prefix}_${now.toString(36)}${randomBytes(8).toString('hex')}`;
  }
}
