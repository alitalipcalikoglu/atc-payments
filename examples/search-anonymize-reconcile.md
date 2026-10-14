# Finding and cleaning up payments

## Find one

```bash
pay "$PAYMENTS/v1/payments?email=ada@example.com"
pay "$PAYMENTS/v1/payments?metaKey=order&metaValue=A-1042"
pay "$PAYMENTS/v1/payments?currency=eur&minAmount=10000&from=2026-10-01T00:00:00Z&to=2026-11-01T00:00:00Z&status=succeeded"
```

All filters combine. `email` matches exactly, ignoring case. `metaKey` and `metaValue` match a metadata value you stored at creation (an order number). `from` is inclusive, `to` exclusive; amounts are minor units.

## Remove the person from a payment

```bash
pay -X POST $PAYMENTS/v1/payments/$ID/anonymize
```

Customer e-mail, description and metadata are cleared here and at Stripe (receipt e-mail, description, metadata keys). Amount, currency, status, refunds and the ledger stay: the books must still add up. Stripe is called first; if it fails (`502`) nothing changes and you can retry. Irreversible. Stripe may keep the card holder's data on its side under its own retention rules, and copies already delivered to webhook-out subscribers or to the audit log are not rewritten.

## Reconcile with Stripe

```bash
pay -X POST $PAYMENTS/v1/reconciliation -d '{ "from": "2026-10-01T00:00:00Z", "to": "2026-10-08T00:00:00Z" }'
```

```json
{ "checked": 118, "truncated": false, "repaired": 0,
  "mismatches": [ { "id": "pay_...", "local": { "status": "pending", "amountRefunded": 0 }, "provider": { "status": "succeeded", "amountRefunded": 0 } } ] }
```

Every payment created in the window (at most 200, oldest first; `truncated` says there are more) is read from Stripe and compared on status and refunded amount. A mismatch means a webhook was lost. `"repair": true` syncs each differing payment (same as `POST /v1/payments/:id/sync`). Run it after an outage of this service or of the webhook route.

## Disputes

A `charge.dispute.created` (or `.updated`, `.closed`) webhook is recorded and announced as `payment.disputed` through the outbox and audited as `atc-payments.payment.disputed`. The payment's state does not change; respond to the dispute in the Stripe dashboard before its deadline. Subscribe to `payment.disputed` (and have atc-status turn it into an alert if you want people to be told).

Pitfalls:
- Enable the dispute events on the Stripe webhook endpoint, otherwise nothing arrives.
- Reconciliation reads Stripe once per payment (two calls); a large window with `repair` takes a while.
