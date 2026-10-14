# Events to atc-webhook-out

With `WEBHOOK_OUT_URL` and `WEBHOOK_OUT_API_KEY` (a `publish` key), every change is published as an atc-webhook-out event:

| Type | When |
|---|---|
| `payment.created` | Created |
| `payment.failed` | A payment attempt failed (back to pending) |
| `payment.processing`, `payment.succeeded`, `payment.canceled` | Status moved |
| `payment.disputed` | Stripe sent a `charge.dispute.*` event for the payment; data has `id` and `dispute` (`id`, `status`, `reason`, `amount`, `currency`, `event`). The payment's state does not change |
| `payment.refunded` | Fully refunded |
| `refund.succeeded`, `refund.failed`, `refund.canceled` | A refund settled |

```json
{ "type": "payment.succeeded", "data": { "id": "pay_…", "status": "succeeded", "amount": 2500, "currency": "eur", "amountRefunded": 0, "metadata": { "order": "1042" }, "providerId": "pi_…" }, "idempotencyKey": "atc-payments:17" }
```

Events are written to an outbox in the same transaction as the change and delivered every `OUTBOX_MS` (2 s), in order, with exponential backoff on failure (1 s doubling, at most 10 min) up to `OUTBOX_MAX_ATTEMPTS`. The idempotency key makes a repeated delivery a no-op in atc-webhook-out. `/v1/stats` shows `outbox.pending` and `outbox.dead`.

Without atc-webhook-out configured, nothing is queued.

## Operational event

| Event | When | Data |
|---|---|---|
| `ops.payments.outbox_dead` | An outbox event failed its last attempt (`OUTBOX_MAX_ATTEMPTS`) and will not be retried | `source`, `seq`, `type`, `attempts`, `error` |

The outbox itself is durable; this alert is not: it goes through an in-memory publisher that may itself fail when atc-webhook-out is the thing that is down. The durable signal is `payments_outbox_pending{state="dead"}` on `/metrics` and `outbox.dead` in `/v1/stats`; alert on those too. A dead event stays in the table (until retention) and is not retried automatically.
