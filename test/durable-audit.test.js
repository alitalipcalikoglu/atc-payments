import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { DurableAudit } from '../src/audit/durable-audit.js';
import { Database } from '../src/db.js';
import { PaymentStore } from '../src/store/payment-store.js';

const target = { url: 'http://audit.test', apiKey: 'a'.repeat(40) };
const silent = { warn() {}, error() {} };

test('durable audit: events are rows first; a restart still delivers them; sent rows are purged', async () => {
  const db = new Database(':memory:');
  const store = new PaymentStore(db);
  const mk = (/** @type {typeof fetch} */ f) => {
    const a = new DurableAudit({ AuditClient: /** @type {any} */ (class extends AuditClient { constructor(/** @type {any} */ o) { super({ ...o, logger: silent, fetch: f, sleep: async () => {} }); } }), target, store, retentionDays: 1 });
    return a;
  };
  /** @type {any[]} */ const sent = [];
  const down = mk(async () => new Response('{}', { status: 503 }));
  assert.equal(down.record({ action: 'atc-payments.payment.create', actor: { type: 'apikey', id: 'shop' } }), true);
  down.record({ action: 'atc-payments.refund.create' });
  await down.flush();
  assert.equal(down.backlog, 2, 'audit service down: nothing lost, still queued');
  // "crash": a new instance on the same database delivers what was queued.
  const up = mk(async (_u, init) => { sent.push(...JSON.parse(String(init?.body)).events); return new Response('{}', { status: 200 }); });
  await up.flush();
  assert.deepEqual(sent.map((e) => e.action), ['atc-payments.payment.create', 'atc-payments.refund.create']);
  assert.ok(sent.every((e) => typeof e.id === 'string' && typeof e.at === 'string'));
  assert.equal(up.backlog, 0);
  assert.equal(store.auditPurge(Date.now() + 86_400_000 * 2), 2);
  const off = new DurableAudit({ AuditClient, target: null, store, retentionDays: 1 });
  assert.equal(off.record({ action: 'x' }), false, 'audit not configured: nothing is stored');
});
