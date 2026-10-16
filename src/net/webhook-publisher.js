/**
 * Delivers outbox events to atc-webhook-out (`POST /v1/events`). Each event carries a stable
 * idempotency key, so a retried delivery never fans out twice.
 */
export class WebhookPublisher {
  /**
   * @param {{ url: string, apiKey: string, timeoutMs: number }} target
   * @param {typeof fetch} [fetchImpl]
   */
  constructor(target, fetchImpl = fetch) {
    this.target = target;
    this.fetch = fetchImpl;
  }

  /** @param {{ seq: number, type: string, data: string }} e */
  async publish(e) {
    const res = await this.fetch(`${this.target.url}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.target.apiKey}`, 'content-type': 'application/json', 'idempotency-key': `atc-payments:${e.seq}` },
      body: JSON.stringify({ type: e.type, data: JSON.parse(e.data) }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.target.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `atc-webhook-out responded ${res.status}`;
      try { const j = JSON.parse(text); if (j?.error?.message) message = `atc-webhook-out: ${j.error.message}`; } catch { /* not JSON */ }
      throw new Error(message);
    }
  }
}
