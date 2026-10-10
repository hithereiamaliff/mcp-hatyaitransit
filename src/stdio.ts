#!/usr/bin/env node
/**
 * Local entry point: the MCP server over stdio, for desktop clients that start the server
 * themselves (Claude Desktop, Cursor, Windsurf, the MCP Inspector, …).
 *
 *   npm run build && node dist/stdio.js
 *
 * IMPORTANT: in stdio mode, stdout carries the MCP protocol. Never console.log() here; use
 * console.error() for messages (they go to stderr, which clients show as logs).
 */
import './env.js'; // must stay first: loads .env before anything reads settings

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { HatYaiTransitApi } from './api.js';
import { VERSION } from './config.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const api = new HatYaiTransitApi();
  const { server } = createServer({ api });
  await server.connect(new StdioServerTransport());
  console.error(
    `[Hat Yai Transit MCP] v${VERSION} running on stdio (API: ${api.baseUrl}; journey planner ${api.hasApiKey ? 'enabled' : 'disabled: set HYT_API_KEY'})`,
  );
}

main().catch((err) => {
  console.error('[Hat Yai Transit MCP] failed to start:', err);
  process.exit(1);
});
