import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebhookPublisher } from '../src/net/webhook-publisher.js';

test('publisher: POST /v1/events with type, data and a stable idempotency key; errors carry the message', async () => {
  /** @type {any[]} */ const calls = [];
  const target = { url: 'http://wh.test', apiKey: 'k'.repeat(40), timeoutMs: 1000 };
  const p = new WebhookPublisher(target, /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return new Response('{}', { status: 202 }); }));
  await p.publish({ seq: 7, type: 'payment.succeeded', data: '{"id":"pay_1"}' });
  assert.deepEqual(calls, [{ url: 'http://wh.test/v1/events', auth: `Bearer ${'k'.repeat(40)}`, body: { type: 'payment.succeeded', data: { id: 'pay_1' }, idempotencyKey: 'atc-payments:7' } }]);
  const failing = new WebhookPublisher(target, /** @type {any} */ (async () => new Response(JSON.stringify({ error: { message: 'no such key' } }), { status: 401 })));
  await assert.rejects(failing.publish({ seq: 1, type: 'x', data: '{}' }), /atc-webhook-out: no such key/);
});
