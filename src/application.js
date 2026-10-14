import { AuditClient } from '@atc-web/atc-service-core/audit';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from './config.js';
import { DurableAudit } from './audit/durable-audit.js';
import { Database } from './db.js';
import { PaymentService } from './domain/payment-service.js';
import { PaymentsApi } from './http/payments-api.js';
import { StripeClient } from './net/stripe-client.js';
import { WebhookPublisher } from './net/webhook-publisher.js';
import { PaymentStore } from './store/payment-store.js';

/** Composition root: wires configuration, storage, provider and HTTP, runs the outbox and retention, owns the lifecycle. */
export class Application {
  static MAINTAIN_MS = 3_600_000;

  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.store = new PaymentStore(this.db);
    // Money events must not be lost to a crash: outbox table first, network later.
    this.audit = new DurableAudit({ AuditClient, target: config.audit, store: this.store, retentionDays: config.limits.eventRetentionDays });
    const { stripe } = config;
    this.service = new PaymentService({
      config, store: this.store, audit: this.audit,
      stripe: stripe.secretKey ? new StripeClient({ secretKey: stripe.secretKey, apiUrl: stripe.apiUrl, timeoutMs: stripe.timeoutMs }) : null,
    });
    this.publisher = config.webhookOut ? new WebhookPublisher(config.webhookOut) : null;
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {NodeJS.Timeout[]} */
    this.timers = [];
    /** @type {Promise<unknown>} */
    this.publishing = Promise.resolve();
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const app = await new PaymentsApi({ config, audit: this.audit, service: this.service, db: this.db, version: this.version }).build();
    this.app = app;
    this.service.logger = app.log;
    const stale = this.store.idemClearStale();
    if (stale) app.log.warn({ keys: stale }, 'released idempotency keys of requests cut off by a restart');
    const maintain = () => {
      try {
        const r = this.service.maintain();
        if (r.idempotency || r.events || r.outbox) app.log.info(r, 'payments retention');
      } catch (err) { app.log.error({ err }, 'payments retention failed'); }
    };
    maintain();
    let busy = false;
    const publish = () => {
      if (busy || !this.publisher) return;
      busy = true;
      this.publishing = this.service.publishDue(this.publisher).catch((err) => app.log.error({ err }, 'outbox delivery failed')).finally(() => { busy = false; });
    };
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => { for (const t of this.timers) clearInterval(t); },
        () => this.app?.close(),
        () => this.publishing,
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, provider: this.service.enabled ? 'stripe' : 'disabled', webhooks: config.stripe.webhookSecret !== null, webhookOut: this.publisher !== null }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    if (process.send) process.send('ready'); // PM2 wait_ready
    this.timers.push(setInterval(publish, config.limits.outboxMs), setInterval(maintain, Application.MAINTAIN_MS));
    for (const t of this.timers) t.unref();
  }
}
