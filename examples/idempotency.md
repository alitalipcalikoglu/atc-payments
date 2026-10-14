# Idempotency keys

Creates and refunds need `Idempotency-Key` (8-255 characters of letters, digits, `._:-`). Use one key per business operation, for example `order-1042-pay`.

| Situation | Answer |
|---|---|
| First request | Runs; the answer is stored for `IDEMPOTENCY_TTL_HOURS` (24) |
| Same key, same body | The stored answer, header `Idempotent-Replayed: true` |
| Same key, another body | `409 IDEMPOTENCY_MISMATCH` |
| Same key while the first is still running | `409 IDEMPOTENCY_IN_PROGRESS` |
| No key | `400 IDEMPOTENCY_KEY_REQUIRED` |

Keys are per API key: two callers may use the same key independently.

What is stored: successes and deterministic refusals (validation, a declined card `402`, Stripe refusing `422`). Not stored: transient failures (`502 PROVIDER_ERROR`); the key is released so you can retry with the same key.

Why retries never charge twice: Stripe receives `Idempotency-Key: atc-payments:<api key id>:<your key>`. If the first attempt reached Stripe but its answer was lost, the retry gets the same PaymentIntent back and the same payment id.

```bash
for i in 1 2 3; do pay -X POST $PAY/v1/payments -H 'Idempotency-Key: order-1042-pay' -d '{"amount":2500,"currency":"eur"}' | jq -r .payment.id; done
# pay_mv8abcde0123456789abcdef (three times)
```
