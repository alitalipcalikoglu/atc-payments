/** @typedef {import('../types.js').PaymentRow} PaymentRow */
/** @typedef {import('../types.js').RefundRow} RefundRow */
/** @typedef {import('../types.js').LedgerRow} LedgerRow */

/** SQLite statements for payments, refunds, the ledger, idempotency keys, provider events and the outbox. */
export class PaymentStore {
  /** Stripe dispute statuses that still need or await a response. */
  static OPEN_DISPUTE = ['warning_needs_response', 'needs_response', 'warning_under_review', 'under_review'];
  /** Statuses in which evidence can still be changed or the dispute accepted. */
  static RESPONDABLE_DISPUTE = ['warning_needs_response', 'needs_response'];

  /** @param {import('../db.js').Database} db */
  constructor(db) {
    const raw = db.raw;
    this.raw = raw;
    this.stmt = {
      payment: raw.prepare('SELECT * FROM payments WHERE id = ?'),
      anonymize: raw.prepare("UPDATE payments SET customer_email = NULL, metadata = '{}', description = '', last_error = NULL, updated_at = ? WHERE id = ?"),
      inWindow: raw.prepare('SELECT * FROM payments WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id LIMIT ?'),
      byProvider: raw.prepare('SELECT * FROM payments WHERE provider_id = ?'),
      insertPayment: raw.prepare(`INSERT INTO payments (id, provider_id, status, provider_status, amount, currency, description, customer_email, metadata, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      setStatus: raw.prepare('UPDATE payments SET status = ?, provider_status = ?, last_error = ?, updated_at = ? WHERE id = ?'),
      setRefunded: raw.prepare('UPDATE payments SET status = ?, amount_refunded = ?, updated_at = ? WHERE id = ?'),
      refund: raw.prepare('SELECT * FROM refunds WHERE id = ?'),
      refundByProvider: raw.prepare('SELECT * FROM refunds WHERE provider_id = ?'),
      refundsOf: raw.prepare('SELECT * FROM refunds WHERE payment_id = ? ORDER BY created_at, id'),
      insertRefund: raw.prepare('INSERT INTO refunds (id, payment_id, provider_id, status, amount, reason, failure_reason, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      setRefund: raw.prepare('UPDATE refunds SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?'),
      pendingRefunded: raw.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM refunds WHERE payment_id = ? AND status = 'pending'"),
      ledgerInsert: raw.prepare('INSERT OR IGNORE INTO ledger (payment_id, kind, amount, currency, ref, at) VALUES (?, ?, ?, ?, ?, ?)'),
      ledgerOf: raw.prepare('SELECT * FROM ledger WHERE payment_id = ? ORDER BY seq'),
      ledgerPage: raw.prepare('SELECT * FROM ledger WHERE seq < ? ORDER BY seq DESC LIMIT ?'),
      balance: raw.prepare('SELECT currency, SUM(CASE WHEN kind = \'charge\' THEN amount ELSE 0 END) AS charged, -SUM(CASE WHEN kind = \'refund\' THEN amount ELSE 0 END) AS refunded, SUM(amount) AS net, COUNT(*) AS entries FROM ledger GROUP BY currency ORDER BY currency'),
      idem: raw.prepare('SELECT * FROM idempotency WHERE key_id = ? AND idem_key = ?'),
      idemStart: raw.prepare("INSERT INTO idempotency (key_id, idem_key, scope, request_hash, state, created_at) VALUES (?, ?, ?, ?, 'in_progress', ?)"),
      idemDone: raw.prepare("UPDATE idempotency SET state = 'done', status_code = ?, response = ? WHERE key_id = ? AND idem_key = ?"),
      idemDrop: raw.prepare('DELETE FROM idempotency WHERE key_id = ? AND idem_key = ?'),
      idemPrune: raw.prepare('DELETE FROM idempotency WHERE created_at < ?'),
      idemStale: raw.prepare("DELETE FROM idempotency WHERE state = 'in_progress'"),
      eventSeen: raw.prepare('SELECT 1 AS x FROM provider_events WHERE id = ?'),
      eventInsert: raw.prepare('INSERT INTO provider_events (id, type, payment_id, outcome, detail, received_at) VALUES (?, ?, ?, ?, ?, ?)'),
      eventsPage: raw.prepare('SELECT * FROM provider_events WHERE (received_at, id) < (?, ?) ORDER BY received_at DESC, id DESC LIMIT ?'),
      eventsPrune: raw.prepare('DELETE FROM provider_events WHERE received_at < ?'),
      dispute: raw.prepare('SELECT * FROM disputes WHERE id = ?'),
      disputesOf: raw.prepare('SELECT * FROM disputes WHERE payment_id = ? ORDER BY created_at, id'),
      upsertDispute: raw.prepare(`INSERT INTO disputes (id, payment_id, amount, currency, reason, status, evidence_due_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, reason = excluded.reason, status = excluded.status, evidence_due_by = COALESCE(excluded.evidence_due_by, disputes.evidence_due_by), updated_at = excluded.updated_at`),
      disputeEvidence: raw.prepare('UPDATE disputes SET evidence = ?, status = ?, submitted_at = ?, submitted_by = ?, updated_at = ? WHERE id = ?'),
      disputeStatus: raw.prepare('UPDATE disputes SET status = ?, updated_at = ? WHERE id = ?'),
      disputeCounts: raw.prepare('SELECT status, COUNT(*) AS n FROM disputes GROUP BY status'),
      outboxInsert: raw.prepare('INSERT INTO outbox (type, data, created_at, next_at) VALUES (?, ?, ?, ?)'),
      outboxDue: raw.prepare('SELECT * FROM outbox WHERE sent_at IS NULL AND next_at <= ? AND attempts < ? ORDER BY seq LIMIT ?'),
      outboxSent: raw.prepare('UPDATE outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE seq = ?'),
      outboxFailed: raw.prepare('UPDATE outbox SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE seq = ?'),
      outboxStats: raw.prepare('SELECT SUM(CASE WHEN sent_at IS NULL AND attempts < ? THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN sent_at IS NULL AND attempts >= ? THEN 1 ELSE 0 END) AS dead FROM outbox'),
      outboxPrune: raw.prepare('DELETE FROM outbox WHERE sent_at IS NOT NULL AND sent_at < ?'),
      auditInsert: raw.prepare('INSERT INTO audit_outbox (id, at, payload) VALUES (?, ?, ?)'),
      auditPending: raw.prepare('SELECT id, at, payload FROM audit_outbox WHERE sent_at IS NULL ORDER BY at LIMIT ?'),
      auditSent: raw.prepare('UPDATE audit_outbox SET sent_at = ? WHERE id = ?'),
      auditPurge: raw.prepare('DELETE FROM audit_outbox WHERE sent_at IS NOT NULL AND sent_at < ?'),
      auditBacklog: raw.prepare('SELECT COUNT(*) AS n FROM audit_outbox WHERE sent_at IS NULL'),
      byStatus: raw.prepare('SELECT status, COUNT(*) AS n FROM payments GROUP BY status'),
      volume: raw.prepare("SELECT currency, COUNT(*) AS n, SUM(amount) AS amount FROM payments WHERE created_at >= ? AND status IN ('succeeded', 'partially_refunded', 'refunded') GROUP BY currency ORDER BY currency"),
    };
  }

  /** Run `fn` in one write transaction. @template T @param {() => T} fn @returns {T} */
  tx(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** @param {string} id @returns {PaymentRow|undefined} */
  payment(id) { return /** @type {any} */ (this.stmt.payment.get(id)); }
  /** @param {string} providerId @returns {PaymentRow|undefined} */
  /** @param {string} id @param {number} now */
  anonymize(id, now) { this.stmt.anonymize.run(now, id); }

  /** @param {number} from @param {number} to @param {number} limit @returns {PaymentRow[]} */
  inWindow(from, to, limit) { return /** @type {any} */ (this.stmt.inWindow.all(from, to, limit)); }

  /** @param {string} providerId @returns {PaymentRow|undefined} */
  byProvider(providerId) { return /** @type {any} */ (this.stmt.byProvider.get(providerId)); }
  /** @param {PaymentRow} p */
  insertPayment(p) { this.stmt.insertPayment.run(p.id, p.provider_id, p.status, p.provider_status, p.amount, p.currency, p.description, p.customer_email, p.metadata, p.created_by, p.created_at, p.updated_at); }
  /** @param {string} id @param {string} status @param {string|null} providerStatus @param {string|null} error @param {number} now */
  setStatus(id, status, providerStatus, error, now) { this.stmt.setStatus.run(status, providerStatus, error, now, id); }
  /** @param {string} id @param {string} status @param {number} refunded @param {number} now */
  setRefunded(id, status, refunded, now) { this.stmt.setRefunded.run(status, refunded, now, id); }

  /** @param {string} id @returns {import('../types.js').DisputeRow|undefined} */
  dispute(id) { return /** @type {any} */ (this.stmt.dispute.get(id)); }
  /** @param {string} paymentId @returns {import('../types.js').DisputeRow[]} */
  disputesOf(paymentId) { return /** @type {any} */ (this.stmt.disputesOf.all(paymentId)); }
  /** @param {{ id: string, paymentId: string, amount: number, currency: string, reason: string, status: string, dueBy: number|null }} d @param {number} now */
  upsertDispute(d, now) { this.stmt.upsertDispute.run(d.id, d.paymentId, d.amount, d.currency, d.reason, d.status, d.dueBy, now, now); }
  /** @param {string} id @param {string} evidence @param {string} status @param {number|null} submittedAt @param {string|null} by @param {number} now */
  disputeEvidence(id, evidence, status, submittedAt, by, now) { this.stmt.disputeEvidence.run(evidence, status, submittedAt, by, now, id); }
  /** @param {string} id @param {string} status @param {number} now */
  disputeStatus(id, status, now) { this.stmt.disputeStatus.run(status, now, id); }
  /** @returns {Record<string, number>} */
  disputeCounts() { return Object.fromEntries(this.stmt.disputeCounts.all().map((r) => [String(r.status), Number(r.n)])); }
  /**
   * @param {{ status?: string, open?: boolean, paymentId?: string, before?: { at: number, id: string }, limit: number }} q
   * @returns {import('../types.js').DisputeRow[]}
   */
  disputes(q) {
    const where = [];
    /** @type {(string|number)[]} */ const args = [];
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.open) where.push(`status IN (${PaymentStore.OPEN_DISPUTE.map(() => '?').join(', ')})`), args.push(...PaymentStore.OPEN_DISPUTE);
    if (q.paymentId) { where.push('payment_id = ?'); args.push(q.paymentId); }
    if (q.before) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(q.before.at, q.before.at, q.before.id); }
    args.push(q.limit);
    return /** @type {any} */ (this.raw.prepare(`SELECT * FROM disputes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args));
  }

  /** @param {string} id @returns {RefundRow|undefined} */
  refund(id) { return /** @type {any} */ (this.stmt.refund.get(id)); }
  /** @param {string} providerId @returns {RefundRow|undefined} */
  refundByProvider(providerId) { return /** @type {any} */ (this.stmt.refundByProvider.get(providerId)); }
  /** @param {string} paymentId @returns {RefundRow[]} */
  refundsOf(paymentId) { return /** @type {any} */ (this.stmt.refundsOf.all(paymentId)); }
  /** @param {RefundRow} r */
  insertRefund(r) { this.stmt.insertRefund.run(r.id, r.payment_id, r.provider_id, r.status, r.amount, r.reason, r.failure_reason, r.created_by, r.created_at, r.updated_at); }
  /** @param {string} id @param {string} status @param {string|null} failure @param {number} now */
  setRefund(id, status, failure, now) { this.stmt.setRefund.run(status, failure, now, id); }
  /** @param {string} paymentId */
  pendingRefunded(paymentId) { return Number(this.stmt.pendingRefunded.get(paymentId)?.n ?? 0); }

  /** Idempotent: one entry per kind and provider ref. @param {string} paymentId @param {'charge'|'refund'} kind @param {number} amount @param {string} currency @param {string} ref @param {number} at */
  ledger(paymentId, kind, amount, currency, ref, at) { return Number(this.stmt.ledgerInsert.run(paymentId, kind, amount, currency, ref, at).changes) === 1; }
  /** @param {string} paymentId @returns {LedgerRow[]} */
  ledgerOf(paymentId) { return /** @type {any} */ (this.stmt.ledgerOf.all(paymentId)); }
  /** @param {number} before @param {number} limit @returns {LedgerRow[]} */
  ledgerPage(before, limit) { return /** @type {any} */ (this.stmt.ledgerPage.all(before, limit)); }
  balance() { return this.stmt.balance.all().map((r) => ({ currency: String(r.currency), charged: Number(r.charged), refunded: Number(r.refunded), net: Number(r.net), entries: Number(r.entries) })); }

  /** @param {string} keyId @param {string} key */
  idem(keyId, key) { return /** @type {{ scope: string, request_hash: string, state: 'in_progress'|'done', status_code: number|null, response: string|null }|undefined} */ (/** @type {any} */ (this.stmt.idem.get(keyId, key))); }
  /** @param {string} keyId @param {string} key @param {string} scope @param {string} hash @param {number} now */
  idemStart(keyId, key, scope, hash, now) { this.stmt.idemStart.run(keyId, key, scope, hash, now); }
  /** @param {string} keyId @param {string} key @param {number} status @param {unknown} response */
  idemDone(keyId, key, status, response) { this.stmt.idemDone.run(status, JSON.stringify(response), keyId, key); }
  /** @param {string} keyId @param {string} key */
  idemDrop(keyId, key) { this.stmt.idemDrop.run(keyId, key); }
  /** @param {number} cutoff */
  idemPrune(cutoff) { return Number(this.stmt.idemPrune.run(cutoff).changes); }
  /** Requests cut off by a restart left their key in progress; the provider key makes a retry safe. */
  idemClearStale() { return Number(this.stmt.idemStale.run().changes); }

  /** @param {string} id */
  eventSeen(id) { return this.stmt.eventSeen.get(id) !== undefined; }
  /** @param {string} id @param {string} type @param {string|null} paymentId @param {'applied'|'ignored'|'unknown'} outcome @param {string|null} detail @param {number} now */
  eventInsert(id, type, paymentId, outcome, detail, now) { this.stmt.eventInsert.run(id, type, paymentId, outcome, detail, now); }
  /** @param {number} limit */
  /** Newest first; `before` is the (received_at, id) of the previous page's last row. @param {number} limit @param {[number, string]} [before] */
  events(limit, before = [Number.MAX_SAFE_INTEGER, '']) { return this.stmt.eventsPage.all(before[0], before[1], limit); }
  /** @param {number} cutoff */
  eventsPrune(cutoff) { return Number(this.stmt.eventsPrune.run(cutoff).changes); }

  /** @param {string} type @param {unknown} data @param {number} now */
  outbox(type, data, now) { this.stmt.outboxInsert.run(type, JSON.stringify(data), now, now); }
  /** @param {number} now @param {number} maxAttempts @param {number} limit @returns {{ seq: number, type: string, data: string, attempts: number }[]} */
  outboxDue(now, maxAttempts, limit) { return /** @type {any} */ (this.stmt.outboxDue.all(now, maxAttempts, limit)); }
  /** @param {number} seq @param {number} now */
  outboxSent(seq, now) { this.stmt.outboxSent.run(now, seq); }
  /** @param {number} seq @param {number} next @param {string} error */
  outboxFailed(seq, next, error) { this.stmt.outboxFailed.run(next, error.slice(0, 500), seq); }
  /** @param {number} maxAttempts */
  outboxStats(maxAttempts) { const r = this.stmt.outboxStats.get(maxAttempts, maxAttempts); return { pending: Number(r?.pending ?? 0), dead: Number(r?.dead ?? 0) }; }
  /** @param {number} cutoff */
  outboxPrune(cutoff) { return Number(this.stmt.outboxPrune.run(cutoff).changes); }

  /** @param {string} id @param {number} at @param {string} payload */
  auditInsert(id, at, payload) { this.stmt.auditInsert.run(id, at, payload); }
  /** @param {number} limit @returns {{ id: string, at: number, payload: string }[]} */
  auditPending(limit) { return /** @type {any} */ (this.stmt.auditPending.all(limit)); }
  /** @param {string[]} ids @param {number} now */
  auditMarkSent(ids, now) { this.tx(() => { for (const id of ids) this.stmt.auditSent.run(now, id); }); }
  /** @param {number} cutoff */
  auditPurge(cutoff) { return Number(this.stmt.auditPurge.run(cutoff).changes); }
  auditBacklog() { return Number(this.stmt.auditBacklog.get()?.n ?? 0); }

  byStatus() { return Object.fromEntries(this.stmt.byStatus.all().map((r) => [String(r.status), Number(r.n)])); }
  /** @param {number} since */
  volume(since) { return this.stmt.volume.all(since).map((r) => ({ currency: String(r.currency), payments: Number(r.n), amount: Number(r.amount) })); }

  /**
   * Newest first, keyset paged on (created_at, id).
   * @param {{ status?: string, before?: { at: number, id: string }, limit: number, email?: string, currency?: string, minAmount?: number, maxAmount?: number, from?: number, to?: number, metaKey?: string, metaValue?: string }} q
   * @returns {PaymentRow[]}
   */
  payments(q) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const args = [];
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.email) { where.push('customer_email = ? COLLATE NOCASE'); args.push(q.email); }
    if (q.currency) { where.push('currency = ?'); args.push(q.currency.toLowerCase()); }
    if (q.minAmount !== undefined) { where.push('amount >= ?'); args.push(q.minAmount); }
    if (q.maxAmount !== undefined) { where.push('amount <= ?'); args.push(q.maxAmount); }
    if (q.from !== undefined) { where.push('created_at >= ?'); args.push(q.from); }
    if (q.to !== undefined) { where.push('created_at < ?'); args.push(q.to); }
    if (q.metaKey) { where.push("json_extract(metadata, '$.' || ?) = ?"); args.push(`"${q.metaKey.replace(/"/g, '')}"`, q.metaValue ?? ''); }
    if (q.before) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(q.before.at, q.before.at, q.before.id); }
    // Dynamic WHERE: prepared per call, never cached.
    return /** @type {any} */ (this.raw.prepare(`SELECT * FROM payments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, q.limit));
  }
}
