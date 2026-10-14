# Payment states

```
pending ──► processing ──► succeeded ──► partially_refunded ──► refunded
  │  ▲          │              └──────────────────────────────────▲
  │  └──────────┘ (payment failed: back to pending, lastError set)
  └──► canceled ◄── processing
```

| Stripe status | Status here |
|---|---|
| `requires_payment_method`, `requires_confirmation`, `requires_action` | `pending` |
| `processing` | `processing` |
| `succeeded` | `succeeded` (then refund states) |
| `canceled` | `canceled` |

Moves come from webhooks, `POST …/sync`, `POST …/cancel` and refunds. A move the table does not allow is refused and recorded as `ignored` (for example a late `processing` event after `succeeded`), so out-of-order deliveries cannot move a payment backwards. `canceled` and `refunded` are final.
