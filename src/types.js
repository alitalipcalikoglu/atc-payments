/**
 * Shared JSDoc typedefs for the payments service. No runtime exports.
 */

/** @typedef {'read'|'write'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 */

/**
 * @typedef {object} StripeSettings
 * @property {string|null} secretKey      null = provider disabled.
 * @property {string|null} webhookSecret  null = webhook endpoint disabled.
 * @property {string} apiUrl
 * @property {number} timeoutMs
 * @property {number} toleranceSec        Accepted age of a webhook signature timestamp.
 */

/**
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string|undefined} dbBackupDir
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {StripeSettings} stripe
 * @property {{ url: string, apiKey: string, timeoutMs: number }|null} webhookOut
 * @property {{ currencies: string[], minAmount: number, maxAmount: number, idempotencyHours: number, eventRetentionDays: number, outboxMs: number, outboxMaxAttempts: number }} limits
 */

/** @typedef {'pending'|'processing'|'succeeded'|'canceled'|'partially_refunded'|'refunded'} PaymentStatus */
/** @typedef {'pending'|'succeeded'|'failed'|'canceled'} RefundStatus */

/**
 * @typedef {object} PaymentRow
 * @property {string} id
 * @property {string} provider_id      Stripe PaymentIntent id.
 * @property {PaymentStatus} status
 * @property {string|null} provider_status
 * @property {number} amount           Minor units.
 * @property {string} currency
 * @property {number} amount_refunded
 * @property {string} description
 * @property {string|null} customer_email
 * @property {string} metadata         JSON object.
 * @property {string|null} last_error
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} RefundRow
 * @property {string} id
 * @property {string} payment_id
 * @property {string} provider_id
 * @property {RefundStatus} status
 * @property {number} amount
 * @property {string|null} reason
 * @property {string|null} failure_reason
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} LedgerRow
 * @property {number} seq
 * @property {string} payment_id
 * @property {'charge'|'refund'} kind
 * @property {number} amount           Signed minor units: charges positive, refunds negative.
 * @property {string} currency
 * @property {string} ref              Provider object id (PaymentIntent or Refund).
 * @property {number} at
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
