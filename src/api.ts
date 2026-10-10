/**
 * Hat Yai Transit API client.
 *
 * A small wrapper around `fetch` that:
 *   - adds the identification headers (X-App-Name, User-Agent) and, when configured, the
 *     service key (X-API-Key) to every request
 *   - gives up after a timeout (15 s by default) instead of hanging
 *   - turns every failure into a HatYaiApiError carrying the HTTP status and the API's own
 *     error code/message, so tools can explain what went wrong
 *
 * Path parameters must go through the `apiPath` tagged template below, which URL-encodes them
 * (a stop ID like "HY3/19" can never escape into a different API path).
 */
import { APP_NAME_HEADER, DEVELOPERS_URL, VERSION, readSettings } from './config.js';

/** Query-string values; undefined/null/'' are left out of the URL. */
export type QueryValue = string | number | boolean | undefined | null;
export type Query = Record<string, QueryValue>;

export interface ApiOptions {
  /** Base URL, e.g. https://hatyaitransit.techmavie.digital (default: HYT_API_URL). */
  baseUrl?: string;
  /** Service key (default: HYT_API_KEY). Pass '' for "no key". */
  apiKey?: string;
  /** Timeout per request in ms (default: HYT_API_TIMEOUT_MS or 15000). */
  timeoutMs?: number;
  /** fetch implementation (tests pass a fake one). */
  fetchImpl?: typeof fetch;
}

/** Everything that can go wrong when calling the API ends up as one of these. */
export class HatYaiApiError extends Error {
  /** HTTP status, or 0 when no response arrived (timeout, network error). */
  readonly status: number;
  /** The API's error code (e.g. "not-found", "api-key-required") or our own ("timeout"). */
  readonly code: string;
  /** API path that failed (no query string, so no secrets). */
  readonly path: string;
  /** Seconds to wait before retrying, from the Retry-After header (429 responses). */
  readonly retryAfterSec: number | null;
  /** The parsed error body from the API, if any. */
  readonly body: unknown;

  constructor(opts: { status: number; code: string; message: string; path: string; retryAfterSec?: number | null; body?: unknown }) {
    super(opts.message);
    this.name = 'HatYaiApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.path = opts.path;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.body = opts.body;
  }
}

/**
 * Builds an API path with every interpolated value URL-encoded.
 *   apiPath`/api/stops/${stopId}/departures`  →  "/api/stops/HY3_19/departures"
 */
export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  return strings.reduce((out, part, i) => out + part + (i < values.length ? encodeURIComponent(String(values[i])) : ''), '');
}

export class HatYaiTransitApi {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Kept private so it can't end up in logs or tool output by accident. */
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: ApiOptions = {}) {
    const env = readSettings();
    this.baseUrl = (options.baseUrl ?? env.apiUrl).trim().replace(/\/+$/, '');
    this.#apiKey = (options.apiKey ?? env.apiKey).trim();
    this.timeoutMs = options.timeoutMs ?? env.timeoutMs;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** True when a service key is configured (the key itself is never exposed). */
  get hasApiKey(): boolean {
    return this.#apiKey.length > 0;
  }

  /** GET a JSON endpoint. */
  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  /** POST a JSON body to an endpoint. */
  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  /** Absolute URL for a path on the API's website (e.g. GTFS downloads). */
  absoluteUrl(path: string): string {
    return /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, opts: { query?: Query; body?: unknown }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `mcp-hatyaitransit/${VERSION} (+https://github.com/hithereiamaliff/mcp-hatyaitransit)`,
      'X-App-Name': APP_NAME_HEADER,
    };
    if (this.#apiKey) headers['X-API-Key'] = this.#apiKey;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await this.#fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new HatYaiApiError({
          status: 0, code: 'timeout', path,
          message: `The Hat Yai Transit API did not answer within ${Math.round(this.timeoutMs / 1000)} s. Please try again shortly.`,
        });
      }
      throw new HatYaiApiError({
        status: 0, code: 'network-error', path,
        message: `Could not reach the Hat Yai Transit API (${(err as Error)?.message || 'network error'}).`,
      });
    }

    const text = await res.text().catch(() => '');
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (!res.ok) {
      const body = (data && typeof data === 'object' ? data : {}) as { error?: unknown; message?: unknown };
      const retry = Number(res.headers.get('retry-after'));
      throw new HatYaiApiError({
        status: res.status,
        code: typeof body.error === 'string' ? body.error : `http-${res.status}`,
        message: typeof body.message === 'string' ? body.message : `HTTP ${res.status} ${res.statusText || ''}`.trim(),
        path,
        retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : null,
        body: data,
      });
    }
    if (data === undefined) {
      throw new HatYaiApiError({ status: res.status, code: 'invalid-response', path, message: 'The Hat Yai Transit API returned a response that is not JSON.' });
    }
    return data as T;
  }
}

/**
 * A plain-language explanation of an API error for the model (and the user), including what
 * to do next. `hasApiKey` tells it whether this MCP server was configured with HYT_API_KEY.
 */
export function explainApiError(err: HatYaiApiError, hasApiKey: boolean): string {
  switch (true) {
    case err.code === 'invalid-api-key':
      return 'The HYT_API_KEY configured on this MCP server was rejected by the Hat Yai Transit API (not valid or revoked). The server operator needs to update it.';
    case err.code === 'api-key-required' || (err.status === 401 && !hasApiKey):
      return `The journey planner needs an API key, and this MCP server has no HYT_API_KEY configured. The operator can set HYT_API_KEY (keys: ${DEVELOPERS_URL}). Until then, use the stop, route and departure tools to work out the trip.`;
    case err.code === 'app-only' || (err.status === 403 && err.path.includes('/places/')):
      return hasApiKey
        ? 'Place search is not allowed for the configured API key (it needs the MCP service key, not a developer key). Use a stop ID (search_stops) or coordinates instead.'
        : 'Place search needs the MCP service key (HYT_API_KEY), which is not configured. Use a stop ID (search_stops) or coordinates instead.';
    case err.status === 401 || err.status === 403:
      return `The Hat Yai Transit API refused the request (HTTP ${err.status}): ${err.message}`;
    case err.status === 429:
      return `Rate limit reached on the Hat Yai Transit API${err.retryAfterSec ? `; try again in about ${err.retryAfterSec} s` : '; wait a little before retrying'}. ${err.message}`;
    case err.status === 404:
      return `Not found (${err.path}). Check the ID: use list_routes for route IDs and search_stops or find_nearby_stops for stop IDs.`;
    case err.code === 'places-unavailable':
      return 'Place search is temporarily unavailable on the API. Use a stop ID (search_stops) or coordinates instead.';
    case err.status >= 500:
      return `The Hat Yai Transit API is having trouble right now (HTTP ${err.status}): ${err.message}. Try again later.`;
    default:
      return err.message;
  }
}
