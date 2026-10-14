# Testing without Stripe

The test suite runs against `test/fake-stripe.js`, a local server that answers like the parts of Stripe this service uses (PaymentIntents, refunds, idempotency keys, errors) and signs webhook events. No real keys, no network.

Run it by hand for a manual check:

```bash
node test/fake-stripe.js 12111
# {"url":"http://127.0.0.1:12111","STRIPE_SECRET_KEY":"sk_test_fff…","STRIPE_WEBHOOK_SECRET":"whsec_www…"}
STRIPE_API_URL=http://127.0.0.1:12111 STRIPE_SECRET_KEY=sk_test_fff… STRIPE_WEBHOOK_SECRET=whsec_www… npm run dev
```

Amount `402` is declined; a refund of `1234` stays pending.

With Stripe test mode instead: put `sk_test_…` in `STRIPE_SECRET_KEY` and use `stripe listen` for webhooks.

With `STRIPE_SECRET_KEY` empty the provider is off: `/ready` answers `"provider":"disabled"` (still ready), creates answer `503 PROVIDER_DISABLED`, everything already stored stays readable.
