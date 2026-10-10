/**
 * Helpers that turn the API's JSON into small, model-friendly answers.
 *
 * The API returns most text in all three languages, e.g. { th: "…", en: "…", ms: "…" }, plus
 * map-only fields (colours, kerb pins, encoded polylines). Tools pick ONE language with
 * `localize()` and keep only the fields a person planning a trip needs, which cuts responses
 * to a fraction of their raw size.
 */

export const LANGUAGES = ['en', 'th', 'ms'] as const;
export type Lang = (typeof LANGUAGES)[number];

export const TIMEZONE = 'Asia/Bangkok';

/** Short notes added to answers so the model passes the important caveats on. */
export const NOTES = {
  timezone: 'All times are Thailand time (Asia/Bangkok, GMT+7), one hour behind Malaysia and Singapore.',
  evEstimated:
    'EV City Loop (HY3): only departures from stop 1 follow the published Songkhla PAO timetable (07:00-19:00, every 20-30 min); times at other stops are estimates. Live tracking: ViaBus app.',
  minibusHoursOnly:
    'Airport minibus (HY8299) has no timetable: only operating hours (about 08:00-17:00) are known, and departures from the airport follow flight arrivals. Allow plenty of time when heading to the airport.',
  srtShuttle:
    'SRT shuttle trains 741-744: tickets only at the station counter (Hat Yai Junction / Padang Besar), on sale from 2 hours before departure; no online booking. Northbound 742/744 often run late because of border formalities.',
  unofficial:
    'Hat Yai Transit is an unofficial community app, not affiliated with Songkhla PAO, Airports of Thailand, SRT, KTMB or ViaBus. Times may be estimates; always confirm with the operator.',
  currency: 'Fares are in Thai baht (THB) unless another currency is shown.',
  mySawasdee: 'KTM MySawasdee is a seasonal KTMB charter train, shown for information only; check running dates and book on KTMB.',
} as const;

// ---------------------------------------------------------------------------
// Language handling
// ---------------------------------------------------------------------------

const LANG_KEYS = new Set<string>(LANGUAGES);
const SUFFIXED = /^(.+)_(en|th|ms)$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Is this a { th, en, ms } text object? (at least two of the languages, only text values) */
export function isTrilingual(v: unknown): v is Partial<Record<Lang, string | null>> {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length >= 2 && keys.every((k) => LANG_KEYS.has(k) && (typeof v[k] === 'string' || v[k] === null));
}

/** Picks one language from a { th, en, ms } object (falls back to English, then Thai). */
export function pickLang(v: unknown, lang: Lang): string | null {
  if (typeof v === 'string') return v;
  if (!isTrilingual(v)) return null;
  return v[lang] ?? v.en ?? v.th ?? v.ms ?? null;
}

/**
 * Deep copy of `value` with every { th, en, ms } object replaced by the chosen language, and
 * every `field_en` / `field_th` / `field_ms` group replaced by one `field` (kept as is if a
 * plain `field` already exists).
 */
