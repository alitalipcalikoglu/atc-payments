# payments examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` (except the webhook) need `Authorization: Bearer <secret>` from `PAYMENTS_API_KEYS`. Base URL below is `http://localhost:3019`.

| Example | Shows |
|---|---|
| [Taking a payment](payments.md) | Create on the server, confirm in the browser, learn the outcome |
| [Idempotency keys](idempotency.md) | Safe retries, replays, mismatches, keys in progress |
| [Stripe webhooks](webhooks.md) | Endpoint setup, signatures, duplicates, the gateway route |
| [Payment states](states.md) | The state machine and what moves a payment |
| [Refunds](refunds.md) | Full and partial refunds, pending refunds, refunds made in the dashboard |
| [Cancel and sync](cancel-and-sync.md) | Cancelling unpaid payments, catching up after missed webhooks |
| [Finding and cleaning up payments](search-anonymize-reconcile.md) | Filters, anonymizing a customer, reconciliation against Stripe, disputes |
| [Disputes](disputes.md) | Chargebacks from webhooks, deadlines, sending evidence, accepting a dispute |
| [Ledger](ledger.md) | Charges and refunds as entries, balances per currency |
| [Events to atc-webhook-out](events.md) | payment.* and refund.* events, the outbox, retries |
| [Testing without Stripe](testing.md) | The local fake provider, test keys, the provider switched off |
| [API keys and roles](keys-and-roles.md) | read and write |
| [Operations](operations.md) | Health, readiness, metrics, stats, retention, PM2, Docker |
| [Audit events](audit-events.md) | Which actions are forwarded to the audit service |

```bash
export PAY=http://localhost:3019
export KEY=<a write secret>
alias pay='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
