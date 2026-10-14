import { randomUUID } from 'node:crypto';

/** @typedef {{ enabled: boolean, record: (e: import('@atc-web/atc-service-core/audit').AuditEvent) => boolean }} AuditSink What the route hook and the service need. */

/**
 * Audit forwarding that survives a crash: every event is written to the `audit_outbox` table
 * before anything else happens, and the core AuditClient (outbox mode) drains that table to the
 * audit service with the usual retries. Payments is where a lost audit event hurts most, so it
 * does not use the in-memory buffer. Exposes what the route hook and the service use
 * (`enabled`, `record`) plus the client's lifecycle.
 */
export class DurableAudit {
  /**
   * @param {object} o
   * @param {typeof import('@atc-web/atc-service-core/audit').AuditClient} o.AuditClient
   * @param {{ url: string, apiKey: string }|null} o.target
   * @param {import('../store/payment-store.js').PaymentStore} o.store
   * @param {number} o.retentionDays
   * @param {() => number} [o.now]
   */
  constructor({ AuditClient, target, store, retentionDays, now = Date.now }) {
    this.store = store;
    this.now = now;
    this.client = new AuditClient({
      target,
      outbox: {
        pending: (limit) => store.auditPending(limit),
        markSent: (ids) => store.auditMarkSent(ids, now()),
        purge: () => store.auditPurge(now() - retentionDays * 86_400_000),
      },
    });
  }

  get enabled() { return this.client.enabled; }
  get stats() { return this.client.stats; }
  /** Rows written but not yet accepted by the audit service. */
  get backlog() { return this.enabled ? this.store.auditBacklog() : 0; }
  /** @param {any} l */
  set logger(l) { this.client.logger = l; }

  /** @param {import('@atc-web/atc-service-core/audit').AuditEvent} e */
  record(e) {
    if (!this.client.enabled) return false;
    this.store.auditInsert(randomUUID(), this.now(), JSON.stringify(e));
    return true;
  }

  start() { this.client.start(); }
  flush() { return this.client.flush(); }
  close() { return this.client.close(); }
}
