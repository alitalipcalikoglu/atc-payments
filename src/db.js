import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE payments (
      id              TEXT PRIMARY KEY,
      provider_id     TEXT NOT NULL UNIQUE,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'canceled', 'partially_refunded', 'refunded')),
      provider_status TEXT,
      amount          INTEGER NOT NULL CHECK (amount > 0),
      currency        TEXT NOT NULL,
      amount_refunded INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0 AND amount_refunded <= amount),
      description     TEXT NOT NULL DEFAULT '',
      customer_email  TEXT,
      metadata        TEXT NOT NULL DEFAULT '{}',
      last_error      TEXT,
      created_by      TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX payments_created ON payments (created_at DESC, id DESC);
    CREATE INDEX payments_status ON payments (status, created_at DESC);

    CREATE TABLE refunds (
      id             TEXT PRIMARY KEY,
      payment_id     TEXT NOT NULL REFERENCES payments(id),
      provider_id    TEXT NOT NULL UNIQUE,
      status         TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
      amount         INTEGER NOT NULL CHECK (amount > 0),
      reason         TEXT,
      failure_reason TEXT,
      created_by     TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX refunds_payment ON refunds (payment_id, created_at);

    -- Append-only money movements; one row per provider object and kind.
    CREATE TABLE ledger (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT NOT NULL REFERENCES payments(id),
      kind       TEXT NOT NULL CHECK (kind IN ('charge', 'refund')),
      amount     INTEGER NOT NULL,
      currency   TEXT NOT NULL,
      ref        TEXT NOT NULL,
      at         INTEGER NOT NULL,
      UNIQUE (kind, ref)
    );
    CREATE INDEX ledger_payment ON ledger (payment_id, seq);
    CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;

    -- Client idempotency keys, per API key and operation.
    CREATE TABLE idempotency (
      key_id       TEXT NOT NULL,
      idem_key     TEXT NOT NULL,
      scope        TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state        TEXT NOT NULL CHECK (state IN ('in_progress', 'done')),
      status_code  INTEGER,
      response     TEXT,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (key_id, idem_key)
    );
    CREATE INDEX idempotency_created ON idempotency (created_at);

    -- Every provider webhook event seen, by its id (replays are ignored).
    CREATE TABLE provider_events (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      payment_id  TEXT,
      outcome     TEXT NOT NULL CHECK (outcome IN ('applied', 'ignored', 'unknown')),
      detail      TEXT,
      received_at INTEGER NOT NULL
    );
    CREATE INDEX provider_events_received ON provider_events (received_at DESC);

    -- Events for atc-webhook-out, written in the same transaction as the change they describe.
    CREATE TABLE outbox (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      next_at    INTEGER NOT NULL,
      sent_at    INTEGER,
      last_error TEXT
    );
    CREATE INDEX outbox_due ON outbox (sent_at, next_at);
    `,
    // 2: durable audit forwarding (see src/audit/durable-audit.js)
    `
    CREATE TABLE audit_outbox (
      id      TEXT PRIMARY KEY,
      at      INTEGER NOT NULL,
      payload TEXT NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX audit_outbox_pending ON audit_outbox (at) WHERE sent_at IS NULL;
    `,
  ];
}