export function localize<T = unknown>(value: unknown, lang: Lang): T {
  if (Array.isArray(value)) return value.map((v) => localize(v, lang)) as T;
  if (!isPlainObject(value)) return value as T;
  if (isTrilingual(value)) return pickLang(value, lang) as T;

  const out: Record<string, unknown> = {};
  const groups = new Map<string, Record<string, unknown>>();
  for (const [key, v] of Object.entries(value)) {
    const m = SUFFIXED.exec(key);
    if (m && m[1] && m[2]) {
      const g = groups.get(m[1]) ?? {};
      g[m[2]] = v;
      groups.set(m[1], g);
    } else {
      out[key] = localize(v, lang);
    }
  }
  for (const [base, g] of groups) {
    if (!(base in out)) out[base] = g[lang] ?? g.en ?? g.th ?? g.ms ?? null;
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Removes keys whose value is null, undefined, '' or an empty array (keeps 0 and false). */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/** "20261012" → "2026-10-12" (other strings are returned unchanged). */
export function isoDate(serviceDate: unknown): string | null {
  if (typeof serviceDate !== 'string') return null;
  return /^\d{8}$/.test(serviceDate) ? `${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}` : serviceDate;
}

/** Date and time "now" in Bangkok: { date: "2026-10-12", time: "14:05", minutes: 845 }. */
export function bangkokNow(nowMs: number = Date.now()): { date: string; time: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hh = get('hour'), mm = get('minute');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hh}:${mm}`, minutes: Number(hh) * 60 + Number(mm) };
}

/** Clock time "HH:MM" in Bangkok for an epoch time in milliseconds. */
export function bangkokClock(ms: number): string {
  return bangkokNow(ms).time;
}

/** Adds `days` to a YYYY-MM-DD date. */
export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Turns a user-friendly departure time into an ISO timestamp the planner understands.
 *   "14:30"                      → today at 14:30 Thailand time (tomorrow if that time has passed)
 *   "2026-10-12T14:30"           → that date/time, Thailand time
 *   "2026-10-12T14:30:00+08:00"  → used as given (any ISO time with Z or an offset)
 * Returns null if the text can't be understood.
 */
export function resolveDepartAt(input: string, nowMs: number = Date.now()): { iso: string; note?: string } | null {
  const s = input.trim();
  const clock = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(s);
  if (clock) {
    const now = bangkokNow(nowMs);
    const hh = clock[1]!.padStart(2, '0'), mm = clock[2]!;
    const wanted = Number(hh) * 60 + Number(mm);
    // A clock time that has already passed today almost always means tomorrow.
    const tomorrow = wanted < now.minutes - 1;
    const date = tomorrow ? addDaysIso(now.date, 1) : now.date;
    return { iso: `${date}T${hh}:${mm}:00+07:00`, note: tomorrow ? `${hh}:${mm} has already passed today in Hat Yai, so this plans for tomorrow (${date}).` : undefined };
  }
  const local = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/.exec(s);
  if (local) {
    const iso = `${local[1]}T${local[2]}${local[3] ?? ':00'}+07:00`;
    return Number.isFinite(Date.parse(iso)) ? { iso } : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s) && Number.isFinite(Date.parse(s))) {
    return { iso: s };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

/**
 * A compact stop. Works for both shapes the API uses:
 *   stop endpoints:  { id, name: { th, en, ms }, lat, lng, routes, aliases, kerbs, … }
 *   journey legs:    { stopId, name, name_en, name_th, name_ms, lat, lng, … }
 * When the answer isn't in Thai, the Thai name is added too (handy to show a driver).
 */
export function compactStop(
  s: Record<string, unknown> | null | undefined,
  lang: Lang,
  opts: { coords?: boolean; routes?: boolean; aliases?: number; distance?: boolean; verified?: boolean } = {},
): Record<string, unknown> | null {
  if (!s) return null;
  const { coords = true, routes = true, aliases = 0, distance = true, verified = true } = opts;
  const id = (s.id ?? s.stopId) as string | undefined;
  // name_th / name_en / name_ms (journey legs) first, then a { th, en, ms } name object (stop endpoints)
  const byLang = (l: Lang): string | null => {
    const flat = s[`name_${l}`];
    if (typeof flat === 'string' && flat) return flat;
    return isTrilingual(s.name) ? pickLang(s.name, l) : null;
  };
  const name = byLang(lang) ?? (typeof s.name === 'string' ? s.name : null);
  const nameTh = byLang('th');
  const aliasList = Array.isArray(s.aliases) && aliases > 0 ? (s.aliases as string[]).slice(0, aliases) : undefined;
  return compact({
    id,
    name,
    nameTh: lang !== 'th' && nameTh && nameTh !== name ? nameTh : undefined,
    lat: coords ? s.lat : undefined,
    lng: coords ? s.lng : undefined,
    distanceM: distance ? s.distanceM : undefined,
    routes: routes && Array.isArray(s.routes) ? s.routes : undefined,
    country: s.country && s.country !== 'TH' ? s.country : undefined,
    aliases: aliasList,
    locationVerified: verified && s.verified === false ? false : undefined,
  });
}

/** The EV City Loop fare period without internal fields: { from, to, adult, concession, isFreeTrial, next }. */
export function farePeriodSummary(fp: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(fp)) return undefined;
  return compact({ from: fp.from, to: fp.to, adultThb: fp.adult, concessionThb: fp.concession, isFreeTrial: fp.isFreeTrial, next: fp.next });
}

// ---------------------------------------------------------------------------
// Notes that depend on which routes appear in an answer
// ---------------------------------------------------------------------------

/** Picks the caveats that apply to a set of route IDs (always includes the time zone). */
export function notesForRoutes(routeIds: Iterable<string>, extra: string[] = []): string[] {
  const ids = new Set(routeIds);
  const notes: string[] = [NOTES.timezone];
  if (ids.has('HY3')) notes.push(NOTES.evEstimated);
  if (ids.has('HY8299')) notes.push(NOTES.minibusHoursOnly);
  if (ids.has('SRT_741')) notes.push(NOTES.srtShuttle);
  if (ids.has('KTM_MYSAWASDEE')) notes.push(NOTES.mySawasdee);
  return [...notes, ...extra];
}

// ---------------------------------------------------------------------------
// Encoded polylines (Google's algorithm, precision 5) — only used to summarise route lines
// ---------------------------------------------------------------------------

/** Decodes an encoded polyline into [lat, lng] pairs. */
export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0, shift = 0, byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta; else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/** Rough length of a line in km (haversine, summed point to point). */
export function lineLengthKm(points: Array<[number, number]>): number {
  const R = 6371;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [la1, lo1] = points[i - 1]!, [la2, lo2] = points[i]!;
    const dLat = ((la2 - la1) * Math.PI) / 180, dLng = ((lo2 - lo1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    total += 2 * R * Math.asin(Math.sqrt(a));
  }
  return Math.round(total * 100) / 100;
}
