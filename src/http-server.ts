/**
 * Production entry point: the MCP server over Streamable HTTP.
 *
 *   npm run build && npm start            (or: node dist/http-server.js)
 *
 * Settings (environment variables or a .env file):
 *   PORT          port to listen on (default 8080)
 *   HOST          address to bind (default 0.0.0.0)
 *   HYT_API_URL   Hat Yai Transit API base URL (default https://hatyaitransit.techmavie.digital)
 *   HYT_API_KEY   service key for the API; enables plan_journey and search_places
 */
import './env.js'; // must stay first: loads .env before anything reads settings

import { HatYaiTransitApi } from './api.js';
import { VERSION } from './config.js';
import { createHttpApp } from './http-app.js';

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

const api = new HatYaiTransitApi();
const app = createHttpApp({ api });

const httpServer = app.listen(port, host, () => {
  console.log(`[Hat Yai Transit MCP] v${VERSION} listening on http://${host}:${port}`);
  console.log(`  MCP endpoint: POST http://${host}:${port}/mcp`);
  console.log(`  Upstream API: ${api.baseUrl}`);
  // Only say whether a key is set, never print it.
  console.log(`  HYT_API_KEY:  ${api.hasApiKey ? 'set (journey planner + place search enabled)' : 'not set (journey planner + place search disabled)'}`);
});

/** Stop accepting new connections, let in-flight requests finish, then exit. */
function shutdown(signal: string): void {
  console.log(`[Hat Yai Transit MCP] ${signal} received, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
