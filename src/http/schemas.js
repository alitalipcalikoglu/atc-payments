/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static paymentId = { type: 'string', pattern: '^pay_[0-9a-z]{6,12}[0-9a-f]{16}$' };

  static create = {
    type: 'object', additionalProperties: false, required: ['amount', 'currency'],
    properties: {
      amount: { type: 'integer', minimum: 1, maximum: 99_999_999 },
      currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
      description: { type: 'string', maxLength: 500 },
      customerEmail: { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
      metadata: { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: 500 } },
    },
  };
  static refund = {
    type: 'object', additionalProperties: false,
    properties: { amount: { type: 'integer', minimum: 1, maximum: 99_999_999 }, reason: { type: 'string', enum: ['duplicate', 'fraudulent', 'requested_by_customer'] } },
  };

  static paymentParams = { type: 'object', properties: { id: Schemas.paymentId }, required: ['id'] };
  static listQuery = {
    type: 'object', additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['pending', 'processing', 'succeeded', 'canceled', 'partially_refunded', 'refunded'] },
      email: { type: 'string', maxLength: 254 },
      currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
      minAmount: { type: 'string', pattern: '^[0-9]{1,9}$' },
      maxAmount: { type: 'string', pattern: '^[0-9]{1,9}$' },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      metaKey: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,40}$' },
      metaValue: { type: 'string', maxLength: 500 },
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' },
      cursor: { type: 'string', pattern: '^[0-9]{1,15}~pay_[0-9a-z]{6,12}[0-9a-f]{16}$' },
    },
  };
  static reconcile = { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' }, repair: { type: 'boolean' } } };
  static ledgerQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, cursor: { type: 'string', pattern: '^[0-9]{1,15}$' } } };
  static eventsQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' } } };
}
