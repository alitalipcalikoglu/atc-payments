// Payloads in the shape the real Stripe API returns (API version 2024-06-20), trimmed to what is
// stable and relevant. They differ from test/fake-stripe.js on purpose: the fake is convenient, these
// are the contract. In particular `latest_charge` is an id string, a Charge has no embedded refund
// list, lists are `{ object: 'list', data, has_more }`, and errors carry `decline_code`.

/** @param {Record<string, unknown>} [o] */
export const paymentIntent = (o = {}) => ({
  id: 'pi_3PqXyz2eZvKYlo2C0abcd123', object: 'payment_intent', amount: 2500, amount_capturable: 0, amount_received: 0, currency: 'eur',
  status: 'requires_payment_method', client_secret: 'pi_3PqXyz2eZvKYlo2C0abcd123_secret_AbCdEfGhIjKlMnOpQrStUvWx',
  automatic_payment_methods: { enabled: true, allow_redirects: 'always' }, capture_method: 'automatic', confirmation_method: 'automatic',
  created: 1_792_000_000, customer: null, description: 'Order 1042', last_payment_error: null, latest_charge: null, livemode: false,
  metadata: { order: '1042', atc_payment_id: 'pay_x' }, payment_method: null, receipt_email: null, setup_future_usage: null,
  ...o,
});

/** @param {Record<string, unknown>} [o] */
export const refund = (o = {}) => ({
  id: 're_3PqXyz2eZvKYlo2C0wxyz789', object: 'refund', amount: 1000, balance_transaction: 'txn_3PqXyz2eZvKYlo2C0qrs456', charge: 'ch_3PqXyz2eZvKYlo2C0mno012',
  created: 1_792_000_500, currency: 'eur', destination_details: { card: { reference_status: 'pending', reference_type: 'acquirer_reference_number', type: 'refund' }, type: 'card' },
  metadata: {}, payment_intent: 'pi_3PqXyz2eZvKYlo2C0abcd123', reason: 'requested_by_customer', receipt_number: null, source_transfer_reversal: null, status: 'succeeded', transfer_reversal: null,
  ...o,
});

/** A refund list page. @param {unknown[]} data @param {boolean} [hasMore] */
export const refundList = (data, hasMore = false) => ({ object: 'list', data, has_more: hasMore, url: '/v1/refunds' });

export const cardDeclined = { error: { code: 'card_declined', decline_code: 'insufficient_funds', doc_url: 'https://stripe.com/docs/error-codes/card-declined', message: 'Your card has insufficient funds.', param: '', type: 'card_error' } };
export const rateLimited = { error: { message: 'Too many requests hit the API too quickly.', type: 'invalid_request_error', code: 'rate_limit' } };

/** A webhook event body as delivered. @param {string} type @param {unknown} object @param {Record<string, unknown>} [o] */
export const event = (type, object, o = {}) => ({
  id: `evt_1Pq${Math.random().toString(36).slice(2, 12)}XyZ`, object: 'event', api_version: '2024-06-20', created: 1_792_000_100,
  data: { object }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type, ...o,
});
