/**
 * All MCP tools for Hat Yai Transit.
 *
 * Each tool calls one (sometimes two) endpoints of the public Hat Yai Transit API through the
 * client in api.ts, then reshapes the answer with the helpers in format.ts:
 *   - text in ONE language (en / th / ms) instead of all three
 *   - map-only fields dropped (colours, kerb pins, encoded polylines unless asked for)
 *   - short notes with the caveats that matter (estimated EV times, minibus has no timetable…)
 *
 * Every tool is read-only. Answers are compact JSON text. Failures come back as `isError`
 * results with a plain-language message, the HTTP status and the API's own error code.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { HatYaiApiError, HatYaiTransitApi, apiPath, explainApiError } from './api.js';
import {
  NOTES, compact, compactStop, decodePolyline, farePeriodSummary, isoDate, lineLengthKm, localize, notesForRoutes, pickLang, resolveDepartAt, bangkokNow, bangkokClock,
  type Lang,
} from './format.js';
import { DEVELOPERS_URL, REPORT_URL } from './config.js';

// ---------------------------------------------------------------------------
// Types for the parts of the API responses we read. Only the fields we use are listed;
// everything is optional because the data is community-maintained and may grow or change.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Tri = Partial<Record<Lang, string | null>>;

interface ApiRoute {
  id: string;
  shortName?: string;
  name?: Tri;
  kind?: string;
  agency?: { name?: Tri; phone?: string | null; url?: string | null } | null;
  dataConfidence?: string | null;
  timeStatus?: string | null;
  isLoop?: boolean;
  plannerEligible?: boolean;
  tracking?: Json | null;
  tickets?: Json | null;
  fare?: Json | null;
  operatingHours?: Json | null;
  directions?: Array<{ directionId: number; key?: string; name?: Tri; stopIds?: string[]; runMinutes?: number; lengthKm?: number }>;
  trips?: Json[] | null;
  runningDates?: { _note?: string; datesVerified?: string; pairs?: string[][] } | null;
  sourceIds?: string[];
  openItems?: string[];
}

interface RouteDeparture {
  time: string;
  minutesUntil: number;
  status?: string;
  headwayMin?: number | null;
  trainNumber?: string | null;
}

interface StopDeparture {
  routeId: string;
  route?: { shortName?: string; name?: Tri };
  directionId?: number;
  directionKey?: string | null;
  directionName?: Tri | null;
  headsignName?: Tri | null;
  continuesTo?: unknown;
  trainNo?: string | null;
  time: string;
  minutesUntil: number;
  status?: string;
  headwayMin?: number | null;
  isTomorrow?: boolean;
}

interface HoursOnly {
  routeId?: string;
  key?: string;
  route?: { shortName?: string; name?: Tri };
  directionId?: number;
  directionKey?: string | null;
  directionName?: Tri | null;
  operatingHours?: { from: string; to: string };
  approxHeadwayMin?: number | null;
}

interface PlacePrediction {
  placeId: string;
  description?: string;
  mainText?: string;
  secondaryText?: string;
  source?: string;
}

interface Place {
  placeId?: string;
  name?: string;
  formattedAddress?: string;
  lat: number;
  lng: number;
  stopId?: string;
  addressComponents?: unknown[];
}

/** Called after every tool call (the HTTP server uses it for /analytics). */
export type ToolCallHook = (name: string, ok: boolean, ms: number) => void;

export interface ToolContext {
  api: HatYaiTransitApi;
  onToolCall?: ToolCallHook;
  /** Clock (tests pin it). */
  now?: () => number;
}

/** What GET / shows for each tool. */
export interface ToolInfo {
  name: string;
  title: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Shared input fields
// ---------------------------------------------------------------------------

const language = z
  .enum(['en', 'th', 'ms'])
  .default('en')
  .describe('Language for names, notes and messages: "en" English (default), "th" Thai, "ms" Malay.');

const routeId = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe(
    'Route ID from list_routes: "HY3" (EV City Loop bus, route 3), "HY8299" (Hat Yai airport minibus), "SRT_741" (SRT shuttle trains 741-744, Hat Yai Junction-Padang Besar), "SRT_SE45" (SRT Special Express 45/46), "KTM_MYSAWASDEE" (seasonal KTM train, info only).',
  );

const stopId = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe('Stop ID such as "HY3_19" (Central Hat Yai) or "SRT_HAT_YAI" (Hat Yai Junction). Get IDs from search_stops, find_nearby_stops or get_route; do not guess.');

const direction = z
  .number()
  .int()
  .min(0)
  .max(1)
  .optional()
  .describe('Optional direction: 0 or 1 (see the directions in get_route; e.g. HY3: 0 = Loop Left, 1 = Loop Right; HY8299: 0 = to city, 1 = to airport; SRT_741: 0 = to Padang Besar, 1 = to Hat Yai).');

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

/** A successful answer: compact JSON text. */
function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** A failed answer the model should relay or act on. */
function fail(error: string, message: string, extra: Json = {}): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error, message, ...extra }) }], isError: true };
}

/** Converts any thrown error into a failed answer (API errors get a helpful explanation). */
function errorResult(err: unknown, api: HatYaiTransitApi): CallToolResult {
  if (err instanceof HatYaiApiError) {
    const message = explainApiError(err, api.hasApiKey);
    return fail(err.code, message, compact({
      httpStatus: err.status || undefined,
      apiMessage: err.message !== message ? err.message : undefined,
      retryAfterSec: err.retryAfterSec ?? undefined,
    }));
  }
  return fail('internal-error', `Unexpected error in the MCP server: ${(err as Error)?.message ?? String(err)}`);
}

// ---------------------------------------------------------------------------
// Reshaping helpers used by several tools
// ---------------------------------------------------------------------------

function fareSummary(f: Json | null | undefined, lang: Lang) {
  if (!f) return undefined;
  return compact({
    adult: f.adult,
    concession: f.concession,
    currency: f.currency !== 'THB' ? f.currency : undefined, // THB is the default; only other currencies are shown
    range: f.range,
    fromAdult: f.fromAdult,
    secondClassSleeper: f.secondClassSleeper,
    note: pickLang(f.note, lang),
  });
}

