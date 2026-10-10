/**
 * The HTTP app (src/http-app.ts) on a random local port: MCP over POST /mcp, 405s, info,
 * health, analytics and CORS. The Hat Yai Transit API is faked.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createHttpApp } from '../src/http-app.js';
import { TEST_KEY, fakeApi } from './helpers.js';

describe('HTTP server', () => {
  let server: Server;
  let base = '';

  before(async () => {
    const { api } = fakeApi(
      { 'GET /api/fares': () => ({ body: { date: '2026-10-12', currency: 'THB', fares: [{ routeId: 'HY3', adult: 0, currency: 'THB' }], farePeriod: { isFreeTrial: true } } }) },
      { apiKey: TEST_KEY },
    );
    const app = createHttpApp({ api });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  test('POST /mcp answers tools/list, even without the full Accept header', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    assert.equal(body.result.tools.length, 14);
    assert.equal(res.headers.get('mcp-session-id'), null, 'stateless: no session');
  });

  test('initialize works and reports the server info', async () => {
    const res = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { Accept: 'application/json, text/event-stream' },
    );
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    assert.equal(body.result.serverInfo.name, 'hatyai-transit');
    assert.match(body.result.instructions, /plan_journey/);
  });

  test('tools/call works and is counted in /analytics', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_fares', arguments: {} } });
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.ok(!body.result.isError);
    assert.equal(JSON.parse(body.result.content[0]!.text).date, '2026-10-12');

    const stats = (await (await fetch(`${base}/analytics`)).json()) as { toolCalls: Record<string, { calls: number }>; totalToolCalls: number };
    assert.equal(stats.toolCalls.get_fares?.calls, 1);
    assert.ok(stats.totalToolCalls >= 1);
  });

  test('GET and DELETE /mcp → 405 with a JSON-RPC error', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method });
      assert.equal(res.status, 405);
      const body = (await res.json()) as { jsonrpc: string; error: { code: number } };
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32000);
    }
  });

  test('bad JSON → 400 parse error', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32700);
  });

  test('GET / lists the tools; GET /health is ok; neither reveals the key', async () => {
    const infoText = await (await fetch(`${base}/`)).text();
    const info = JSON.parse(infoText) as { tools: unknown[]; journeyPlanner: string };
    assert.equal(info.tools.length, 14);
    assert.equal(info.journeyPlanner, 'enabled');

    const healthText = await (await fetch(`${base}/health`)).text();
    const health = JSON.parse(healthText) as { status: string; apiKeyConfigured: boolean };
    assert.equal(health.status, 'ok');
    assert.equal(health.apiKeyConfigured, true);
    for (const text of [infoText, healthText]) assert.ok(!text.includes(TEST_KEY));
  });

  test('CORS preflight is open and exposes Mcp-Session-Id', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /Mcp-Session-Id/);
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
  });

  test('unknown paths → 404 JSON', async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'not-found');
  });
});
