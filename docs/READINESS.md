# `atc-payments` readiness contract

## Purpose
Payment intents and refunds through Stripe's REST API with fetch (no SDK): client idempotency keys,
signed webhooks, a payment state machine, an append-only ledger, events to atc-audit and
atc-webhook-out.

## Dependencies
Stripe (`STRIPE_API_URL`; empty `STRIPE_SECRET_KEY` disables the provider, `/ready` reports it and
stays ready). `atc-webhook-out` (optional, events through a transactional outbox), `atc-audit`
(optional).

## Persistence
SQLite at `DB_PATH` (`./data/payments.db`; Docker `/data/payments.db`), WAL. Tables: `payments`,
`refunds`, `ledger` (append-only: update and delete triggers abort; `UNIQUE(kind, ref)`),
`audit_outbox` (events for the audit service, written before delivery; sent rows purged after `EVENT_RETENTION_DAYS`), `idempotency` (kept `IDEMPOTENCY_TTL_HOURS`), `provider_events` (each webhook event id once; kept
`EVENT_RETENTION_DAYS`), `outbox`. Migrations by `user_version`, snapshot before upgrading.

## Health / readiness
`/health` no I/O. `/ready` database ping cached 10 s; the body names provider, webhook and
event-forwarding state.

## Graceful shutdown
`SIGTERM`: timers stop, HTTP drains (a Stripe call ends within `STRIPE_TIMEOUT_MS`), the outbox
delivery in progress finishes, audit flush, database closes. Force exit 30 s; PM2 `kill_timeout`
35 s. Idempotency keys left in progress by a crash are released on the next start; the derived
Stripe key makes the client's retry safe.

## Resource limits
`BODY_LIMIT` 256 KiB (webhook events), `RATE_LIMIT_MAX` 600/min per key, amounts `MIN_AMOUNT` -
`MAX_AMOUNT` minor units, `CURRENCIES`, metadata 20 keys of 40/500 characters.

## Timeouts
Stripe `STRIPE_TIMEOUT_MS` 20 s per call; atc-webhook-out 10 s per event.

## Retry policy
No retries towards Stripe inside a request: a transient failure (network, 429, 5xx) answers `502
PROVIDER_ERROR` and releases the idempotency key; the client retries with the same key and Stripe
returns the same object. Outbox events retry with exponential backoff (1 s doubling, at most
10 min) up to `OUTBOX_MAX_ATTEMPTS`.

## Idempotency
Creates and refunds require `Idempotency-Key`; deterministic outcomes are stored and replayed,
another body with the same key answers 409. Webhook events by id; ledger entries by provider id;
outbox events carry `atc-payments:<seq>` to atc-webhook-out.

## Backup / restore
The SQLite file. After a restore, run `POST /v1/payments/:id/sync` for payments that changed since
the backup (or let Stripe's webhook retries arrive); the ledger stays consistent because entries
are unique per provider object.

## Metrics
`payments_total{status}`, `payments_ledger_net{currency}`, `payments_outbox_pending{state}`,
`payments_provider_enabled`, `payments_process_uptime_seconds`.

## Logging / tracing
Fastify request logs with request id and trace context; `authorization`, card data and client
secrets are never logged (card data never reaches this service).

## Security model
Bearer keys with `read`/`write`. The webhook endpoint takes no key: the Stripe signature
(HMAC-SHA256, constant-time compare, timestamp tolerance) authenticates it; failures are audited as
`denied`. Client secrets are returned only by the create call. Out-of-order or forged state changes
cannot move a payment backwards (state machine).

## Scaling model
**B — single-node stateful.** One process per SQLite file; webhook handling is synchronous after
verification so duplicate deliveries cannot interleave.

## Known failure modes
- Stripe down: creates and refunds answer 502; payments already created keep their state; webhooks
  arrive later (Stripe retries for days).
- atc-webhook-out down: events wait in the outbox and are delivered when it is back.
- A payment changed in the Stripe dashboard: refunds are recorded from webhooks; other changes
  need a sync.
