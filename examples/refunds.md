# Refunds

Only `succeeded` or `partially_refunded` payments.

```bash
pay -X POST $PAY/v1/payments/pay_mv8abcde0123456789abcdef/refunds -H 'Idempotency-Key: order-1042-refund-1' -d '{"amount":500,"reason":"requested_by_customer"}'
```

```json
{ "refund": { "id": "rf_…", "paymentId": "pay_…", "status": "succeeded", "amount": 500, "reason": "requested_by_customer", "providerId": "re_…", "createdBy": "shop", "...": "..." },
  "payment": { "status": "partially_refunded", "amountRefunded": 500, "...": "..." } }
```

Without `amount`, everything still refundable is refunded. `GET /v1/payments/:id` shows `refundable`: the amount minus succeeded refunds minus pending ones. Asking for more answers `409 AMOUNT_EXCEEDS_REMAINING`.

A refund Stripe reports as `pending` holds its amount until a `refund.updated` webhook settles it as `succeeded` (ledger entry, payment refund state) or `failed` (amount free again, `refund.failed` event).

Refunds made in the Stripe dashboard arrive as `refund.*` webhooks and are recorded with `createdBy: "stripe"`.

Pitfalls:
- A succeeded refund is final here; a later failure reported by Stripe is recorded as an ignored event, not reversed in the ledger.
