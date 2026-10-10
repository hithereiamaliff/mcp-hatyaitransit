/**
 * Tools (src/tools.ts) through a real MCP client/server pair, with the API faked.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { CENTRAL_STOP, HANDOFF_RESULT, PLAN_RESULT, SAMPLE_POLYLINE, SRT_ROUTE_DEPARTURES, STOP_DEPARTURES } from './fixtures.js';
import { TEST_KEY, callTool, connect, fakeApi, type Handler } from './helpers.js';

const EXPECTED_TOOLS = [
  'get_service_info', 'list_routes', 'get_route', 'get_route_departures', 'search_stops', 'get_stop', 'find_nearby_stops',
  'get_stop_departures', 'get_fares', 'plan_journey', 'search_places', 'list_gtfs_feeds', 'get_sources', 'get_route_geometry',
];

/** Runs `fn` with a connected client, always closing it afterwards. */
async function withClient(routes: Record<string, Handler>, opts: { apiKey?: string }, fn: (ctx: Awaited<ReturnType<typeof connect>> & ReturnType<typeof fakeApi>) => Promise<void>) {
  const fake = fakeApi(routes, opts);
  const conn = await connect(fake.api);
  try {
    await fn({ ...conn, ...fake });
  } finally {
    await conn.close();
  }
}

describe('tool list', () => {
  test('all tools are registered, read-only, with descriptions and input schemas', async () => {
    await withClient({}, {}, async ({ client }) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
      for (const t of tools) {
        assert.ok((t.description ?? '').length > 60, `${t.name} needs a useful description`);
        assert.equal(t.annotations?.readOnlyHint, true, `${t.name} should be read-only`);
        assert.equal(t.inputSchema.type, 'object');
      }
      const plan = tools.find((t) => t.name === 'plan_journey')!;
      assert.ok(plan.inputSchema.properties?.originStopId && plan.inputSchema.properties?.destinationText && plan.inputSchema.properties?.departAt);
    });
  });
});

