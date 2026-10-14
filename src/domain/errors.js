/** Domain error with a stable code and the HTTP status the API maps it to. */
export class PaymentError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    PAYMENT_NOT_FOUND: 404,
    INVALID_STATE: 409,
    IDEMPOTENCY_MISMATCH: 409,
    IDEMPOTENCY_IN_PROGRESS: 409,
    AMOUNT_EXCEEDS_REMAINING: 409,
    INVALID_ARGUMENT: 400,
    IDEMPOTENCY_KEY_REQUIRED: 400,
    PROVIDER_DECLINED: 402,
    PROVIDER_REJECTED: 422,
    FORBIDDEN: 403,
    INVALID_SIGNATURE: 400,
    PROVIDER_ERROR: 502,
    PROVIDER_DISABLED: 503,
    WEBHOOK_DISABLED: 503,
  };

  /**
   * @param {keyof typeof PaymentError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.statusCode = PaymentError.STATUS[code];
    this.details = details;
  }
}
