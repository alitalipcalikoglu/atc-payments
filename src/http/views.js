/** Response shapes. Client secrets are never part of them (only the create response carries one). */
export class Views {
  /** @param {number|null|undefined} t */
  static iso(t) {
    return t === null || t === undefined ? null : new Date(Number(t)).toISOString();
  }

  /** @param {import('../types.js').PaymentRow} p */
  static payment(p) {
    return {
      id: p.id, status: p.status, amount: Number(p.amount), currency: p.currency, amountRefunded: Number(p.amount_refunded), description: p.description,
      customerEmail: p.customer_email, metadata: JSON.parse(p.metadata), lastError: p.last_error, provider: { name: 'stripe', id: p.provider_id, status: p.provider_status },
      createdBy: p.created_by, createdAt: Views.iso(p.created_at), updatedAt: Views.iso(p.updated_at),
    };
  }

  /** @param {import('../types.js').RefundRow} r */
  static refund(r) {
    return { id: r.id, paymentId: r.payment_id, status: r.status, amount: Number(r.amount), reason: r.reason, failureReason: r.failure_reason, providerId: r.provider_id, createdBy: r.created_by, createdAt: Views.iso(r.created_at), updatedAt: Views.iso(r.updated_at) };
  }

  /** @param {import('../types.js').LedgerRow} l */
  static ledger(l) {
    return { seq: Number(l.seq), paymentId: l.payment_id, kind: l.kind, amount: Number(l.amount), currency: l.currency, ref: l.ref, at: Views.iso(l.at) };
  }

  /** @param {any} e */
  static event(e) {
    return { id: e.id, type: e.type, paymentId: e.payment_id, outcome: e.outcome, detail: e.detail, receivedAt: Views.iso(e.received_at) };
  }
}
