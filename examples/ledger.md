# Ledger

Every money movement is one entry: `charge` (positive) when a payment succeeds, `refund` (negative) when a refund succeeds. Entries are unique per Stripe object and cannot be changed or deleted (database triggers refuse it).

```bash
pay "$PAY/v1/ledger?limit=50"
```

```json
{ "items": [
  { "seq": 2, "paymentId": "pay_…", "kind": "refund", "amount": -500, "currency": "eur", "ref": "re_…", "at": "2026-10-14T10:20:00.000Z" },
  { "seq": 1, "paymentId": "pay_…", "kind": "charge", "amount": 2500, "currency": "eur", "ref": "pi_…", "at": "2026-10-14T10:05:00.000Z" } ],
  "balance": [{ "currency": "eur", "charged": 2500, "refunded": 500, "net": 2000, "entries": 2 }], "nextCursor": null }
```

The ledger records what Stripe reported; Stripe fees and payouts are not part of it.
