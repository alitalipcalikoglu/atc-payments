# API keys and roles

```bash
PAYMENTS_API_KEYS=shop:<64 hex>:write,atc-console:<64 hex>:write,finance:<64 hex>:read
```

| Role | Can |
|---|---|
| `read` | Payments, refunds, ledger, provider events, stats, metrics |
| `write` | Also create, cancel, sync and refund |

The role is required. Idempotency keys are per API key. The webhook endpoint takes no key.
