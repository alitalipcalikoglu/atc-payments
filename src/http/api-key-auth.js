import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { PaymentError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/** Bearer API keys with two roles: `read` sees payments, refunds, the ledger and provider events; `write` also creates, cancels, syncs and refunds. */
export class ApiKeyAuth {
  static GRANTS = Object.freeze({ read: ['read', 'write'], write: ['write'] });

  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys.map((k) => ({ ...k, scopes: null })));
  }

  get hook() {
    return this.core.hook;
  }

  /** @param {'read'|'write'} need */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new PaymentError('FORBIDDEN', `this API key has no ${n} access`),
      grants: ApiKeyAuth.GRANTS,
    });
  }
}
