/**
 * Test helpers: a fake `fetch` that answers like the Hat Yai Transit API (no network), and an
 * in-memory MCP client connected to a real server built by createServer().
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { HatYaiTransitApi } from '../src/api.js';
import { createServer } from '../src/server.js';

/** Monday 12 Oct 2026, 06:00 in Bangkok: the same pinned clock the API's own tests use. */
export const MONDAY_6AM = Date.parse('2026-10-12T06:00:00+07:00');

/** A fake key in the API's format. Never a real key. */
export const TEST_KEY = 'hyt_0123456789abcdef0123456789abcdef';

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (call: RecordedCall) => FakeResponse | Promise<FakeResponse>;

/**
 * Builds a fake fetch. `routes` maps "METHOD /path" (path without query) to a handler.
 * Unknown paths answer 404 { error: "not-found" }, like the real API.
 */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { method, url, headers, body };
    calls.push(call);
    const handler = routes[`${method} ${url.pathname}`];
    const r: FakeResponse = handler ? await handler(call) : { status: 404, body: { error: 'not-found' } };
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { impl, calls };
}

/** An API client wired to a fake fetch. */
export function fakeApi(routes: Record<string, Handler>, opts: { apiKey?: string } = {}) {
  const { impl, calls } = fakeFetch(routes);
  const api = new HatYaiTransitApi({ baseUrl: 'https://api.test', apiKey: opts.apiKey ?? '', timeoutMs: 2000, fetchImpl: impl });
  return { api, calls };
}

/** Connects an MCP client to a fresh server (in memory). */
export async function connect(api: HatYaiTransitApi, now: () => number = () => MONDAY_6AM) {
  const { server } = createServer({ api, now });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Calls a tool and parses its JSON text answer (falls back to the raw text). */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const first = (res.content as Array<{ type: string; text: string }>)[0];
  const text = first?.text ?? '';
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: Boolean(res.isError), data, text };
}
