# Cancel and sync

Cancel a payment the customer will not pay (`pending` or `processing`):

```bash
pay -X POST $PAY/v1/payments/pay_mv8abcde0123456789abcdef/cancel
```

Returns the payment detail with `status: "canceled"`; cancelling again returns it unchanged. Succeeded payments answer `409 INVALID_STATE` (refund them instead).

Sync when webhooks were missed (endpoint down, secret rotated):

```bash
pay -X POST $PAY/v1/payments/pay_mv8abcde0123456789abcdef/sync
# { "payment": {…}, "refunds": […], "ledger": […], "refundable": 0, "changed": true }
```

It reads the PaymentIntent and its refunds from Stripe and applies them through the same state machine and ledger rules as webhooks.
