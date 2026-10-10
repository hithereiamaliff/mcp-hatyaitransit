/**
 * Creates a ready-to-use MCP server with every Hat Yai Transit tool registered.
 *
 * Used by both entry points:
 *   - http-server.ts creates a FRESH server for every HTTP request (stateless, nothing shared
 *     between users)
 *   - stdio.ts creates one server for the lifetime of the local process
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { HatYaiTransitApi } from './api.js';
import { SERVER_NAME, VERSION } from './config.js';
import { registerTools, type ToolCallHook, type ToolInfo } from './tools.js';

/** Guidance sent to the client when it connects; many clients show it to the model. */
export const SERVER_INSTRUCTIONS = [
  'Hat Yai Transit (unofficial): public transport in Hat Yai, Songkhla, southern Thailand: the EV City Loop bus (route HY3),',
  'the Hat Yai airport minibus (HY8299), SRT trains Hat Yai Junction to Padang Besar at the Malaysian border (SRT_741, SRT_SE45)',
  'and KTM MySawasdee (seasonal, info only).',
  'Typical flows: "How do I get from A to B?" -> plan_journey (stop IDs, coordinates or place names).',
  '"When is the next bus/train at X?" -> search_stops -> get_stop_departures.',
  'Route questions -> list_routes -> get_route / get_route_departures. Fares -> get_fares.',
  'All times are Thailand time (GMT+7). EV City Loop times at stops other than stop 1 are estimates; the airport minibus has',
  'operating hours only (no timetable). Trips deeper into Malaysia or Singapore get a hand-off link to the sister apps.',
  'Tell users the data is unofficial and to confirm with the operator; live tracking is in the ViaBus app (buses) and SRT TTS-TrainView (trains).',
].join(' ');

export interface CreateServerOptions {
  /** API client (default: built from HYT_API_URL / HYT_API_KEY). */
  api?: HatYaiTransitApi;
  /** Called after each tool call (used for /analytics). */
  onToolCall?: ToolCallHook;
  /** Clock override for tests. */
  now?: () => number;
}

export function createServer(options: CreateServerOptions = {}): { server: McpServer; tools: ToolInfo[] } {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'Hat Yai Transit',
      version: VERSION,
      websiteUrl: 'https://github.com/hithereiamaliff/mcp-hatyaitransit',
    },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const tools = registerTools(server, {
    api: options.api ?? new HatYaiTransitApi(),
    onToolCall: options.onToolCall,
    now: options.now,
  });
  return { server, tools };
}
