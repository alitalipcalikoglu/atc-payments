# atc-payments

Payments through Stripe's REST API with plain `fetch` (no SDK). Create PaymentIntents and refunds with client idempotency keys, receive Stripe's signed webhooks (HMAC checked in constant time, each event once), move payments through an explicit state machine, record every charge and refund in an append-only ledger, and publish `payment.*` / `refund.*` events to atc-webhook-out through a transactional outbox. Card data never reaches this service; the browser confirms with Stripe.js. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `@atc-web/atc-service-core`. Storage is SQLite via `node:sqlite` (Node 22.13+).

## Run

```bash
cp .env.example .env        # set PAYMENTS_API_KEYS; STRIPE_* when you have them
npm ci
npm run dev
```

Without `STRIPE_SECRET_KEY` the service runs with the provider disabled (`/ready` says so). Production: `npm ci --omit=dev && pm2 start ecosystem.config.cjs`, or `docker build -t atc-payments . && docker run -p 3019:3019 -v atc-payments-data:/data --env-file .env atc-payments`.

Tests and type check: `npm test`, `npm run typecheck`. Tests use a local fake Stripe (`test/fake-stripe.js`), never real keys.

## Model

- **Payment**: one Stripe PaymentIntent; amount in minor units, currency, description, customer e-mail, metadata. Status `pending`, `processing`, `succeeded`, `canceled`, `partially_refunded`, `refunded` ([examples/states.md](examples/states.md)).
- **Refund**: part or all of a succeeded payment; `pending`, `succeeded`, `failed`, `canceled`.
- **Ledger**: `charge` (+) and `refund` (−) entries, one per Stripe object, never changed.
- **Idempotency key**: required on creates and refunds; same key + same body replays, another body is refused.
- **Outbox**: events for atc-webhook-out, written with the change, delivered with retries.

## API

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Probes (provider state in `/ready`), identity |
| POST | `/v1/webhooks/stripe` | Stripe signature | Webhook endpoint |
| GET | `/metrics` | read | Prometheus text |
| POST | `/v1/payments` | write | Create (`Idempotency-Key`); returns `clientSecret` |
| GET | `/v1/payments`, `/v1/payments/:id` | read | List by status, e-mail, metadata, currency, amount range, creation window; detail with refunds, ledger, refundable amount |
| POST | `/v1/payments/:id/cancel` | write | Cancel pending or processing |
| POST | `/v1/payments/:id/sync` | write | Apply Stripe's current state |
| POST | `/v1/payments/:id/anonymize` | write | Remove e-mail, description and metadata here and at Stripe |
| POST | `/v1/reconciliation` | write | Compare a creation window with Stripe; `repair` syncs the differences |
| POST | `/v1/payments/:id/refunds` | write | Refund (`Idempotency-Key`) |
| GET | `/v1/ledger` | read | Entries and balance per currency |
| GET | `/v1/provider-events` | read | Webhook events and what they did (`limit`, `cursor`) |
| GET | `/v1/disputes?status=&open=&payment=` | read | Disputes mirrored from `charge.dispute.*` webhooks, newest first |
| GET | `/v1/disputes/:id` | read | One dispute with its evidence |
| POST | `/v1/disputes/:id/evidence` | write | `{ evidence: { field: text }, submit? }`: save text evidence on Stripe; `submit: true` sends it to the issuer |
| POST | `/v1/disputes/:id/accept` | write | Concede: Stripe closes the dispute as lost |
| GET | `/v1/stats` | read | By status, 24 h volume, balances, outbox, disputes by status |

