# Disputes

A customer's bank can dispute a card payment (a chargeback). Stripe takes the money back at once and gives you until a deadline to respond with evidence. This service keeps every dispute of its payments and lets you answer it through the API.

## How disputes arrive

Enable `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed` on the Stripe webhook endpoint. Each delivery updates the dispute row, queues a `payment.disputed` event and writes an `atc-payments.payment.disputed` audit event. The payment's own state does not change.

```bash
curl "$PAY/v1/disputes?open=true" -H "Authorization: Bearer $READ_KEY"
```

```json
{ "items": [ {
  "id": "dp_1Q2w3E4r5T6y", "paymentId": "pay_mgx1k2abc0123456789abcdef", "amount": 4200, "currency": "eur",
  "reason": "fraudulent", "status": "needs_response", "evidenceDueBy": "2026-10-23T23:59:59.000Z",
  "evidence": {}, "submittedAt": null, "submittedBy": null, "createdAt": "2026-10-16T09:00:00.000Z", "updatedAt": "2026-10-16T09:00:00.000Z" } ],
  "nextCursor": null }
```

`open=true` lists `needs_response`, `warning_needs_response`, `under_review` and `warning_under_review`. `GET /v1/payments/:id` shows the payment's disputes too, and `/v1/stats` counts disputes by status.

## Prepare and submit evidence

Save text evidence as you collect it; fields are merged with what was sent before:

```bash
curl -X POST "$PAY/v1/disputes/dp_1Q2w3E4r5T6y/evidence" -H "Authorization: Bearer $WRITE_KEY" -H 'content-type: application/json' -d '{
  "evidence": {
    "customer_name": "Ayşe Kaya",
    "customer_email_address": "ayse@example.com",
    "product_description": "Annual Pro plan, delivered as account access",
    "access_activity_log": "Signed in 14 times from the purchase IP between 2026-09-02 and 2026-10-10"
  }
}'
```

When everything is in, submit. This is final: the evidence goes to the card issuer and Stripe moves the dispute to `under_review`.

```bash
curl -X POST "$PAY/v1/disputes/dp_1Q2w3E4r5T6y/evidence" -H "Authorization: Bearer $WRITE_KEY" -H 'content-type: application/json' \
  -d '{ "evidence": { "uncategorized_text": "Customer confirmed the purchase in support ticket #8812." }, "submit": true }'
```

Accepted fields: `access_activity_log`, `billing_address`, `cancellation_policy_disclosure`, `cancellation_rebuttal`, `customer_email_address`, `customer_name`, `customer_purchase_ip`, `duplicate_charge_explanation`, `duplicate_charge_id`, `product_description`, `refund_policy_disclosure`, `refund_refusal_explanation`, `service_date`, `shipping_address`, `shipping_carrier`, `shipping_date`, `shipping_tracking_number`, `uncategorized_text` (each up to 20 000 characters). Files (receipts, shipping labels) are uploaded in the Stripe dashboard.

## Accept a dispute

When the claim is right (or the amount is not worth fighting), concede it:

```bash
curl -X POST "$PAY/v1/disputes/dp_1Q2w3E4r5T6y/accept" -H "Authorization: Bearer $WRITE_KEY"
```

Stripe closes it as `lost`; the money stays with the customer. This cannot be undone.

## Outcome

The issuer decides; Stripe sends `charge.dispute.closed` with `won` or `lost`, and the row follows. Evidence and acceptance are refused with `409 INVALID_STATE` once a dispute is no longer in `needs_response` or `warning_needs_response`.

## Pitfalls

- Missing the deadline loses the dispute. Watch `GET /v1/disputes?open=true` or subscribe to `payment.disputed`.
- A dispute of a payment not created through this service is recorded as an `unknown` provider event and not kept.
- `warning_*` statuses are inquiries (early fraud warnings): answering them can prevent a chargeback.
