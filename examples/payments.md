# Taking a payment

1. Your server creates the payment (amount in minor units):

```bash
pay -X POST $PAY/v1/payments -H 'Idempotency-Key: order-1042-pay' \
  -d '{"amount":2500,"currency":"eur","description":"Order 1042","customerEmail":"ada@example.com","metadata":{"order":"1042"}}'
```

`201`:

```json
{ "payment": { "id": "pay_mv8abcde0123456789abcdef", "status": "pending", "amount": 2500, "currency": "eur", "amountRefunded": 0,
  "description": "Order 1042", "customerEmail": "ada@example.com", "metadata": { "order": "1042" }, "lastError": null,
  "provider": { "name": "stripe", "id": "pi_3P…", "status": "requires_payment_method" }, "createdBy": "shop", "...": "..." },
  "clientSecret": "pi_3P…_secret_…" }
```

2. The browser confirms it with Stripe.js and the `clientSecret` (card data goes straight to Stripe, never through your servers):

```js
const stripe = Stripe('pk_live_…');
const { error } = await stripe.confirmPayment({ elements, clientSecret, confirmParams: { return_url: 'https://shop.example.com/thanks' } });
```

3. The outcome arrives by webhook ([webhooks.md](webhooks.md)): `succeeded`, or back to `pending` with `lastError` when the card fails. Read it with `GET /v1/payments/:id`, or subscribe to `payment.succeeded` in atc-webhook-out ([events.md](events.md)).

Pitfalls:
- Treat the redirect to `return_url` as a hint only; ship the order on `payment.succeeded`.
- `clientSecret` is only in the create response. Do not store it; create a new payment if you lose it.
- `currency` must be one of `CURRENCIES`; `amount` between `MIN_AMOUNT` and `MAX_AMOUNT`. Metadata keys starting with `atc_` are reserved.