function trackingSummary(t: Json | null | undefined, full = false) {
  if (!t) return undefined;
  return compact({
    provider: t.provider,
    url: t.web ?? t.url,
    urlPattern: t.urlPattern,
    ios: full ? t.ios : undefined,
    android: full ? t.android : undefined,
  });
}

function ticketsSummary(t: Json | null | undefined, lang: Lang) {
  if (!t) return undefined;
  const loc = localize<Json>(t, lang); // note_en/note_th/note_ms → note
  return compact({ channel: loc.channel, fare: loc.fare, note: loc.note, url: loc.url });
}

/** Upcoming KTM MySawasdee running dates (pairs of [KL departure, Hat Yai departure]). */
function runningDatesSummary(rd: ApiRoute['runningDates'], today: string, all = false) {
  if (!rd?.pairs?.length) return undefined;
  const pairs = rd.pairs.map((p) => ({ fromKL: isoDate(p[0]), fromHatYai: isoDate(p[1]) }));
  const upcoming = pairs.filter((p) => (p.fromHatYai ?? '') >= today);
  return compact({
    upcoming: all ? upcoming : upcoming.slice(0, 3),
    note: rd._note ?? 'Confirm each date with KTMB before travel.',
  });
}

/** Route summary used by list_routes (short) and get_route (full). */
function routeSummary(r: ApiRoute, lang: Lang, today: string, full: boolean) {
  return compact({
    id: r.id,
    shortName: r.shortName,
    name: pickLang(r.name, lang),
    kind: r.kind,
    operator: pickLang(r.agency?.name, lang),
    phone: r.agency?.phone,
    operatorUrl: full ? r.agency?.url : undefined,
    timeStatus: r.timeStatus,
    dataConfidence: full ? r.dataConfidence : undefined,
    isLoop: r.isLoop || undefined,
    plannerEligible: r.plannerEligible === false ? false : undefined,
    operatingHours: r.operatingHours,
    fare: fareSummary(r.fare, lang),
    tickets: ticketsSummary(r.tickets, lang),
    tracking: trackingSummary(r.tracking, full),
    directions: full
      ? undefined // get_route builds richer directions itself
      : (r.directions ?? []).map((d) => compact({
          directionId: d.directionId,
          key: d.key,
          name: pickLang(d.name, lang),
          stops: d.stopIds?.length,
          firstStop: d.stopIds?.[0],
          lastStop: d.stopIds?.at(-1),
          runMinutes: d.runMinutes,
        })),
    trains: (r.trips ?? []).map((t) => compact({
      trainNo: t.trainNo ?? t.tripId,
      directionId: t.directionId,
      alsoNumbered: full && Array.isArray(t.aliases) && t.aliases.length ? t.aliases : undefined,
      delayWarning: t.delayWarning,
      note: t.note ?? t.displayNote,
      intermediateTimesVerified: full && t.intermediateTimesVerified === false ? false : undefined,
      trackUrl: full ? t.trackUrl : undefined,
    })),
    runningDates: runningDatesSummary(r.runningDates, today, full),
  });
}

/** One leg of a planned journey, without map-only data. */
function compactLeg(l: Json, lang: Lang, opts: { stops: boolean; polylines: boolean }) {
  const legStop = (s: unknown) => compactStop(s as Json, lang, { coords: false, routes: false, distance: false, verified: false });
  if (l.type === 'walking') {
    return compact({
      mode: 'walk',
      from: legStop(l.from),
      to: legStop(l.to),
      distanceM: l.distance,
      durationMin: l.duration,
      polyline: opts.polylines ? l.polyline : undefined,
    });
  }
  const route = (l.route ?? {}) as Json;
  const tickets = l.tickets as Json | null | undefined;
  const tracking = l.tracking as Json | null | undefined;
  const departEpoch = Number(l.departureEpochMs) || 0;
  const later = Array.isArray(l.nextDepartures) ? (l.nextDepartures as Json[]) : [];
  return compact({
    mode: l.mode,
    route: compact({ id: route.id, shortName: route.shortName, name: pickLang(route.name, lang) ?? route.longName }),
    trainNo: l.trainNo,
    direction: pickLang(l.directionName, lang),
    boardingHint: pickLang(l.boardingHint, lang),
    from: legStop(l.from),
    to: legStop(l.to),
    departureTime: l.departureTime,
    arrivalTime: l.arrivalTime,
    tomorrow: l.isTomorrowDeparture ? true : undefined,
    durationMin: l.duration,
    numStops: l.numStops,
    timeStatus: l.timeStatus,
    everyMin: l.headwayMin,
    operatingHours: l.operatingHours,
    fare: fareSummary(l.fare as Json, lang),
    tickets: tickets ? compact({ how: pickLang(tickets.label, lang), note: pickLang(tickets.note, lang), url: tickets.url }) : undefined,
    tracking: tracking ? compact({ label: pickLang(tracking.label, lang), url: tracking.url ?? tracking.web }) : undefined,
    phone: (l.contact as Json | undefined)?.phone,
    warnings: Array.isArray(l.warnings)
      ? (l.warnings as Json[]).map((w) => compact({ text: pickLang(w.text, lang), severity: w.severity === 'high' ? 'high' : undefined }))
      : undefined,
    // Later departures of the same service (only those after this leg's departure)
    laterDepartures: later
      .filter((d) => !departEpoch || Number(d.epochMs) > departEpoch)
      .slice(0, 3)
      .map((d) => compact({ time: d.time, trainNo: d.trainNo, status: d.status !== l.timeStatus ? d.status : undefined })),
    stops: opts.stops && Array.isArray(l.stops) ? (l.stops as Json[]).map((s) => legStop(s)) : undefined,
    polyline: opts.polylines ? l.polyline : undefined,
  });
}