Errors: `{ "error": { "code", "message" } }` — `VALIDATION_FAILED`, `INVALID_ARGUMENT`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_SIGNATURE` (400), `PROVIDER_DECLINED` (402), `FORBIDDEN` (403), `PAYMENT_NOT_FOUND` (404), `INVALID_STATE`, `AMOUNT_EXCEEDS_REMAINING`, `IDEMPOTENCY_MISMATCH`, `IDEMPOTENCY_IN_PROGRESS` (409), `PROVIDER_REJECTED` (422), `RATE_LIMITED` (429), `PROVIDER_ERROR` (502), `PROVIDER_DISABLED`, `WEBHOOK_DISABLED` (503). Full contract: [openapi.yaml](openapi.yaml).

## Conventions

- Lists answer `{ items, nextCursor }`; pass `nextCursor` back as `cursor`. Payments, ledger, disputes and provider events page newest first. Payments have `pay_<time><random>` ids (the platform's one id format).
- Payment creation and refunds keep this service's own `Idempotency-Key` handling: the key is required, kept for `IDEMPOTENCY_TTL_HOURS` (default 24) and scoped to the API key and the caller behind it (the console's `X-Actor`, an end-user `X-Access-Token`); a repeat replays the first answer (the client secret is fetched from Stripe again rather than stored), while another body or another caller is `409 IDEMPOTENCY_MISMATCH`.

## Examples

Taking a payment end to end, idempotency, webhooks and the gateway route, refunds, the ledger, events, testing without Stripe: [examples/README.md](examples/README.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3019`, `0.0.0.0` | Listen address |
| `PAYMENTS_API_KEYS` | required | `id:secret:role`; role `read` or `write` |
| `STRIPE_SECRET_KEY` | empty | `sk_…` or `rk_…`; empty = provider disabled |
| `STRIPE_WEBHOOK_SECRET` | empty | `whsec_…`; empty = webhook endpoint disabled |
| `STRIPE_API_URL`, `STRIPE_TIMEOUT_MS`, `WEBHOOK_TOLERANCE_SEC` | `https://api.stripe.com`, `20000`, `300` | |
| `CURRENCIES`, `MIN_AMOUNT`, `MAX_AMOUNT` | `usd,eur,gbp,try`, `50`, `99999999` | |
| `IDEMPOTENCY_TTL_HOURS`, `EVENT_RETENTION_DAYS` | `24`, `30` | |
| `WEBHOOK_OUT_URL`, `WEBHOOK_OUT_API_KEY`, `WEBHOOK_OUT_TIMEOUT_MS` | empty, empty, `10000` | Events (both or neither) |
| `OUTBOX_MS`, `OUTBOX_MAX_ATTEMPTS` | `2000`, `20` | Event delivery |
| `DB_PATH`, `DB_BACKUP_DIR`, `BODY_LIMIT`, `RATE_LIMIT_MAX` | `./data/payments.db`, –, `262144`, `600` | |
| `TRUST_PROXY`, `TLS_CERT_PATH`, `TLS_KEY_PATH`, `LOG_LEVEL` | | As in every service |
| `AUDIT_URL`, `AUDIT_API_KEY` | empty | Forward audit events (both or neither) |

## Security notes

- Card data goes from the browser to Stripe; this service sees amounts and ids only. Client secrets are returned by the create call and never stored, not even in the idempotency record: a replayed create fetches the secret from Stripe again.
- Webhooks are authenticated by the Stripe signature only: HMAC-SHA256 over the raw body, constant-time comparison, timestamp tolerance, each event id once. Rejections are audited.
- The state machine refuses backward moves, so forged-looking or out-of-order events cannot un-pay or un-refund a payment; the ledger is append-only at the database level.
- Prefer a Stripe restricted key with only PaymentIntents and Refunds write access.

## Code layout

```
src/
  application.js              composition root, outbox delivery, retention, lifecycle
  config.js, db.js, types.js
  domain/payment-service.js   create, cancel, sync, refund, webhooks, idempotency, ledger, outbox
  domain/payment-state.js     the state machine and Stripe status mapping
  store/payment-store.js      SQLite statements
  net/stripe-client.js        Stripe REST over fetch (form encoding, idempotency keys, errors)
  net/stripe-signature.js     webhook signature verification
  net/webhook-publisher.js    events to atc-webhook-out
  http/                       PaymentsApi routes, ApiKeyAuth, Schemas, Views
test/                         node:test suites and the fake Stripe
```

## Out of scope by design

- Payment providers other than Stripe; manual capture, subscriptions, invoices, payouts and fees.
- File evidence for disputes (receipts, shipping documents): upload them in the Stripe dashboard; the API sends text evidence only. Dispute handling against the live Stripe API is covered by the fake provider and the Stripe API reference, not by a live test.
- Customer receipts and payment-failure e-mails: Stripe sends the receipt to `customerEmail` itself; `payment.failed` events let your own systems notify the customer.
- Reversal of a refund that Stripe reports as failed after it succeeded.
- Multi-currency conversion; amounts are kept in the currency they were charged in.

## Operational events

Besides the outbox (`payment.*`, `refund.*`), the service publishes `ops.payments.outbox_dead` when an outbox event used up its attempts (best effort, through an in-memory publisher; `payments_outbox_pending{state="dead"}` is the durable signal). See [examples/events.md](examples/events.md).

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set: `atc-payments.payment.create`, `.payment.cancel`, `.payment.sync`, `.refund.create` from the API (`success`, or `denied` on 403); `atc-payments.payment.<status>` and `atc-payments.refund.<status>` with the actor `provider:stripe` when a webhook changes something; `atc-payments.webhook.rejected` (`denied`) for bad signatures. Unlike most services, forwarding is durable: each event is written to the `audit_outbox` table first and delivered by the audit client with retries, so a crash or an audit-service outage does not lose money events (`audit_forward_pending` shows the backlog). Details: [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process per SQLite file; webhook handling is synchronous after verification, so duplicate deliveries cannot interleave. See [docs/READINESS.md](docs/READINESS.md).

## Observability

Request logs with request id and trace context; `/metrics`; `/v1/stats`; `/v1/provider-events`; `/ready`.

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

The SQLite file at `DB_PATH` (atc-backup can copy it). After a restore, sync payments that changed since the backup; ledger entries are unique per Stripe object, so replays cannot double-count.

## License

MIT, see [LICENSE](LICENSE).