describe('stops and departures', () => {
  test('get_stop_departures: trimmed fields, chosen language, minibus hours, notes', async () => {
    const routes: Record<string, Handler> = {
      'GET /api/stops/HY3_19/departures': () => ({ body: STOP_DEPARTURES }),
      'GET /api/stops/HY3_19': () => ({ body: { stop: CENTRAL_STOP } }),
    };
    await withClient(routes, {}, async ({ client, calls }) => {
      const { isError, data } = await callTool(client, 'get_stop_departures', { stopId: 'HY3_19', count: 5, routeId: 'HY3', language: 'th' });
      assert.equal(isError, false);
      const depCall = calls.find((c) => c.url.pathname.endsWith('/departures'))!;
      assert.equal(depCall.url.searchParams.get('count'), '5');
      assert.equal(depCall.url.searchParams.get('routeId'), 'HY3');

      assert.deepEqual(data.departures[0], { time: '07:37', inMin: 97, routeId: 'HY3', route: 'รอบเมืองหาดใหญ่', direction: 'วนขวา', status: 'estimated', everyMin: 20 });
      assert.equal(data.hoursOnly[0].status, 'hours-only');
      assert.deepEqual(data.hoursOnly[0].operatingHours, { from: '08:00', to: '17:00' });
      assert.equal(data.stop.name, 'เซ็นทรัลหาดใหญ่');
      assert.ok(data.notes.some((n: string) => /estimates/.test(n)), 'EV estimate note');
      assert.ok(data.notes.some((n: string) => /no timetable/.test(n)), 'minibus hours-only note');
      assert.ok(!JSON.stringify(data).includes('epochMs'), 'internal fields removed');
    });
  });

  test('get_route_departures hides departed services unless includePast is set', async () => {
    const routes = { 'GET /api/routes/SRT_741/departures': () => ({ body: SRT_ROUTE_DEPARTURES }) };
    await withClient(routes, {}, async ({ client }) => {
      const upcoming = (await callTool(client, 'get_route_departures', { routeId: 'SRT_741' })).data;
      // Directions are named after where they go, with the numeric ID the other tools use
      const dir0 = upcoming.directions.find((d: any) => d.directionId === 0);
      assert.equal(dir0.direction, 'To Padang Besar (Malaysia)');
      assert.deepEqual(dir0.departures.map((d: any) => d.trainNo), ['741', '743']);
      assert.equal(dir0.boardingStop, 'Hat Yai Junction');
      assert.equal(upcoming.serviceDate, '2026-10-12');
      assert.ok(upcoming.notes.some((n: string) => /No more departures today for To Hat Yai Junction/.test(n)));
      assert.ok(!upcoming.notes.some((n: string) => /No more [01] /.test(n)), 'never a raw direction ID in the text');
      assert.ok(upcoming.notes.some((n: string) => /counter/.test(n)), 'SRT ticket note');

      const all = (await callTool(client, 'get_route_departures', { routeId: 'SRT_741', includePast: true, limit: 2 })).data;
      assert.deepEqual(all.directions.find((d: any) => d.directionId === 0).departures.map((d: any) => d.trainNo), ['999', '741']);
    });
  });

  test('path parameters are URL-encoded and 404s explain what to do', async () => {
    await withClient({}, {}, async ({ client, calls }) => {
      const { isError, data } = await callTool(client, 'get_stop', { stopId: 'HY3/19?x' });
      assert.equal(isError, true);
      assert.equal(calls[0]!.url.pathname, '/api/stops/HY3%2F19%3Fx');
      assert.equal(data.httpStatus, 404);
      assert.equal(data.error, 'not-found');
      assert.match(data.message, /search_stops/);
    });
  });

  test('search_stops sends q and adds Thai names', async () => {
    const routes = { 'GET /api/stops/search': () => ({ body: { stops: [CENTRAL_STOP] } }) };
    await withClient(routes, {}, async ({ client, calls }) => {
      const { data } = await callTool(client, 'search_stops', { query: 'central' });
      assert.equal(calls[0]!.url.searchParams.get('q'), 'central');
      assert.equal(data.stops[0].nameTh, 'เซ็นทรัลหาดใหญ่');
      assert.equal(data.stops[0].kerbs, undefined);
    });
  });

  test('rate limits come back as isError with retryAfterSec', async () => {
    const routes = { 'GET /api/routes': () => ({ status: 429, body: { error: 'rate-limited', message: 'Too many API requests. Try again in 30s.' }, headers: { 'Retry-After': '30' } }) };
    await withClient(routes, {}, async ({ client }) => {
      const { isError, data } = await callTool(client, 'list_routes');
      assert.equal(isError, true);
      assert.equal(data.httpStatus, 429);
      assert.equal(data.retryAfterSec, 30);
    });
  });

  test('invalid input is rejected before any API call', async () => {
    await withClient({}, {}, async ({ client, calls }) => {
      const { isError } = await callTool(client, 'get_fares', { date: '13/11/2026' });
      assert.equal(isError, true);
      assert.equal(calls.length, 0);
    });
  });
});

