/**
 * Settings and constants shared by the whole server.
 *
 * Every setting comes from an environment variable, read when it is needed (not at import
 * time), so tests can pass their own values and a .env file loaded by src/env.ts still applies.
 */
import { readFileSync } from 'node:fs';

/** Public Hat Yai Transit API (the REST API behind the Hat Yai Transit web app). */
export const DEFAULT_API_URL = 'https://hatyaitransit.techmavie.digital';

/** Where developers can request their own API key. */
export const DEVELOPERS_URL = 'https://hatyaitransit.techmavie.digital/developers.html';

/** Where people can report wrong or outdated data (the API's own code is private). */
export const REPORT_URL = 'https://threads.com/@hiiialanhere';

/** Sent as X-App-Name on every API call, so the API's analytics can tell MCP traffic apart. */
export const APP_NAME_HEADER = 'Hat-Yai-Transit-MCP';

/** Name the MCP server reports to clients. */
export const SERVER_NAME = 'hatyai-transit';

/** How long to wait for the API before giving up (milliseconds). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Public URL of the hosted MCP endpoint (shown in docs and GET /). */
export const PUBLIC_MCP_URL = 'https://mcp.techmavie.digital/hatyaitransit/mcp';

/** The version in package.json (falls back to 0.0.0 if the file can't be read). */
export const VERSION: string = (() => {
  try {
    // Works from both src/ (tsx) and dist/ (built), as package.json sits one level up.
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

export interface Settings {
  /** Base URL of the Hat Yai Transit API, without a trailing slash. */
  apiUrl: string;
  /** Service key for the API (HYT_API_KEY). Empty string = no key. Never log this. */
  apiKey: string;
  /** API request timeout in milliseconds. */
  timeoutMs: number;
}

/** Reads the API settings from the environment. */
export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const timeout = Number(env.HYT_API_TIMEOUT_MS);
  return {
    apiUrl: (env.HYT_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, ''),
    apiKey: (env.HYT_API_KEY || '').trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}