function compactJourney(j: Json, index: number, lang: Lang, opts: { stops: boolean; polylines: boolean; departAtMs?: number }) {
  const s = (j.summary ?? {}) as Json;
  const fe = (s.fareEstimate ?? {}) as Json;
  let leaveAt = s.departureTime, arriveAt = s.arrivalTime;
  if (j.walkOnly) {
    // The API times the walk-only option from "now" even when departAt is set, and gives no
    // arrival time, so work both out here from the requested time (or the API's start time).
    const start = opts.departAtMs ?? Number(s.leaveByEpochMs);
    const minutes = Number(s.totalDuration) || 0;
    if (Number.isFinite(start)) {
      leaveAt = bangkokClock(start);
      arriveAt = bangkokClock(start + minutes * 60_000);
    }
  }
  return compact({
    option: index + 1,
    walkOnly: j.walkOnly ? true : undefined,
    leaveAt,
    arriveAt,
    tomorrow: s.isTomorrow ? true : undefined,
    durationMin: s.totalDuration,
    transfers: s.transfers,
    walkingM: s.totalWalkingDistance,
    fare: compact({
      adultThb: fe.adult,
      concessionThb: fe.concession,
      adultMyr: fe.adultMyr,
      isRange: fe.hasRange ? true : undefined,
      someFaresUnknown: fe.hasMissingFare ? true : undefined,
    }),
    usesAirportBoundMinibus: j.usesAirportBoundMinibus ? true : undefined,
    warnings: Array.isArray(j.warnings)
      ? (j.warnings as Json[]).map((w) => compact({ text: pickLang(w.text, lang), severity: w.severity }))
      : undefined,
    legs: Array.isArray(j.legs) ? (j.legs as Json[]).map((l) => compactLeg(l, lang, opts)) : [],
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Registers every tool on `server`. Returns the list of tools (name/title/description) so the
 * HTTP server can show it on GET / without starting an MCP session.
 */
export function registerTools(server: McpServer, ctx: ToolContext): ToolInfo[] {
  const { api } = ctx;
  const now = ctx.now ?? (() => Date.now());
  const registered: ToolInfo[] = [];

  /**
   * Registers one tool: read-only annotations, timing for /analytics, and a safety net that turns
   * any thrown error into an isError result (so the model always gets an explanation).
   */
  function add<Shape extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: Shape },
    run: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<CallToolResult>,
  ): void {
    const handler = async (args: z.objectOutputType<Shape, z.ZodTypeAny>): Promise<CallToolResult> => {
      const started = Date.now();
      let result: CallToolResult;
      try {
        result = await run(args);
      } catch (err) {
        result = errorResult(err, api);
      }
      ctx.onToolCall?.(name, !result.isError, Date.now() - started);
      return result;
    };
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: { title: config.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      // The SDK validates `args` against inputSchema before calling us, so this cast is safe.
      handler as never,
    );
    registered.push({ name, title: config.title, description: config.description });
  }

  /** Resolves a placeId from search_places (or "stop:<id>") to a point. */
  async function placeDetails(placeId: string, lang: Lang): Promise<Place> {
    const res = await api.get<{ place: Place }>('/api/journey/places/details', { placeId, language: lang });
    return res.place;
  }

  // ── 1. Service overview ──────────────────────────────────────────────────
  add(
    'get_service_info',
    {
      title: 'Hat Yai Transit overview',
      description:
        'START HERE for anything about public transport in Hat Yai (Songkhla, southern Thailand). Returns what Hat Yai Transit covers: the route IDs (HY3 EV City Loop bus, HY8299 airport minibus, SRT_741 and SRT_SE45 trains Hat Yai Junction-Padang Besar at the Malaysian border, KTM_MYSAWASDEE seasonal info only), today\'s date in Thailand, the current EV City Loop fare period, what the time statuses mean (scheduled / estimated / hours-only), live-tracking links, the unofficial-app disclaimer, and whether this server can use the journey planner and place search. Cheap to call; use it once per conversation for context.',
      inputSchema: { language },
    },
    async ({ language: lang }) => {
      const meta = await api.get<Json>('/api/meta');
      const loc = localize<Json>(meta, lang);
      const region = (loc.region ?? {}) as Json;
      return ok(compact({
        service: 'Hat Yai Transit (unofficial)',
        website: api.baseUrl,
        region: compact({ name: region.name, timezone: region.timezone, currency: region.currency, center: region.center }),
        today: loc.today,
        evFarePeriod: farePeriodSummary(meta.farePeriod),
        routes: Array.isArray(loc.routes)
          ? (loc.routes as Json[]).map((r) => compact({ id: r.id, shortName: r.shortName, name: r.name, kind: r.kind, timeStatus: r.timeStatus, plannerEligible: r.plannerEligible === false ? false : undefined }))
          : undefined,
        timeStatusMeaning: loc.statusLegend,
        liveTracking: {
          evLoopAndAirportMinibus: 'ViaBus app (https://www.viabus.co/)',
          srtTrains: 'SRT TTS-TrainView: https://ttsview.railway.co.th/searchresult_2023.php?trainno={trainNo}',
        },
        thisServer: {
          journeyPlanner: api.hasApiKey ? 'available (plan_journey)' : 'not available: HYT_API_KEY is not configured on this MCP server',
          placeSearch: api.hasApiKey ? 'available (search_places)' : 'not available: HYT_API_KEY is not configured on this MCP server',
        },
        sourcesLastReviewed: loc.sourcesLastReviewed,
        disclaimer: loc.disclaimer,
        reportWrongData: REPORT_URL,
        notes: [NOTES.timezone, NOTES.evEstimated, NOTES.minibusHoursOnly, NOTES.srtShuttle],
      }));
    },
  );

  // ── 2. Routes ────────────────────────────────────────────────────────────
  add(
    'list_routes',
    {
      title: 'List routes',
      description:
        'List every route with its ID, operator, time status, operating hours, fare in force today, directions (with stop counts) and, for trains, the train numbers. Use it to find a routeId for get_route, get_route_departures or get_route_geometry. Small answer (5 routes).',
      inputSchema: { language },
    },
    async ({ language: lang }) => {
      const res = await api.get<{ routes: ApiRoute[] }>('/api/routes');
      const today = bangkokNow(now()).date;
      const routes = (res.routes ?? []).map((r) => routeSummary(r, lang, today, false));
      return ok({ routes, notes: notesForRoutes(routes.map((r) => String(r.id)), [NOTES.currency, NOTES.unofficial]) });
    },
  );

  add(
    'get_route',
    {
      title: 'Route details',
      description:
        'Full details of one route: operator and phone, fare and ticket rules, operating hours, each direction with its stops in order, all stops with coordinates (and the other routes serving them, useful for transfers), train numbers and tracking links, KTM running dates, and known data gaps. Use after list_routes; then get_route_departures for times or get_stop_departures for one stop.',
      inputSchema: { routeId, language },
    },
    async ({ routeId: id, language: lang }) => {
      const res = await api.get<{ route: ApiRoute; stops: Json[] }>(apiPath`/api/routes/${id}`);
      const r = res.route;
      const today = bangkokNow(now()).date;
      const stops = (res.stops ?? []).filter(Boolean);
      const nameOf = new Map(stops.map((s) => [String(s.id), pickLang(s.name, lang)]));
      return ok(compact({
        ...routeSummary(r, lang, today, true),
        directions: (r.directions ?? []).map((d) => compact({
          directionId: d.directionId,
          key: d.key,
          name: pickLang(d.name, lang),
          runMinutes: d.runMinutes,
          lengthKm: d.lengthKm,
          stops: (d.stopIds ?? []).map((sid) => ({ id: sid, name: nameOf.get(sid) ?? sid })),
        })),
        stops: stops.map((s) => compactStop(s, lang)),
        dataGaps: r.openItems,
        sourceIds: r.sourceIds,
        notes: notesForRoutes([r.id], [NOTES.currency, 'Use get_sources for what each source ID refers to.']),
      }));
    },
  );

  add(
    'get_route_departures',
    {
      title: 'Route departures today',
      description:
        "Today's departures on one route, per direction: from the first stop by default, or the estimated/scheduled times at a given stop (stopId). By default only upcoming departures are listed (limit per direction); set includePast to see the whole day. EV City Loop (HY3) times away from stop 1 are estimates; the airport minibus (HY8299) has no timetable, so it returns operating hours only. For 'what leaves this stop next across all routes', use get_stop_departures instead.",
      inputSchema: {
        routeId,
        direction,
        stopId: stopId.optional().describe('Optional stop ID: show the times at this stop instead of the first stop.'),
        includePast: z.boolean().default(false).describe('Include departures that have already left today (default false).'),
        limit: z.number().int().min(1).max(60).default(10).describe('Maximum departures per direction (default 10).'),
        language,
      },
    },
    async ({ routeId: id, direction: dir, stopId: sid, includePast, limit, language: lang }) => {
      const res = await api.get<Json>(apiPath`/api/routes/${id}/departures`, { direction: dir, stopId: sid });
      const origins = (res.origins ?? {}) as Record<string, unknown>;
      const groups = Object.entries((res.directions ?? {}) as Record<string, RouteDeparture[]>);
      const extra: string[] = [];
      const directions = groups.map(([key, list]) => {
        const remaining = list.filter((d) => d.minutesUntil >= 0);
        const shown = (includePast ? list : remaining).slice(0, limit);
        if (!remaining.length && list.length) extra.push(`No more ${key} departures today; the first one of the day is at ${list[0]?.time}, so check again tomorrow.`);
        return compact({
          direction: key,
          boardingStop: pickLang(origins[key], lang),
          departuresToday: list.length,
          remainingToday: remaining.length,
          firstToday: list[0]?.time,
          lastToday: list.at(-1)?.time,
          departures: shown.map((d) => compact({ time: d.time, inMin: d.minutesUntil, status: d.status, everyMin: d.headwayMin, trainNo: d.trainNumber })),
        });
      });
      const hoursOnly = Array.isArray(res.hoursOnly)
        ? (res.hoursOnly as HoursOnly[]).map((h) => compact({ direction: h.key, operatingHours: h.operatingHours, approxEveryMin: h.approxHeadwayMin, status: 'hours-only' }))
        : [];
      return ok(compact({
        routeId: res.routeId ?? id,
        serviceDate: isoDate(res.serviceDate),
        runsToday: res.runsToday,
        directions: directions.filter((d) => (d.departuresToday ?? 0) > 0),
        hoursOnly,
        notes: notesForRoutes([id], extra),
      }));
    },
  );

  // ── 3. Stops ─────────────────────────────────────────────────────────────
  add(
    'search_stops',
    {
      title: 'Search stops',
      description:
        'Find stops and stations by name in Thai or English, or by a well-known alias (e.g. "Central", "Big C", "airport", "HDY", "Hat Yai Junction", "Padang Besar", "หอนาฬิกา"). Returns stop IDs with the routes serving each. Use the IDs with get_stop, get_stop_departures or plan_journey. If nothing matches, try a shorter name, the Thai name, or find_nearby_stops with coordinates.',
      inputSchema: {
        query: z.string().trim().min(1).max(100).describe('Stop or place name (Thai or English), e.g. "Central" or "สถานีรถไฟ".'),
        limit: z.number().int().min(1).max(20).default(10).describe('Maximum results (default 10).'),
        language,
      },
    },
    async ({ query, limit, language: lang }) => {
      const res = await api.get<{ stops: Json[] }>('/api/stops/search', { q: query });
      const stops = (res.stops ?? []).slice(0, limit).map((s) => compactStop(s, lang, { aliases: 3 }));
      return ok(compact({
        query,
        count: stops.length,
        stops,
        hint: stops.length ? undefined : 'No stop matched. Try a shorter or Thai name, search_places for a landmark (needs HYT_API_KEY), or find_nearby_stops with coordinates.',
      }));
    },
  );

  add(
    'get_stop',
    {
      title: 'Stop details',
      description:
        'Details of one stop: its name in Thai, English and Malay, coordinates, the routes that serve it, known aliases, whether the location has been checked on the ground, and the boarding point for each route direction (which side of the road). Use get_stop_departures for the next departures.',
      inputSchema: { stopId },
    },
    async ({ stopId: sid }) => {
      const res = await api.get<{ stop: Json }>(apiPath`/api/stops/${sid}`);
      const s = res.stop ?? {};
      return ok(compact({
        id: s.id,
        names: s.name,
        lat: s.lat,
        lng: s.lng,
        country: s.country,
        routes: s.routes,
        aliases: s.aliases,
        locationVerified: s.verified,
        boardingPoints: Array.isArray(s.kerbs)
          ? (s.kerbs as Json[]).map((k) => compact({ routeId: k.routeId, directionId: k.directionId, lat: k.lat, lng: k.lng }))
          : undefined,
        hint: 'Use get_stop_departures for the next departures here.',
      }));
    },
  );

  add(
    'find_nearby_stops',
    {
      title: 'Find nearby stops',
      description:
        'Stops near a point, nearest first, with straight-line distance and a rough walking time. Give lat + lng, or a placeId from search_places. Default radius 800 m (max 5000). Hat Yai city centre is about lat 7.0086, lng 100.4747. Follow up with get_stop_departures or plan_journey.',
      inputSchema: {
        lat: latitude.optional().describe('Latitude (use with lng), e.g. 7.0086.'),
        lng: longitude.optional().describe('Longitude (use with lat), e.g. 100.4747.'),
        placeId: z.string().trim().min(1).max(300).optional().describe('Instead of lat/lng: a placeId from search_places (needs HYT_API_KEY).'),
        radius: z.number().int().min(50).max(5000).default(800).describe('Search radius in metres (default 800, max 5000).'),
        limit: z.number().int().min(1).max(20).default(10).describe('Maximum results (default 10).'),
        language,
      },
    },
    async ({ lat, lng, placeId, radius, limit, language: lang }) => {
      let center: { lat: number; lng: number; name?: string };
      if (lat !== undefined && lng !== undefined) {
        center = { lat, lng };
      } else if (placeId) {
        const p = await placeDetails(placeId, lang);
        center = { lat: p.lat, lng: p.lng, name: p.name || p.formattedAddress };
      } else {
        return fail('missing-location', 'Give both lat and lng, or a placeId from search_places.');
      }
      const res = await api.get<{ stops: Json[] }>('/api/stops/nearby', { lat: center.lat, lon: center.lng, radius });
      const stops = (res.stops ?? []).slice(0, limit).map((s) => {
        const d = Number(s.distanceM);
        // Same walking assumptions as the journey planner: 72 m/min, streets 1.3x longer than a straight line.
        return { ...compactStop(s, lang), approxWalkMin: Number.isFinite(d) ? Math.max(1, Math.round((d * 1.3) / 72)) : undefined };
      });
      return ok(compact({
        center,
        radiusM: radius,
        count: stops.length,
        stops,
        hint: stops.length ? undefined : `No stops within ${radius} m. Try a larger radius (max 5000) or check the coordinates are in Hat Yai (around 7.0086, 100.4747).`,
      }));
    },
  );

  add(
    'get_stop_departures',
    {
      title: 'Next departures at a stop',
      description:
        "Answers 'when is the next bus/train at this stop?': the next departures from one stop across all routes (or one route), in time order, with minutes from now, direction, train number and whether each time is scheduled (timetable) or estimated. The airport minibus (HY8299) has no timetable, so it appears under hoursOnly with its operating hours. If nothing runs later today, tomorrow's first departures are included (marked tomorrow).",
      inputSchema: {
        stopId,
        count: z.number().int().min(1).max(20).default(8).describe('How many departures (default 8, max 20).'),
        routeId: routeId.optional().describe('Optional: only this route (e.g. "HY3" or "SRT_741").'),
        language,
      },
    },
    async ({ stopId: sid, count, routeId: rid, language: lang }) => {
      // The stop name isn't in the departures answer, so fetch the stop as well (cheap, in parallel).
      const [res, stopRes] = await Promise.all([
        api.get<{ departures: StopDeparture[]; hoursOnly: HoursOnly[] }>(apiPath`/api/stops/${sid}/departures`, { count, routeId: rid }),
        api.get<{ stop: Json }>(apiPath`/api/stops/${sid}`).catch(() => null),
      ]);
      const departures = (res.departures ?? []).map((d) => compact({
        time: d.time,
        inMin: d.minutesUntil,
        routeId: d.routeId,
        route: pickLang(d.route?.name, lang),
        direction: pickLang(d.directionName, lang) ?? d.directionKey,
        towards: pickLang(d.headsignName, lang),
        trainNo: d.trainNo,
        status: d.status,
        everyMin: d.headwayMin,
        tomorrow: d.isTomorrow ? true : undefined,
      }));
      const hoursOnly = (res.hoursOnly ?? []).map((h) => compact({
        routeId: h.routeId,
        route: pickLang(h.route?.name, lang),
        direction: pickLang(h.directionName, lang) ?? h.directionKey,
        operatingHours: h.operatingHours,
        approxEveryMin: h.approxHeadwayMin,
        status: 'hours-only',
      }));
      const routeIds = [...departures.map((d) => String(d.routeId)), ...hoursOnly.map((h) => String(h.routeId))];
      return ok(compact({
        stop: stopRes?.stop ? compactStop(stopRes.stop, lang, { coords: false }) : { id: sid },
        departures,
        hoursOnly,
        hint: departures.length || hoursOnly.length ? undefined : 'Nothing found for this stop (and route). Check the stop ID with search_stops, or try without routeId.',
        notes: notesForRoutes(routeIds),
      }));
    },
  );

  // ── 4. Fares ─────────────────────────────────────────────────────────────
  add(
    'get_fares',
    {
      title: 'Fares',
      description:
        'Fares in force on a date (default: today in Thailand), in Thai baht: EV City Loop (free trial until 12 Nov 2026, then 15 THB flat), airport minibus (60-80 THB, cash), SRT trains (50 THB 3rd class; Special Express 2nd-class sleeper 342 THB) and KTM MySawasdee (from RM95, booked via KTMB). Pass a date to see which EV fare period applies then.',
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional().describe('Date as YYYY-MM-DD (Thailand). Default: today.'),
        language,
      },
    },
    async ({ date, language: lang }) => {
      const res = await api.get<{ date: string; currency: string; fares: Json[]; farePeriod: Json }>('/api/fares', { date });
      return ok(compact({
        date: res.date,
        currency: res.currency,
        fares: (res.fares ?? []).map((f) => compact({ routeId: f.routeId, ...fareSummary(f, lang) })),
        evFarePeriod: farePeriodSummary(res.farePeriod),
        notes: [
          NOTES.currency,
          'On the EV City Loop, uniformed students, monks/novices and disabled passengers ride free.',
          'SRT shuttle tickets (741-744) are sold only at the station counter from 2 hours before departure; Special Express 45/46 can be booked on SRT D-Ticket.',
        ],
      }));
    },
  );

  // ── 5. Journey planner ───────────────────────────────────────────────────
  const endpointFields = (side: 'origin' | 'destination') => ({
    [`${side}StopId`]: stopId.optional().describe(`${side === 'origin' ? 'Origin' : 'Destination'} as a stop ID (best when known, e.g. "HY3_19").`),
    [`${side}Lat`]: latitude.optional().describe(`${side === 'origin' ? 'Origin' : 'Destination'} latitude (use with ${side}Lng).`),
    [`${side}Lng`]: longitude.optional().describe(`${side === 'origin' ? 'Origin' : 'Destination'} longitude (use with ${side}Lat).`),
    [`${side}PlaceId`]: z.string().trim().min(1).max(300).optional().describe(`${side === 'origin' ? 'Origin' : 'Destination'} as a placeId from search_places.`),
    [`${side}Text`]: z.string().trim().min(2).max(200).optional().describe(`${side === 'origin' ? 'Origin' : 'Destination'} as a place name, e.g. "Hat Yai Airport", "Lee Gardens Plaza", "Padang Besar". Resolved to the best match; check the resolved name in the answer.`),
  });

  type EndpointArgs = { stopId?: string; lat?: number; lng?: number; placeId?: string; text?: string };

  /** Turns the tool's origin/destination fields into what POST /api/journey/plan expects. */
  async function resolveEndpoint(e: EndpointArgs, lang: Lang): Promise<{ body: Json; how: string; alternatives?: Json[] } | null> {
    if (e.stopId) return { body: { stopId: e.stopId }, how: 'stop ID' };
    if (e.lat !== undefined && e.lng !== undefined) return { body: compact({ lat: e.lat, lng: e.lng, text: e.text }), how: 'coordinates' };
    if (e.placeId) {
      if (e.placeId.startsWith('stop:')) return { body: { stopId: e.placeId.slice(5) }, how: 'placeId (stop)' };
      const p = await placeDetails(e.placeId, lang);
      return { body: compact({ lat: p.lat, lng: p.lng, text: p.name || p.formattedAddress, name: p.name, placeId: p.placeId, addressComponents: p.addressComponents }), how: 'placeId' };
    }
    if (e.text) {
      // Place search: our own stops first, then Google places. If it isn't available (no service
      // key, Google switched off), let the planner resolve the text itself: it knows stop names,
      // aliases such as "HDY" or "Hat Yai Junction", and can geocode on the server.
      let predictions: PlacePrediction[] = [];
      try {
        predictions = (await api.get<{ predictions: PlacePrediction[] }>('/api/journey/places/autocomplete', { input: e.text, language: lang })).predictions ?? [];
      } catch (err) {
        if (!(err instanceof HatYaiApiError) || ![401, 403, 429, 502, 503].includes(err.status)) throw err;
      }
      const alternatives = predictions.slice(1, 4).map((p) => compact({ placeId: p.placeId, name: p.description ?? p.mainText }));
      const top = predictions[0];
      if (top?.placeId.startsWith('stop:')) return { body: { stopId: top.placeId.slice(5), text: e.text }, how: `text "${e.text}" → stop (best match)`, alternatives };
      if (top) {
        try {
          const p = await placeDetails(top.placeId, lang);
          return {
            body: compact({ lat: p.lat, lng: p.lng, text: p.name || top.description || e.text, name: p.name, placeId: p.placeId, addressComponents: p.addressComponents }),
            how: `text "${e.text}" → place "${top.description ?? p.name}" (best match)`,
            alternatives,
          };
        } catch (err) {
          if (!(err instanceof HatYaiApiError)) throw err;
        }
      }
      return { body: { text: e.text }, how: `text "${e.text}" (resolved by the planner)` };
    }
    return null;
  }

  add(
    'plan_journey',
    {
      title: 'Plan a journey',
      description:
        "Plan a trip within Hat Yai and along the railway to Padang Besar (Thai-Malaysian border): 'How do I get from A to B?'. Combines the EV City Loop bus, airport minibus, SRT trains and walking, and returns up to 5 options with leave/arrive times, legs, fares (THB, with MYR), ticket rules, tracking links and warnings. Give each end as ONE of: a stop ID, lat+lng, a placeId from search_places, or a place name (text). Departure time: now by default, or departAt. Trips that go further into Malaysia or Singapore return a hand-off link to the sister apps (Malaysia Transit / SG-JB Transit) instead of journeys: relay that link. Needs HYT_API_KEY on this server. Only 'depart at' is supported (no 'arrive by').",
      inputSchema: {
        ...endpointFields('origin'),
        ...endpointFields('destination'),
        departAt: z
          .string()
          .trim()
          .max(40)
          .optional()
          .describe('When to leave (Thailand time). "HH:MM" = today, or tomorrow if that time has passed; "YYYY-MM-DDTHH:MM" = that date (Thailand time); or a full ISO time with an offset. Default: now.'),
        includeBus: z.boolean().default(true).describe('Allow buses: EV City Loop and airport minibus (default true).'),
        includeRail: z.boolean().default(true).describe('Allow SRT trains (default true).'),
        planPadangBesarMy: z
          .boolean()
          .default(false)
          .describe('Trips ending at Padang Besar station on the Malaysian side are normally handed off to Malaysia Transit. Set true to plan them here anyway (only when the user wants to stop at Padang Besar).'),
        includeStops: z.boolean().default(false).describe('List every intermediate stop of each ride (default false).'),
        includePolylines: z.boolean().default(false).describe('Include encoded polylines for drawing the legs on a map (default false; they are long).'),
        language,
      },
    },
    async (args) => {
      const a = args as Record<string, unknown> & { language: Lang; includeBus: boolean; includeRail: boolean; planPadangBesarMy: boolean; includeStops: boolean; includePolylines: boolean; departAt?: string };
      const lang = a.language;
      const fields = (side: 'origin' | 'destination'): EndpointArgs => ({
        stopId: a[`${side}StopId`] as string | undefined,
        lat: a[`${side}Lat`] as number | undefined,
        lng: a[`${side}Lng`] as number | undefined,
        placeId: a[`${side}PlaceId`] as string | undefined,
        text: a[`${side}Text`] as string | undefined,
      });
      if (!api.hasApiKey) {
        return fail('api-key-required', `The journey planner needs an API key, and this MCP server has no HYT_API_KEY configured (keys: ${DEVELOPERS_URL}). Meanwhile, use search_stops, get_route and get_stop_departures to work out the trip.`);
      }
      for (const side of ['origin', 'destination'] as const) {
        const f = fields(side);
        if ((f.lat === undefined) !== (f.lng === undefined)) return fail(`invalid-${side}`, `Give both ${side}Lat and ${side}Lng, or neither.`);
      }

      let departAtIso: string | undefined;
      const extraNotes: string[] = [];
      if (a.departAt) {
        const resolved = resolveDepartAt(a.departAt, now());
        if (!resolved) return fail('invalid-departAt', 'departAt must be "HH:MM", "YYYY-MM-DDTHH:MM" (Thailand time) or a full ISO 8601 time with an offset.');
        departAtIso = resolved.iso;
        if (resolved.note) extraNotes.push(resolved.note);
      }

      const [origin, destination] = await Promise.all([resolveEndpoint(fields('origin'), lang), resolveEndpoint(fields('destination'), lang)]);
      if (!origin) return fail('missing-origin', 'Give the origin as originStopId, originLat+originLng, originPlaceId or originText.');
      if (!destination) return fail('missing-destination', 'Give the destination as destinationStopId, destinationLat+destinationLng, destinationPlaceId or destinationText.');

      const body = {
        origin: origin.body,
        destination: destination.body,
        options: compact({
          language: lang,
          modes: { bus: a.includeBus, rail: a.includeRail },
          departAt: departAtIso,
          planPadangBesarMy: a.planPadangBesarMy || undefined,
        }),
      };

      let res: Json;
      try {
        res = await api.post<Json>('/api/journey/plan', body);
      } catch (err) {
        // 400 = the planner could not find that place: say which end and how it was read.
        if (err instanceof HatYaiApiError && err.status === 400) {
          return fail(err.code, `${err.message} (origin read as: ${origin.how}; destination read as: ${destination.how}). Try a stop ID from search_stops or coordinates.`, { httpStatus: 400 });
        }
        throw err;
      }

      const place = (p: unknown, how: string, alternatives?: Json[]) => {
        const e = (p ?? {}) as Json;
        return compact({ name: e.name || e.text, stopId: e.stopId, lat: e.lat, lng: e.lng, readAs: how, otherMatches: alternatives });
      };
      const originOut = place(res.origin, origin.how, origin.alternatives);
      const destinationOut = place(res.destination, destination.how, destination.alternatives);

      // Answers that are not journeys (HTTP 200 with an "error" field)
      if (typeof res.error === 'string') {
        if (res.error === 'handoff-required') {
          const h = (res.handoff ?? {}) as Json;
          return ok(compact({
            status: 'handoff',
            message: pickLang(h.message, lang) ?? res.message,
            sisterApp: h.target === 'mt' ? 'Malaysia Transit' : h.target === 'sgjb' ? 'SG-JB Transit' : h.target,
            handoffUrl: h.url,
            alternative: h.secondary ? 'To travel only as far as Padang Besar station, call plan_journey again with planPadangBesarMy=true.' : undefined,
            origin: originOut,
            destination: destinationOut,
          }));
        }
        return ok(compact({
          status: res.error,
          message: res.message,
          suggestion: res.error === 'no-routes'
            ? 'No public-transport option was found. Try another departure time, or allow both bus and rail.'
            : res.error === 'area-out-of-coverage'
              ? 'Hat Yai Transit only covers Hat Yai city, the airport and the railway to Padang Besar. Suggest a taxi/ride-hailing or another provider for this trip.'
              : undefined,
          origin: originOut,
          destination: destinationOut,
        }));
      }

      const journeys = Array.isArray(res.journeys) ? (res.journeys as Json[]) : [];
      const opts = { stops: a.includeStops, polylines: a.includePolylines, departAtMs: departAtIso ? Date.parse(departAtIso) : undefined };
      const routeIds = journeys.flatMap((j) => ((j.legs as Json[]) ?? []).map((l) => (l.route as Json | undefined)?.id)).filter(Boolean).map(String);
      if (res.isTomorrow) extraNotes.push('There are no more suitable services today, so these options are for the next service day.');
      extraNotes.push('Fares are in Thai baht (THB); MYR amounts are approximate conversions. On the EV City Loop, uniformed students, monks/novices and disabled passengers ride free.');
      return ok(compact({
        status: 'ok',
        origin: originOut,
        destination: destinationOut,
        departAt: departAtIso ?? 'now',
        serviceDate: isoDate(res.serviceDate),
        isTomorrow: res.isTomorrow ? true : undefined,
        evFarePeriod: farePeriodSummary(res.farePeriod),
        journeys: journeys.map((j, i) => compactJourney(j, i, lang, opts)),
        notes: notesForRoutes(routeIds, extraNotes),
      }));
    },
  );

  add(
    'search_places',
    {
      title: 'Search places',
      description:
        'Look up a landmark, hotel, mall or address in or around Hat Yai and get placeIds (our transit stops first, then Google places). Use it when a place name is ambiguous, then pass the chosen placeId to plan_journey (originPlaceId / destinationPlaceId) or find_nearby_stops (placeId). Needs HYT_API_KEY on this server. For stop names, search_stops is cheaper.',
      inputSchema: {
        query: z.string().trim().min(2).max(100).describe('Place name or address, e.g. "Lee Gardens Plaza Hotel" or "ตลาดกิมหยง".'),
        language,
      },
    },
    async ({ query, language: lang }) => {
      if (!api.hasApiKey) {
        return fail('api-key-required', 'Place search needs the MCP service key (HYT_API_KEY), which is not configured on this server. Use search_stops for stops, or coordinates.');
      }
      const res = await api.get<{ predictions: PlacePrediction[] }>('/api/journey/places/autocomplete', { input: query, language: lang });
      const results = (res.predictions ?? []).map((p) => compact({
        placeId: p.placeId,
        name: p.mainText ?? p.description,
        detail: p.secondaryText,
        type: p.source === 'local' ? 'transit stop' : 'place',
      }));
      return ok(compact({
        query,
        results,
        hint: results.length
          ? 'Pass a placeId to plan_journey (originPlaceId/destinationPlaceId) or find_nearby_stops (placeId). Results outside Hat Yai cannot be planned here.'
          : 'Nothing found. Try another spelling, the Thai name, or coordinates.',
      }));
    },
  );

  // ── 6. Open data, sources, geometry ──────────────────────────────────────
  add(
    'list_gtfs_feeds',
    {
      title: 'GTFS open data feeds',
      description:
        'The open GTFS feeds (one per service plus a combined feed) with version, validity dates, size and download URL, and the data licence (ODbL 1.0) with the required attribution. Use for developer / open-data questions.',
      inputSchema: {},
    },
    async () => {
      const res = await api.get<Json>('/api/gtfs/feeds');
      const feed = (f: Json) => compact({
        id: f.id,
        name: f.name,
        version: f.version,
        validFrom: isoDate(f.startDate),
        validTo: isoDate(f.endDate),
        sizeKb: typeof f.bytes === 'number' ? Math.round(f.bytes / 1024) : undefined,
        download: typeof f.url === 'string' ? api.absoluteUrl(f.url) : undefined,
        files: Array.isArray(f.files) ? f.files.length : undefined,
      });
      const license = (res.license ?? {}) as Json;
      return ok(compact({
        publisher: res.publisher,
        generatedAt: res.generatedAt,
        license: compact({ id: license.id, name: license.name, url: license.url }),
        attribution: license.attribution,
        combinedFeed: res.combined ? feed(res.combined as Json) : undefined,
        feeds: Array.isArray(res.feeds) ? (res.feeds as Json[]).map(feed) : [],
        jsonApi: `${api.baseUrl}/api/gtfs/{feedId}/{file} (file: stops, routes, trips, stop_times, calendar, frequencies, shapes, fare_attributes, …)`,
        note: 'Route shapes in the GTFS feeds are built with OSRM over OpenStreetMap roads (ODbL).',
      }));
    },
  );

  add(
    'get_sources',
    {
      title: 'Data sources and disclaimer',
      description:
        'Where the data comes from (official operator and government sources, backed up by news coverage), when each source was last checked, the data licence and attributions, live-tracking links, the unofficial-app disclaimer, and where to report wrong or outdated data. Use it when the user asks how reliable or official the information is, wants to cite sources, or wants to report a mistake. Optional filters by source type or service.',
      inputSchema: {
        type: z.enum(['official', 'news']).optional().describe('Only sources of this type.'),
        service: z
          .enum(['evLoop', 'airportMinibus', 'rail', 'mySawasdee', 'liveTracking'])
          .optional()
          .describe('Only sources for this service: evLoop (HY3), airportMinibus (HY8299), rail (SRT), mySawasdee (KTM), liveTracking.'),
        language,
      },
    },
    async ({ type, service, language: lang }) => {
      const [res, meta] = await Promise.all([api.get<Json>('/api/sources'), api.get<Json>('/api/meta').catch(() => null)]);
      const loc = localize<Json>(res, lang);
      const sources = (Array.isArray(loc.sources) ? (loc.sources as Json[]) : [])
        .filter((s) => !type || s.type === type)
        .filter((s) => !service || (Array.isArray(s.services) && s.services.includes(service)))
        .map((s) => compact({ id: s.id, type: s.type, publisher: s.publisher, title: s.title, url: s.url, supports: s.supports, services: s.services, lastChecked: s.lastChecked }));
      const lic = (loc.dataLicense ?? {}) as Json;
      return ok(compact({
        disclaimer: (meta ? pickLang(meta.disclaimer, lang) : null) ?? NOTES.unofficial,
        lastReviewed: loc.lastReviewed,
        sourcesPage: `${api.baseUrl}/sources.html`,
        reportWrongData: `Report wrong or outdated information to the developer on Threads: ${REPORT_URL}`,
        sources,
        dataLicense: compact({ id: lic.id, name: lic.name, url: lic.url, attribution: lic.attribution }),
        platformAttributions: Array.isArray(loc.platformAttributions)
          ? (loc.platformAttributions as Json[]).map((p) => compact({ name: p.name, url: p.url, role: p.role }))
          : undefined,
        trackingLinks: loc.links,
      }));
    },
  );

  add(
    'get_route_geometry',
    {
      title: 'Route line (map geometry)',
      description:
        'Summary of the line a route follows on the map, per direction: number of points, approximate length, bounding box and end points. The encoded polyline (Google polyline format, precision 5) and per-direction stop pins are returned only when includePolyline / includeStopPins are true, as they are long. Only needed for drawing maps; not for answering travel questions.',
      inputSchema: {
        routeId,
        direction,
        includePolyline: z.boolean().default(false).describe('Include the encoded polyline (default false).'),
        includeStopPins: z.boolean().default(false).describe('Include where each stop pin sits for each direction (default false).'),
      },
    },
    async ({ routeId: id, direction: dir, includePolyline, includeStopPins }) => {
      const res = await api.get<Json>(apiPath`/api/routes/${id}/geometry`, { direction: dir });
      const shapes = (Array.isArray(res.shapes) ? (res.shapes as Json[]) : []).map((s) => {
        const points = typeof s.polyline === 'string' ? decodePolyline(s.polyline) : [];
        const lats = points.map((p) => p[0]), lngs = points.map((p) => p[1]);
        const stopIds = Array.isArray(s.stopIds) ? (s.stopIds as string[]) : [];
        const pins = Array.isArray(s.stopPoints) ? (s.stopPoints as number[][]) : [];
        return compact({
          directionId: s.directionId,
          directionKey: s.directionKey,
          lineSource: s.source,
          points: points.length,
          approxLengthKm: points.length > 1 ? lineLengthKm(points) : undefined,
          bbox: points.length ? { south: Math.min(...lats), west: Math.min(...lngs), north: Math.max(...lats), east: Math.max(...lngs) } : undefined,
          start: points[0],
          end: points.at(-1),
          stops: stopIds.length,
          polyline: includePolyline ? s.polyline : undefined,
          stopPins: includeStopPins ? stopIds.map((sid, i) => compact({ id: sid, lat: pins[i]?.[0], lng: pins[i]?.[1] })) : undefined,
        });
      });
      return ok(compact({
        routeId: res.routeId ?? id,
        attribution: res.attribution,
        shapes,
        note: 'These are the in-app map lines. The open GTFS shapes (OSRM over OpenStreetMap, ODbL) are separate: see list_gtfs_feeds.',
      }));
    },
  );

  return registered;
}
