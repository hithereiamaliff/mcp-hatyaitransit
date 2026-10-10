/**
 * The API client (src/api.ts): headers, URL building and path encoding, error mapping, timeout.
 * fetch is always faked, so these tests never touch the network.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { HatYaiApiError, HatYaiTransitApi, apiPath, explainApiError } from '../src/api.js';
import { TEST_KEY, fakeFetch } from './helpers.js';

describe('API client', () => {
  test('sends identification headers, and X-API-Key only when a key is configured', async () => {
    const { impl, calls } = fakeFetch({ 'GET /api/meta': () => ({ body: { ok: true } }) });

    const keyed = new HatYaiTransitApi({ baseUrl: 'https://api.test/', apiKey: TEST_KEY, fetchImpl: impl });
    assert.deepEqual(await keyed.get('/api/meta'), { ok: true });
    const h = calls[0]!.headers;
    assert.equal(h['x-api-key'], TEST_KEY);
    assert.equal(h['x-app-name'], 'Hat-Yai-Transit-MCP');
    assert.match(h['user-agent'] ?? '', /^mcp-hatyaitransit\//);
    assert.equal(h.accept, 'application/json');
    assert.equal(calls[0]!.url.href, 'https://api.test/api/meta', 'trailing slash on the base URL is handled');

    const keyless = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: '', fetchImpl: impl });
    await keyless.get('/api/meta');
    assert.equal(calls[1]!.headers['x-api-key'], undefined);
    assert.equal(keyless.hasApiKey, false);
    assert.equal(keyed.hasApiKey, true);
  });

  test('the key is not exposed as a property or in JSON', () => {
    const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: TEST_KEY, fetchImpl: fakeFetch({}).impl });
    assert.ok(!JSON.stringify(api).includes(TEST_KEY));
    assert.ok(!Object.values(api).some((v) => v === TEST_KEY));
  });

  test('query values: undefined, null and empty strings are left out', async () => {
    const { impl, calls } = fakeFetch({ 'GET /api/stops/nearby': () => ({ body: { stops: [] } }) });
    const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: '', fetchImpl: impl });
    await api.get('/api/stops/nearby', { lat: 7.0086, lon: 100.4747, radius: undefined, q: '', x: null, flag: false });
    assert.equal(calls[0]!.url.search, '?lat=7.0086&lon=100.4747&flag=false');
  });

  test('apiPath URL-encodes path parameters, so IDs cannot change the path', () => {
    assert.equal(apiPath`/api/stops/${'HY3_19'}/departures`, '/api/stops/HY3_19/departures');
    assert.equal(apiPath`/api/stops/${'../../admin?x=1#y'}`, '/api/stops/..%2F..%2Fadmin%3Fx%3D1%23y');
    assert.equal(apiPath`/api/routes/${'HY 3'}/geometry`, '/api/routes/HY%203/geometry');
  });

  test('POST sends a JSON body with Content-Type', async () => {
    const { impl, calls } = fakeFetch({ 'POST /api/journey/plan': (c) => ({ body: { echo: c.body } }) });
    const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: TEST_KEY, fetchImpl: impl });
    const res = await api.post<{ echo: unknown }>('/api/journey/plan', { origin: { stopId: 'HY3_19' } });
    assert.deepEqual(res.echo, { origin: { stopId: 'HY3_19' } });
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers['content-type'], 'application/json');
  });

  test('HTTP errors carry the status, the API error code and message', async () => {
    const { impl } = fakeFetch({
      'POST /api/journey/plan': () => ({ status: 401, body: { error: 'api-key-required', message: 'The journey planner API needs a free API key.' } }),
      'GET /api/meta': () => ({ status: 429, body: { error: 'rate-limited', message: 'Too many API requests.' }, headers: { 'Retry-After': '42' } }),
      'GET /api/broken': () => ({ status: 502 }),
    });
    const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: '', fetchImpl: impl });

    await assert.rejects(api.post('/api/journey/plan', {}), (err: unknown) => {
      assert.ok(err instanceof HatYaiApiError);
      assert.equal(err.status, 401);
      assert.equal(err.code, 'api-key-required');
      assert.equal(err.message, 'The journey planner API needs a free API key.');
      assert.match(explainApiError(err, false), /HYT_API_KEY/);
      return true;
    });

    await assert.rejects(api.get('/api/meta'), (err: unknown) => {
      assert.ok(err instanceof HatYaiApiError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterSec, 42);
      assert.match(explainApiError(err, true), /42 s/);
      return true;
    });

    await assert.rejects(api.get('/api/broken'), (err: unknown) => {
      assert.ok(err instanceof HatYaiApiError);
      assert.equal(err.status, 502);
      assert.equal(err.code, 'http-502');
      return true;
    });

    await assert.rejects(api.get('/api/unknown'), (err: unknown) => err instanceof HatYaiApiError && err.status === 404 && err.code === 'not-found');
  });

  test('an invalid configured key gets its own explanation', () => {
    const err = new HatYaiApiError({ status: 401, code: 'invalid-api-key', message: 'This API key is not valid', path: '/api/meta' });
    assert.match(explainApiError(err, true), /rejected/);
    const placeErr = new HatYaiApiError({ status: 403, code: 'app-only', message: 'Place search is only for the app', path: '/api/journey/places/autocomplete' });
    assert.match(explainApiError(placeErr, false), /HYT_API_KEY/);
  });

  test('gives up after the timeout with a "timeout" error', async () => {
    // A fetch that never answers, but respects the abort signal like the real one.
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: '', timeoutMs: 50, fetchImpl: hanging });
    // AbortSignal.timeout() uses an "unref'd" timer, and this fake fetch holds no socket open,
    // so keep Node's event loop alive until the timeout fires (a real fetch does this itself).
    const keepAlive = setTimeout(() => {}, 5000);
    const started = Date.now();
    try {
      await assert.rejects(api.get('/api/meta'), (err: unknown) => {
        assert.ok(err instanceof HatYaiApiError);
        assert.equal(err.code, 'timeout');
        assert.equal(err.status, 0);
        return true;
      });
    } finally {
      clearTimeout(keepAlive);
    }
    assert.ok(Date.now() - started < 2000, 'timed out promptly');
  });

  test('network failures and non-JSON answers are reported clearly', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: '', fetchImpl: failing });
    await assert.rejects(api.get('/api/meta'), (err: unknown) => err instanceof HatYaiApiError && err.code === 'network-error' && /fetch failed/.test(err.message));

    const html = (async () => new Response('<html>oops</html>', { status: 200 })) as typeof fetch;
    const api2 = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: '', fetchImpl: html });
    await assert.rejects(api2.get('/api/meta'), (err: unknown) => err instanceof HatYaiApiError && err.code === 'invalid-response');
  });

  test('absoluteUrl joins site paths to the base URL', () => {
    const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: '', fetchImpl: fakeFetch({}).impl });
    assert.equal(api.absoluteUrl('/gtfs/hatyai-ev-loop.zip'), 'https://api.test/gtfs/hatyai-ev-loop.zip');
    assert.equal(api.absoluteUrl('https://example.org/x'), 'https://example.org/x');
  });
});
