import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe webhook signatures: `Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=…]`, where the HMAC is
 * SHA-256 over `<t>.<raw body>` keyed with the endpoint's signing secret. Compared in constant
 * time; timestamps outside the tolerance are rejected (replay protection).
 */
export class StripeSignature {
  /**
   * @param {string|undefined} header
   * @param {string} rawBody
   * @param {string} secret
   * @param {{ nowSec: number, toleranceSec: number }} o
   * @returns {{ ok: true } | { ok: false, reason: string }}
   */
  static verify(header, rawBody, secret, { nowSec, toleranceSec }) {
    if (!header || header.length > 2_000) return { ok: false, reason: 'missing Stripe-Signature header' };
    let t = NaN;
    /** @type {string[]} */
    const v1 = [];
    for (const part of header.split(',')) {
      const at = part.indexOf('=');
      const k = part.slice(0, at).trim();
      const v = part.slice(at + 1).trim();
      if (k === 't') t = /^\d{1,12}$/.test(v) ? Number(v) : NaN;
      else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
    }
    if (!Number.isFinite(t)) return { ok: false, reason: 'no timestamp in Stripe-Signature' };
    if (!v1.length) return { ok: false, reason: 'no v1 signature in Stripe-Signature' };
    if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: 'signature timestamp outside the tolerance' };
    const expected = Buffer.from(StripeSignature.sign(rawBody, secret, t), 'hex');
    const match = v1.some((s) => timingSafeEqual(Buffer.from(s, 'hex'), expected));
    return match ? { ok: true } : { ok: false, reason: 'signature does not match' };
  }

  /** The hex v1 signature (also used by tests and the fake provider). @param {string} rawBody @param {string} secret @param {number} t */
  static sign(rawBody, secret, t) {
    return createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  }

  /** A complete header value. @param {string} rawBody @param {string} secret @param {number} t */
  static header(rawBody, secret, t) {
    return `t=${t},v1=${StripeSignature.sign(rawBody, secret, t)}`;
  }
}
