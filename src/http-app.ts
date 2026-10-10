/**
 * The Express app behind the hosted MCP endpoint (Streamable HTTP, stateless).
 *
 *   POST   /mcp        MCP JSON-RPC requests. Each request gets its own fresh McpServer and
 *                      transport, which are thrown away when the response ends, so nothing
 *                      (sessions, state, data) is ever shared between callers.
 *   GET    /mcp        405: this server has no server-to-client event stream (stateless)
 *   DELETE /mcp        405: there are no sessions to end
 *   GET    /           server info + list of tools (handy in a browser)
 *   GET    /health     health check for Docker / uptime monitors
 *   GET    /analytics  in-memory usage counters
 *
 * Kept separate from http-server.ts (which only starts listening) so tests can run the app on
 * a random port.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { HatYaiTransitApi } from './api.js';
import { UsageStats } from './analytics.js';
import { DEVELOPERS_URL, PUBLIC_MCP_URL, REPORT_URL, VERSION } from './config.js';
import { createServer } from './server.js';

export interface HttpAppOptions {
  /** API client shared by all requests (it holds no per-user state). */
  api?: HatYaiTransitApi;
  /** Usage counters (a new set by default). */
  stats?: UsageStats;
}

/** JSON-RPC error body used for non-MCP failures on /mcp. */
function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

/**
 * The MCP spec asks clients to send "Accept: application/json, text/event-stream" and the SDK
 * rejects requests without it (HTTP 406). We always answer with plain JSON, so for simple
 * clients (curl, scripts) that send only one of them, or nothing, we add the missing types.
 * The SDK reads the raw header list, so both views of the headers are updated.
 */
function ensureAcceptHeader(req: Request): void {
  const accept = String(req.headers.accept ?? '');
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return;
  const value = 'application/json, text/event-stream';
  req.headers.accept = value;
  const raw = req.rawHeaders;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i]?.toLowerCase() === 'accept') raw.splice(i, 2);
  }
  raw.push('Accept', value);
}

export function createHttpApp(options: HttpAppOptions = {}) {
  const api = options.api ?? new HatYaiTransitApi();
  const stats = options.stats ?? new UsageStats();
  // Tool list for GET / (built once from a throwaway server; tools don't change at runtime)
  const toolList = createServer({ api }).tools.map((t) => ({ name: t.name, title: t.title, description: t.description }));

  const app = express();
  app.disable('x-powered-by');

  // CORS: MCP clients may run in a browser. Open to all origins; the session header is exposed
  // for clients that look for it (this server never sets one, as it is stateless).
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Max-Age', '86400');
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  // ── MCP endpoint ──────────────────────────────────────────────────────────
  app.post('/mcp', async (req: Request, res: Response) => {
    stats.recordRequest('POST /mcp');
    ensureAcceptHeader(req);
    // A fresh server + transport per request: stateless, so no session ID is generated.
    const { server } = createServer({ api, onToolCall: stats.recordToolCall });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] request failed:', (err as Error)?.message ?? err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
    }
  });

  const methodNotAllowed = (req: Request, res: Response) => {
    stats.recordRequest(`${req.method} /mcp`);
    res
      .status(405)
      .set('Allow', 'POST, OPTIONS')
      .json(jsonRpcError(-32000, 'Method not allowed. This MCP server is stateless: send JSON-RPC requests with POST /mcp.'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ── Info, health, analytics ───────────────────────────────────────────────
  app.get('/', (_req: Request, res: Response) => {
    stats.recordRequest('GET /');
    res.json({
      name: 'Hat Yai Transit MCP Server',
      version: VERSION,
      description:
        'Unofficial MCP server for public transport in Hat Yai, Thailand: EV City Loop bus, airport minibus, SRT trains to Padang Besar, journey planner.',
      endpoint: PUBLIC_MCP_URL,
      transport: 'streamable-http (stateless, JSON responses)',
      upstreamApi: api.baseUrl,
      journeyPlanner: api.hasApiKey ? 'enabled' : 'disabled (HYT_API_KEY not set)',
      getAnApiKey: DEVELOPERS_URL,
      reportWrongData: REPORT_URL,
      endpoints: { mcp: 'POST /mcp', health: 'GET /health', analytics: 'GET /analytics' },
      tools: toolList,
      source: 'https://github.com/hithereiamaliff/mcp-hatyaitransit',
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'mcp-hatyaitransit',
      version: VERSION,
      timestamp: new Date().toISOString(),
      apiKeyConfigured: api.hasApiKey,
    });
  });

  app.get('/analytics', (_req: Request, res: Response) => {
    stats.recordRequest('GET /analytics');
    res.json(stats.snapshot());
  });

  // ── Fallbacks ─────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not-found', message: 'Unknown path. The MCP endpoint is POST /mcp.' });
  });

  // Bad JSON bodies and other errors: answer in JSON-RPC style rather than an HTML page.
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json(jsonRpcError(-32700, 'Parse error: the request body is not valid JSON.'));
      return;
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json(jsonRpcError(-32600, 'Request body too large.'));
      return;
    }
    console.error('[HTTP] error:', err.message);
    res.status(err.status ?? 500).json(jsonRpcError(-32603, 'Internal server error'));
  });

  return app;
}
