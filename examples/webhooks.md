# Stripe webhooks

Point a Stripe webhook endpoint at the gateway route and select at least `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`, `payment_intent.canceled`, `refund.created`, `refund.updated`, `refund.failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

Gateway (`routes.json`), so Stripe can reach it without an API key:

```json
{ "id": "payments-webhooks", "pathPrefix": "/api/payments/v1/webhooks/", "stripPrefix": "/api/payments", "upstreams": ["http://127.0.0.1:3019"], "methods": ["POST"], "bodyLimit": 262144, "rateLimit": 600 }
```

Stripe URL: `https://api.example.com/api/payments/v1/webhooks/stripe`.

Each delivery is checked: `Stripe-Signature: t=…,v1=…` must be an HMAC-SHA256 of `<t>.<raw body>` with the signing secret (constant-time compare; several `v1` values are accepted during secret rotation) and `t` within `WEBHOOK_TOLERANCE_SEC` (300 s). Failures answer `400 INVALID_SIGNATURE` and are audited as `atc-payments.webhook.rejected` (denied).

```json
{ "received": true, "id": "evt_1P…", "type": "payment_intent.succeeded", "outcome": "applied" }
```

Outcomes: `applied`, `duplicate` (this event id was seen before), `ignored` (unhandled type, or a transition the state machine refuses), `unknown` (a PaymentIntent not created through this service). See them with `GET /v1/provider-events`.

Pitfalls:
- Proxies must not change the body: the signature is over the exact bytes.
- Locally, `stripe listen --forward-to localhost:3019/v1/webhooks/stripe` prints a signing secret to use.
