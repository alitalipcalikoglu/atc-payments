# Events to atc-webhook-out

With `WEBHOOK_OUT_URL` and `WEBHOOK_OUT_API_KEY` (a `publish` key), every change is published as an atc-webhook-out event:

| Type | When |
|---|---|
| `payment.created` | Created |
| `payment.failed` | A payment attempt failed (back to pending) |
| `payment.processing`, `payment.succeeded`, `payment.canceled` | Status moved |
| `payment.refunded` | Fully refunded |
| `refund.succeeded`, `refund.failed`, `refund.canceled` | A refund settled |

```json
{ "type": "payment.succeeded", "data": { "id": "pay_…", "status": "succeeded", "amount": 2500, "currency": "eur", "amountRefunded": 0, "metadata": { "order": "1042" }, "providerId": "pi_…" }, "idempotencyKey": "atc-payments:17" }
```

Events are written to an outbox in the same transaction as the change and delivered every `OUTBOX_MS` (2 s), in order, with exponential backoff on failure (1 s doubling, at most 10 min) up to `OUTBOX_MAX_ATTEMPTS`. The idempotency key makes a repeated delivery a no-op in atc-webhook-out. `/v1/stats` shows `outbox.pending` and `outbox.dead`.

Without atc-webhook-out configured, nothing is queued.