describe('plan_journey', () => {
  test('without HYT_API_KEY it explains how to enable the planner and makes no API call', async () => {
    await withClient({}, { apiKey: '' }, async ({ client, calls }) => {
      const { isError, data } = await callTool(client, 'plan_journey', { originStopId: 'HY3_10', destinationStopId: 'HY3_19' });
      assert.equal(isError, true);
      assert.equal(data.error, 'api-key-required');
      assert.match(data.message, /HYT_API_KEY/);
      assert.match(data.message, /developers\.html/);
      assert.equal(calls.length, 0);
    });
  });

  test('stop IDs + departAt: sends the right body and returns compact journeys', async () => {
    const routes = { 'POST /api/journey/plan': () => ({ body: PLAN_RESULT }) };
    await withClient(routes, { apiKey: TEST_KEY }, async ({ client, calls }) => {
      const { isError, data } = await callTool(client, 'plan_journey', {
        originStopId: 'HY3_10', destinationStopId: 'SRT_PADANG_BESAR_THAI', departAt: '07:00', includeRail: true,
      });
      assert.equal(isError, false);
      const sent = calls[0]!;
      assert.equal(sent.headers['x-api-key'], TEST_KEY);
      assert.deepEqual(sent.body, {
        origin: { stopId: 'HY3_10' },
        destination: { stopId: 'SRT_PADANG_BESAR_THAI' },
        options: { language: 'en', modes: { bus: true, rail: true }, departAt: '2026-10-12T07:00:00+07:00' },
      });

      assert.equal(data.status, 'ok');
      assert.equal(data.journeys.length, 2);
      const [j1, walk] = data.journeys;
      assert.equal(j1.leaveAt, '07:37');
      assert.deepEqual(j1.fare, { adultThb: 50, adultMyr: 6.09 });
      assert.deepEqual(j1.legs.map((l: any) => l.mode), ['bus', 'walk', 'rail']);
      const [bus, , train] = j1.legs;
      assert.equal(bus.direction, 'Loop Left');
      assert.deepEqual(bus.from, { id: 'HY3_10', name: 'Big C Supercenter (Khlong Hae)', nameTh: 'บิ๊กซี ซูเปอร์เซ็นเตอร์' });
      assert.deepEqual(bus.laterDepartures, [{ time: '07:58' }], 'only departures after this leg');
      assert.equal(bus.polyline, undefined, 'polylines dropped by default');
      assert.equal(bus.stops, undefined);
      assert.equal(train.trainNo, '741');
      assert.equal(train.tickets.how, 'Buy at the station counter from 2 h before departure');
      assert.equal(train.tracking.url, 'https://ttsview.railway.co.th/searchresult_2023.php?trainno=741');

      // Walk-only option is re-timed from departAt (the API times it from "now")
      assert.equal(walk.walkOnly, true);
      assert.equal(walk.leaveAt, '07:00');
      assert.equal(walk.arriveAt, '07:10');

      assert.ok(data.notes.some((n: string) => /estimates/.test(n)) && data.notes.some((n: string) => /counter/.test(n)));
      assert.ok(!JSON.stringify(data).includes('encoded-'), 'no polylines anywhere');
    });
  });

  test('minibus legs show "~" times and the wait; later trains on the next day say so', async () => {
    const stop = (stopId: string, en: string) => ({ stopId, name: en, name_en: en, name_th: en, name_ms: en, lat: 7, lng: 100.4, country: 'TH', verified: true });
    const plan = {
      ...PLAN_RESULT,
      journeys: [{
        id: 'x', walkOnly: false, warnings: [], usesAirportBoundMinibus: false,
        summary: { departureTime: '09:01', arrivalTime: '10:42', totalDuration: 101, transfers: 1, totalWalkingDistance: 0, fareEstimate: { adult: 80 } },
        legs: [
          {
            type: 'transit', mode: 'bus', route: { id: 'HY8299', shortName: '8299', name: { en: 'Airport Minibus' } }, from: stop('HY8299_01', 'Airport'), to: stop('HY8299_04A', 'Clock Tower'),
            departureTime: '10:01', arrivalTime: '10:37', departureEpochMs: Date.parse('2026-10-12T10:01:00+07:00'), timeStatus: 'hours-only', headwayMin: 120,
            waitMin: 60, waitNote: { en: 'Wait at the stop: there is no timetable…', th: 'รอที่ป้าย: ไม่มีตารางเวลา…', ms: 'Tunggu di hentian: tiada jadual…' }, nextDepartures: [], warnings: [],
          },
          {
            type: 'transit', mode: 'rail', route: { id: 'SRT_741', shortName: '743' }, trainNo: '743', from: stop('SRT_HAT_YAI', 'Hat Yai Junction'), to: stop('SRT_PADANG_BESAR', 'Padang Besar'),
            departureTime: '14:00', arrivalTime: '14:45', departureEpochMs: Date.parse('2026-10-12T14:00:00+07:00'), timeStatus: 'scheduled', waitMin: 0,
            nextDepartures: [{ time: '08:55', epochMs: Date.parse('2026-10-13T08:55:00+07:00'), status: 'scheduled', trainNo: '741', nextDay: true }], warnings: [],
          },
        ],
      }],
    };
    const routes = { 'POST /api/journey/plan': () => ({ body: plan }) };
    await withClient(routes, { apiKey: TEST_KEY }, async ({ client }) => {
      const { data } = await callTool(client, 'plan_journey', { originStopId: 'HY8299_01', destinationStopId: 'SRT_PADANG_BESAR' });
      const [bus, train] = data.journeys[0].legs;
      assert.equal(bus.departureTime, '~10:01', 'no timetable: approximate');
      assert.equal(bus.arrivalTime, '~10:37');
      assert.equal(bus.waitMin, 60, 'the wait is visible');
      assert.match(bus.waitNote, /no timetable/);
      assert.equal(train.departureTime, '14:00', 'timetabled times stay as they are');
      assert.equal(train.waitMin, undefined, 'no wait, no field');
      assert.deepEqual(train.laterDepartures, [{ time: '08:55', nextDay: true, trainNo: '741' }]);
    });
  });

  test('includePolylines and includeStops add the detail back', async () => {
    const routes = { 'POST /api/journey/plan': () => ({ body: PLAN_RESULT }) };
    await withClient(routes, { apiKey: TEST_KEY }, async ({ client }) => {
      const { data } = await callTool(client, 'plan_journey', { originStopId: 'HY3_10', destinationStopId: 'SRT_PADANG_BESAR_THAI', includePolylines: true, includeStops: true });
      const bus = data.journeys[0].legs[0];
      assert.equal(bus.polyline, 'encoded-bus-line');
      assert.equal(bus.stops.length, 2);
    });
  });

  test('place names go through place search: a stop match becomes a stopId', async () => {
    const routes: Record<string, Handler> = {
      'GET /api/journey/places/autocomplete': (c) => ({
        body: c.url.searchParams.get('input') === 'HDY'
          ? { predictions: [{ placeId: 'stop:HY8299_01', description: 'Hat Yai International Airport (HDY)', source: 'local' }] }
          : { predictions: [{ placeId: 'ChIJlee', description: 'Lee Gardens Plaza Hotel, Hat Yai', source: 'google' }, { placeId: 'ChIJother', description: 'Lee Gardens Inn' }] },
      }),
      'GET /api/journey/places/details': (c) => ({ body: { place: { placeId: c.url.searchParams.get('placeId'), name: 'Lee Gardens Plaza Hotel', lat: 7.0055, lng: 100.4701, addressComponents: [{ short_name: 'TH', types: ['country'] }] } } }),
      'POST /api/journey/plan': () => ({ body: PLAN_RESULT }),
    };
    await withClient(routes, { apiKey: TEST_KEY }, async ({ client, calls }) => {
      const { isError, data } = await callTool(client, 'plan_journey', { originText: 'HDY', destinationText: 'Lee Gardens Plaza', language: 'th' });
      assert.equal(isError, false);
      const plan = calls.find((c) => c.method === 'POST')!;
      const body = plan.body as any;
      assert.equal(body.origin.stopId, 'HY8299_01');
      assert.equal(body.destination.lat, 7.0055);
      assert.equal(body.destination.lng, 100.4701);
      assert.equal(body.destination.text, 'Lee Gardens Plaza Hotel');
      assert.equal(body.options.language, 'th');
      const auto = calls.filter((c) => c.url.pathname === '/api/journey/places/autocomplete');
      assert.equal(auto[0]!.url.searchParams.get('language'), 'th');
      assert.match(data.destination.readAs, /Lee Gardens Plaza Hotel, Hat Yai/);
      assert.deepEqual(data.destination.otherMatches, [{ placeId: 'ChIJother', name: 'Lee Gardens Inn' }]);
    });
  });

  test('if place search is refused (403), the planner resolves the text itself', async () => {
    const routes: Record<string, Handler> = {
      'GET /api/journey/places/autocomplete': () => ({ status: 403, body: { error: 'app-only', message: 'Place search is only for the app.' } }),
      'POST /api/journey/plan': () => ({ body: PLAN_RESULT }),
    };
    await withClient(routes, { apiKey: TEST_KEY }, async ({ client, calls }) => {
      const { isError } = await callTool(client, 'plan_journey', { originText: 'Hat Yai Junction', destinationStopId: 'HY3_19' });
      assert.equal(isError, false);
      assert.deepEqual((calls.find((c) => c.method === 'POST')!.body as any).origin, { text: 'Hat Yai Junction' });
    });
  });

  test('trips into Malaysia return a hand-off link (not an error)', async () => {
    const routes = { 'POST /api/journey/plan': () => ({ body: HANDOFF_RESULT }) };
    await withClient(routes, { apiKey: TEST_KEY }, async ({ client }) => {
      const { isError, data } = await callTool(client, 'plan_journey', { originStopId: 'HY3_19', destinationLat: 5.4141, destinationLng: 100.3288, destinationText: 'George Town' });
      assert.equal(isError, false);
      assert.equal(data.status, 'handoff');
      assert.equal(data.sisterApp, 'Malaysia Transit');
      assert.match(data.handoffUrl, /^https:\/\/malaysiatransit\.techmavie\.digital\//);
      assert.equal(data.destination.name, 'George Town');
    });
  });

  test('an invalid key and a bad departAt are clear errors', async () => {
    const routes = { 'POST /api/journey/plan': () => ({ status: 401, body: { error: 'invalid-api-key', message: 'This API key is not valid or has been revoked.' } }) };
    await withClient(routes, { apiKey: TEST_KEY }, async ({ client }) => {
      const bad = await callTool(client, 'plan_journey', { originStopId: 'HY3_19', destinationStopId: 'HY3_20' });
      assert.equal(bad.isError, true);
      assert.equal(bad.data.error, 'invalid-api-key');
      assert.equal(bad.data.httpStatus, 401);
      assert.match(bad.data.message, /HYT_API_KEY/);

      const time = await callTool(client, 'plan_journey', { originStopId: 'HY3_19', destinationStopId: 'HY3_20', departAt: 'tomorrow morning' });
      assert.equal(time.data.error, 'invalid-departAt');

      const half = await callTool(client, 'plan_journey', { originLat: 7, destinationStopId: 'HY3_20' });
      assert.equal(half.data.error, 'invalid-origin');
    });
  });
});

describe('other tools', () => {
  test('get_route_geometry summarises the line and omits the polyline unless asked', async () => {
    const geometry = { routeId: 'HY3', attribution: 'Route lines © Google', shapes: [{ directionId: 0, directionKey: 'loop-left', polyline: SAMPLE_POLYLINE, stopIds: ['A', 'B'], stopPoints: [[38.5, -120.2], [40.7, -120.95]], source: 'google-driving' }] };
    await withClient({ 'GET /api/routes/HY3/geometry': () => ({ body: geometry }) }, {}, async ({ client }) => {
      const small = (await callTool(client, 'get_route_geometry', { routeId: 'HY3' })).data;
      assert.equal(small.shapes[0].points, 2);
      assert.deepEqual(small.shapes[0].start, [38.5, -120.2]);
      assert.equal(small.shapes[0].polyline, undefined);
      assert.equal(small.attribution, 'Route lines © Google');

      const full = (await callTool(client, 'get_route_geometry', { routeId: 'HY3', includePolyline: true, includeStopPins: true })).data;
      assert.equal(full.shapes[0].polyline, SAMPLE_POLYLINE);
      assert.deepEqual(full.shapes[0].stopPins[1], { id: 'B', lat: 40.7, lng: -120.95 });
    });
  });

  test('get_service_info reports planner availability without revealing the key', async () => {
    const meta = { region: { name: { en: 'Hat Yai', th: 'หาดใหญ่' }, timezone: 'Asia/Bangkok', currency: 'THB' }, today: '2026-10-12', farePeriod: { from: '2026-10-10', adult: 0, noteKey: 'evFreeTrial', isFreeTrial: true }, routes: [], disclaimer: { en: 'Unofficial.', th: 'ไม่เป็นทางการ' } };
    await withClient({ 'GET /api/meta': () => ({ body: meta }) }, { apiKey: TEST_KEY }, async ({ client }) => {
      const { text, data } = await callTool(client, 'get_service_info', { language: 'th' });
      assert.match(data.thisServer.journeyPlanner, /^available/);
      assert.equal(data.region.name, 'หาดใหญ่');
      assert.equal(data.disclaimer, 'ไม่เป็นทางการ');
      assert.equal(data.evFarePeriod.noteKey, undefined);
      assert.ok(!text.includes(TEST_KEY));
    });
  });
});
