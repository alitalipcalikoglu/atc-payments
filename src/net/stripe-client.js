/** A failed Stripe call: HTTP status (0 for network/timeout), Stripe error type and code. */
export class StripeError extends Error {
  /**
   * @param {string} message
   * @param {{ status: number, type?: string|null, code?: string|null }} info
   */
  constructor(message, { status, type = null, code = null }) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.type = type;
    this.code = code;
  }

  /** Network errors, timeouts, 429 and 5xx may succeed when retried with the same idempotency key. */
  get transient() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/**
 * Minimal Stripe REST client over fetch (no SDK): form-encoded requests, bearer secret key,
 * `Idempotency-Key` on every create, pinned API version, bounded time, no redirects.
 */
export class StripeClient {
  static API_VERSION = '2024-06-20';

  /**
   * @param {{ secretKey: string, apiUrl: string, timeoutMs: number }} o
   * @param {typeof fetch} [fetchImpl]
   */
  constructor({ secretKey, apiUrl, timeoutMs }, fetchImpl = fetch) {
    this.secretKey = secretKey;
    this.apiUrl = apiUrl;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  /**
   * Stripe's bracket form encoding: `metadata[order]=42`, `automatic_payment_methods[enabled]=true`.
   * @param {Record<string, unknown>} params @param {string} [prefix] @param {URLSearchParams} [out]
   */
  static encode(params, prefix = '', out = new URLSearchParams()) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (typeof v === 'object' && !Array.isArray(v)) StripeClient.encode(/** @type {Record<string, unknown>} */ (v), key, out);
      else out.append(key, String(v));
    }
    return out;
  }

  /**
   * @param {{ amount: number, currency: string, description?: string, receiptEmail?: string|null, metadata: Record<string, string> }} p
   * @param {string} idempotencyKey
   */
  createPaymentIntent(p, idempotencyKey) {
    return this.#call('POST', '/v1/payment_intents', {
      amount: p.amount, currency: p.currency, description: p.description || undefined, receipt_email: p.receiptEmail || undefined,
      metadata: p.metadata, automatic_payment_methods: { enabled: true },
    }, idempotencyKey);
  }

  /** @param {string} id */
  retrievePaymentIntent(id) {
    return this.#call('GET', `/v1/payment_intents/${encodeURIComponent(id)}`);
  }

  /** @param {string} id @param {string} idempotencyKey */
  cancelPaymentIntent(id, idempotencyKey) {
    return this.#call('POST', `/v1/payment_intents/${encodeURIComponent(id)}/cancel`, {}, idempotencyKey);
  }

  /**
   * @param {{ paymentIntent: string, amount: number, reason?: string|null, metadata: Record<string, string> }} p
   * @param {string} idempotencyKey
   */
  createRefund(p, idempotencyKey) {
    return this.#call('POST', '/v1/refunds', { payment_intent: p.paymentIntent, amount: p.amount, reason: p.reason || undefined, metadata: p.metadata }, idempotencyKey);
  }

  /**
   * @param {'GET'|'POST'} method @param {string} path @param {Record<string, unknown>} [params] @param {string} [idempotencyKey]
   * @returns {Promise<any>}
   */
  async #call(method, path, params, idempotencyKey) {
    /** @type {Record<string, string>} */
    const headers = { authorization: `Bearer ${this.secretKey}`, 'stripe-version': StripeClient.API_VERSION, accept: 'application/json' };
    let body;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = StripeClient.encode(params ?? {}).toString();
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    }
    let res;
    try {
      res = await this.fetch(`${this.apiUrl}${path}`, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new StripeError(timeout ? `Stripe timed out after ${this.timeoutMs}ms` : `Stripe unreachable: ${err instanceof Error ? err.message : String(err)}`, { status: 0 });
    }
    const text = await res.text().catch(() => '');
    /** @type {any} */
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const e = data?.error ?? {};
      throw new StripeError(String(e.message ?? `Stripe responded ${res.status}`).slice(0, 500), { status: res.status, type: e.type ?? null, code: e.decline_code ?? e.code ?? null });
    }
    if (!data || typeof data !== 'object') throw new StripeError('Stripe returned a body that is not JSON', { status: 502 });
    return data;
  }
}
