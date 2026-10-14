/** @typedef {import('../types.js').PaymentStatus} PaymentStatus */

/**
 * The payment state machine. Provider statuses map onto it; a transition not listed here (an
 * out-of-order webhook moving a succeeded payment back to pending, say) is refused.
 *
 *   pending ──► processing ──► succeeded ──► partially_refunded ──► refunded
 *     │  ▲          │              └──────────────────────────────────▲
 *     │  └──────────┘ (payment failed, back to pending)
 *     └──► canceled ◄── processing
 */
export class PaymentState {
  /** @type {Readonly<Record<PaymentStatus, readonly PaymentStatus[]>>} */
  static TRANSITIONS = Object.freeze({
    pending: ['pending', 'processing', 'succeeded', 'canceled'],
    processing: ['pending', 'succeeded', 'canceled'],
    succeeded: ['partially_refunded', 'refunded'],
    partially_refunded: ['partially_refunded', 'refunded'],
    canceled: [],
    refunded: [],
  });

  /** @param {PaymentStatus} from @param {PaymentStatus} to */
  static can(from, to) {
    return PaymentState.TRANSITIONS[from].includes(to);
  }

  /**
   * Our status for a Stripe PaymentIntent status.
   * @param {string} providerStatus
   * @returns {PaymentStatus|null}
   */
  static fromProvider(providerStatus) {
    switch (providerStatus) {
      case 'requires_payment_method': case 'requires_confirmation': case 'requires_action': case 'requires_capture': return 'pending';
      case 'processing': return 'processing';
      case 'succeeded': return 'succeeded';
      case 'canceled': return 'canceled';
      default: return null;
    }
  }

  /** Status after refunds totalling `refunded` of `amount`. @param {number} amount @param {number} refunded @returns {PaymentStatus} */
  static afterRefund(amount, refunded) {
    return refunded >= amount ? 'refunded' : 'partially_refunded';
  }

  /** @param {PaymentStatus} s */
  static refundable(s) {
    return s === 'succeeded' || s === 'partially_refunded';
  }

  /** @param {PaymentStatus} s */
  static cancelable(s) {
    return s === 'pending' || s === 'processing';
  }
}
