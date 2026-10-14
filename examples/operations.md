# Operations

```bash
curl -s $PAY/health   # {"status":"ok"}
curl -s $PAY/ready    # {"status":"ok","provider":"stripe","webhooks":"enabled","webhookOut":"enabled"}
pay $PAY/v1/stats
```

```json
{ "provider": "stripe", "webhooks": "enabled", "webhookOut": "enabled", "byStatus": { "succeeded": 40, "pending": 3, "partially_refunded": 1 },
  "volume24h": [{ "currency": "eur", "payments": 12, "amount": 31800 }], "balance": [{ "currency": "eur", "charged": 98000, "refunded": 1500, "net": 96500, "entries": 44 }],
  "outbox": { "pending": 0, "dead": 0 }, "currencies": ["usd", "eur", "gbp", "try"] }
```

Metrics (`read` key): `payments_total{status}`, `payments_ledger_net{currency}`, `payments_outbox_pending{state}`, `payments_provider_enabled`. Alert on `payments_outbox_pending{state="dead"} > 0`.

Retention runs at start and hourly: idempotency keys after `IDEMPOTENCY_TTL_HOURS`, provider events and delivered outbox rows after `EVENT_RETENTION_DAYS`. Payments, refunds and the ledger are kept.

PM2: `pm2 start ecosystem.config.cjs` (one instance). Docker: `docker build -t atc-payments . && docker run -p 3019:3019 -v atc-payments-data:/data --env-file .env atc-payments`.
