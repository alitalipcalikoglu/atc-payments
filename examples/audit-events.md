# Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set:

| Action | Actor | Target | Meta |
|---|---|---|---|
| `atc-payments.payment.create` | API key | payment | `amount`, `currency` |
| `atc-payments.payment.cancel` | API key | payment | – |
| `atc-payments.payment.sync` | API key | payment | `status` |
| `atc-payments.refund.create` | API key | refund | `payment`, `amount`, `status` |
| `atc-payments.payment.<status>` (`processing`, `succeeded`, `canceled`, `failed`) | `provider` `stripe` | payment | `event`, `eventId` |
| `atc-payments.refund.<status>` | `provider` `stripe` | refund | `payment`, `event`, `eventId` |
| `atc-payments.webhook.rejected` (outcome `denied`) | `provider` `stripe` | – | `reason`; with the caller's IP |

API routes record `success`, or `denied` on 403. Reads are not audited.
