import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static CURRENCY_PATTERN = /^[a-z]{3}$/;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.stripe = v.stripe;
    this.webhookOut = v.webhookOut;
    this.limits = Object.freeze({ ...v.limits, currencies: Object.freeze([...v.limits.currencies]) });
    Object.freeze(this);
  }

  /** @param {NodeJS.ProcessEnv} [env] @returns {Config} */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);
    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');
    const currencies = r.list('CURRENCIES', 'usd,eur,gbp,try').map((c) => c.toLowerCase());
    for (const c of currencies) if (!Config.CURRENCY_PATTERN.test(c)) throw new ConfigError(`CURRENCIES entry "${c}" is not a three-letter currency code`);
    if (!currencies.length) throw new ConfigError('CURRENCIES must name at least one currency');
    return new Config({
      port: r.integer('PORT', 3019, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 262_144, { min: 16_384 }),
      dbPath: r.optional('DB_PATH') || './data/payments.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('PAYMENTS_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      stripe: Config.#parseStripe(r),
      webhookOut: Config.#parseWebhookOut(r),
      limits: {
        currencies,
        minAmount: r.integer('MIN_AMOUNT', 50, { min: 1 }),
        maxAmount: r.integer('MAX_AMOUNT', 99_999_999, { min: 1, max: 99_999_999 }),
        idempotencyHours: r.integer('IDEMPOTENCY_TTL_HOURS', 24, { min: 1, max: 720 }),
        eventRetentionDays: r.integer('EVENT_RETENTION_DAYS', 30, { min: 1, max: 3_650 }),
        outboxMs: r.integer('OUTBOX_MS', 2_000, { min: 100 }),
        outboxMaxAttempts: r.integer('OUTBOX_MAX_ATTEMPTS', 20, { min: 1, max: 1_000 }),
      },
    });
  }

  /**
   * Empty STRIPE_SECRET_KEY = provider disabled: creating payments answers 503 and /ready says so.
   * Empty STRIPE_WEBHOOK_SECRET = the webhook endpoint answers 503.
   * @param {EnvReader} r
   */
  static #parseStripe(r) {
    const secretKey = r.optional('STRIPE_SECRET_KEY');
    const webhookSecret = r.optional('STRIPE_WEBHOOK_SECRET');
    if (secretKey && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(secretKey)) throw new ConfigError('STRIPE_SECRET_KEY must be a Stripe secret or restricted key (sk_… or rk_…)');
    if (webhookSecret && !/^whsec_[A-Za-z0-9+/=]{10,}$/.test(webhookSecret)) throw new ConfigError('STRIPE_WEBHOOK_SECRET must be a Stripe signing secret (whsec_…)');
    const apiUrl = (r.optional('STRIPE_API_URL') || 'https://api.stripe.com').replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+$/.test(apiUrl)) throw new ConfigError('STRIPE_API_URL must be an origin like https://api.stripe.com');
    return {
      secretKey: secretKey || null,
      webhookSecret: webhookSecret || null,
      apiUrl,
      timeoutMs: r.integer('STRIPE_TIMEOUT_MS', 20_000, { min: 1_000, max: 80_000 }),
      toleranceSec: r.integer('WEBHOOK_TOLERANCE_SEC', 300, { min: 10, max: 3_600 }),
    };
  }

  /** @param {EnvReader} r */
  static #parseWebhookOut(r) {
    const url = r.optional('WEBHOOK_OUT_URL').replace(/\/+$/, '');
    const apiKey = r.optional('WEBHOOK_OUT_API_KEY');
    if (!url && !apiKey) return null;
    if (!url || !apiKey) throw new ConfigError('WEBHOOK_OUT_URL and WEBHOOK_OUT_API_KEY must be set together');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError('WEBHOOK_OUT_URL must be an absolute http(s) URL');
    return { url, apiKey, timeoutMs: r.integer('WEBHOOK_OUT_TIMEOUT_MS', 10_000, { min: 500 }) };
  }

  /** `id:secret:role`, role `read` or `write`. @param {string} raw @returns {ApiKey[]} */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'PAYMENTS_API_KEYS', { roles: ['read', 'write'], minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read or write' })
      .map(({ id, secret, role }) => ({ id, secret, role: /** @type {KeyRole} */ (role) }));
  }
}
