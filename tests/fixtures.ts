/**
 * Small API responses for the tests, trimmed from real answers of the Hat Yai Transit API
 * (captured from a local copy of the API on 10 Oct 2026).
 */

export const CENTRAL_STOP = {
  id: 'HY3_19',
  name: { th: 'เซ็นทรัลหาดใหญ่', en: 'Central Hat Yai', ms: 'Central Hat Yai' },
  lat: 6.991169,
  lng: 100.484619,
  kerbs: [{ routeId: 'HY3', directionId: 0, lat: 6.991169, lng: 100.484619 }],
  country: 'TH',
  routes: ['HY3', 'HY8299'],
  aliases: ['เซ็นทรัลเฟสติวัล', 'CentralFestival Hatyai', 'Central Festival', 'Central'],
  verified: false,
};

const EV_ROUTE = { id: 'HY3', shortName: '3', name: { th: 'รอบเมืองหาดใหญ่', en: 'Hat Yai City Loop', ms: 'Pusingan Bandar Hat Yai' }, color: '#12939A', kind: 'bus' };
const MINIBUS_ROUTE = {
  id: 'HY8299', shortName: '8299',
  name: { th: 'สนามบินหาดใหญ่ – สถานีขนส่งหาดใหญ่', en: 'Hat Yai Airport – Hat Yai Bus Terminal', ms: 'Lapangan Terbang Hat Yai – Terminal Bas Hat Yai' },
  color: '#B8860B', kind: 'bus',
};

export const STOP_DEPARTURES = {
  stopId: 'HY3_19',
  timezone: 'Asia/Bangkok',
  departures: [
    {
      routeId: 'HY3', route: EV_ROUTE, directionId: 1, directionKey: 'loop-right',
      directionName: { th: 'วนขวา', en: 'Loop Right', ms: 'Pusingan Kanan' },
      headsign: 'วนขวา', headsignName: null, continuesTo: null, tripId: 'HY3_R@25200', trainNo: null,
      time: '07:37', secOfDay: 27464, serviceDate: '20261012', epochMs: 1791767864000, minutesUntil: 97,
      status: 'estimated', headwayMin: 20, isTomorrow: false,
    },
  ],
  hoursOnly: [
    {
      routeId: 'HY8299', route: MINIBUS_ROUTE, directionId: 0, directionKey: 'to-city',
      directionName: { th: 'สนามบิน → ตัวเมือง/บขส.', en: 'Airport → City / Bus Terminal', ms: 'Lapangan Terbang → Bandar / Terminal Bas' },
      status: 'hours-only', operatingHours: { from: '08:00', to: '17:00' }, approxHeadwayMin: 120,
    },
  ],
};

export const SRT_ROUTE_DEPARTURES = {
  routeId: 'SRT_741',
  serviceDate: '20261012',
  timezone: 'Asia/Bangkok',
  directions: {
    '0': [
      { time: '05:30', secOfDay: 19800, epochMs: 1, minutesUntil: -30, status: 'scheduled', headwayMin: null, tripId: 'X', trainNumber: '999' },
      { time: '08:55', secOfDay: 32100, epochMs: 2, minutesUntil: 175, status: 'scheduled', headwayMin: null, tripId: '741', trainNumber: '741' },
      { time: '14:00', secOfDay: 50400, epochMs: 3, minutesUntil: 480, status: 'scheduled', headwayMin: null, tripId: '743', trainNumber: '743' },
    ],
    '1': [{ time: '05:00', secOfDay: 18000, epochMs: 4, minutesUntil: -60, status: 'scheduled', headwayMin: null, tripId: '742', trainNumber: '742' }],
  },
  origins: { '0': { th: 'ชุมทางหาดใหญ่', en: 'Hat Yai Junction', ms: 'Hat Yai Junction' }, '1': { th: 'ปาดังเบซาร์', en: 'Padang Besar (Malaysia)', ms: 'Padang Besar' } },
  hoursOnly: [],
  runsToday: true,
};

const legStop = (stopId: string, en: string, th: string) => ({ stopId, name: en, name_en: en, name_th: th, name_ms: en, lat: 7, lng: 100.4, country: 'TH', verified: true });

/** A planner answer with one bus + walk + train option and one walk-only option. */
export const PLAN_RESULT = {
  origin: { lat: 7.037775, lng: 100.466405, text: 'Big C Supercenter (Khlong Hae)', name: 'Big C Supercenter (Khlong Hae)', stopId: 'HY3_10', cls: 'HY', placeId: 'stop:HY3_10' },
  destination: { lat: 6.668835, lng: 100.324497, text: 'Padang Besar (Thailand)', name: 'Padang Besar (Thailand)', stopId: 'SRT_PADANG_BESAR_THAI', cls: 'COR' },
  journeyType: 'same-area', areaId: 'hatyai', timezone: 'Asia/Bangkok', serviceDate: '20261012', isTomorrow: false,
  timestamp: '2026-10-11T23:00:00.000Z',
  farePeriod: { from: '2026-10-10', to: '2026-11-12', adult: 0, concession: 0, noteKey: 'evFreeTrial', isFreeTrial: true, next: { from: '2026-11-13', adult: 15 } },
  journeys: [
    {
      id: 'j1',
      warnings: [],
      usesAirportBoundMinibus: false,
      summary: {
        totalDuration: 116, transfers: 1, totalWalkingDistance: 1150, totalTransitDistance: 50416,
        fareEstimate: { adult: 50, concession: null, currency: 'THB', hasMissingFare: false, hasRange: false, adultMyr: 6.09 },
        departureTime: '07:37', arrivalTime: '09:34', leaveByEpochMs: 1, arriveByEpochMs: 2, isTomorrow: false,
      },
      legs: [
        {
          type: 'transit', mode: 'bus', route: { id: 'HY3', shortName: '3', longName: 'Hat Yai City Loop', name: EV_ROUTE.name, color: '12939A' },
          from: legStop('HY3_10', 'Big C Supercenter (Khlong Hae)', 'บิ๊กซี ซูเปอร์เซ็นเตอร์'),
          to: legStop('HY3_17', 'Si Phuwanat Garden', 'สวนหย่อมศรีภูวนารถ'),
          stops: [legStop('HY3_10', 'Big C Supercenter (Khlong Hae)', 'บิ๊กซี'), legStop('HY3_11', 'Rong Pun', 'โรงปูน')],
          numStops: 7, duration: 16, distance: 7078, departureTime: '07:38', arrivalTime: '07:54',
          departureEpochMs: Date.parse('2026-10-12T07:38:00+07:00'), arrivalEpochMs: 0, timeStatus: 'estimated', headwayMin: 20,
          directionName: { th: 'วนซ้าย', en: 'Loop Left', ms: 'Pusingan Kiri' },
          tripId: 'HY3_L@26400', trainNo: null,
          fare: { adult: 0, concession: 0, currency: 'THB', note: { en: 'Free trial until 12 Nov 2026 (then 15 THB flat).', th: 'ทดลองนั่งฟรี', ms: 'Percubaan percuma' }, noteKey: 'evFreeTrial' },
          tickets: null,
          tracking: { provider: 'viabus', label: { en: 'Track live in ViaBus', th: 'ติดตามใน ViaBus', ms: 'Jejak dalam ViaBus' }, web: 'https://www.viabus.co/' },
          contact: { phone: '074-244443' },
          warnings: [{ key: 'evEstimated', text: { en: 'Times at other stops are estimates.', th: 'เวลาเป็นค่าประมาณ', ms: 'Masa anggaran' } }],
          nextDepartures: [
            { time: '07:20', epochMs: Date.parse('2026-10-12T07:20:00+07:00'), status: 'estimated', trainNo: null },
            { time: '07:58', epochMs: Date.parse('2026-10-12T07:58:00+07:00'), status: 'estimated', trainNo: null },
          ],
          polyline: 'encoded-bus-line',
          lineSource: 'google-driving',
        },
        { type: 'walking', distance: 1150, duration: 16, polyline: 'encoded-walk', from: legStop('HY3_17', 'Si Phuwanat Garden', 'สวนหย่อมศรีภูวนารถ'), to: legStop('SRT_HAT_YAI', 'Hat Yai Junction', 'ชุมทางหาดใหญ่'), source: 'osrm-osm-foot' },
        {
          type: 'transit', mode: 'rail', route: { id: 'SRT_741', shortName: '741', name: { en: 'Hat Yai Junction – Padang Besar (shuttle)', th: 'ชุมทางหาดใหญ่ – ปาดังเบซาร์', ms: 'Hat Yai Junction – Padang Besar' } },
          from: legStop('SRT_HAT_YAI', 'Hat Yai Junction', 'ชุมทางหาดใหญ่'),
          to: legStop('SRT_PADANG_BESAR_THAI', 'Padang Besar (Thailand)', 'ปาดังเบซาร์'),
          numStops: 2, duration: 39, departureTime: '08:55', arrivalTime: '09:34', departureEpochMs: Date.parse('2026-10-12T08:55:00+07:00'),
          timeStatus: 'scheduled', tripId: '741', trainNo: '741',
          fare: { adult: 50, concession: null, currency: 'THB', note: { en: '50 THB, 3rd class.', th: '50 บาท', ms: '50 THB' } },
          tickets: { channel: 'counter-2h', label: { en: 'Buy at the station counter from 2 h before departure', th: 'ซื้อที่ช่องขายตั๋ว', ms: 'Beli di kaunter' }, note: { en: 'Cash 50 THB.', th: '50 บาท', ms: 'Tunai 50 THB.' } },
          tracking: { provider: 'srt-tts', label: { en: 'Track live on SRT TTS-TrainView', th: 'TTS', ms: 'TTS' }, url: 'https://ttsview.railway.co.th/searchresult_2023.php?trainno=741' },
          warnings: [],
          nextDepartures: [{ time: '14:00', epochMs: Date.parse('2026-10-12T14:00:00+07:00'), status: 'scheduled', trainNo: '743' }],
          polyline: 'encoded-rail-line',
        },
      ],
    },
    {
      id: 'walk',
      walkOnly: true,
      warnings: [],
      summary: {
        totalDuration: 10, transfers: 0, totalWalkingDistance: 718,
        fareEstimate: { adult: 0, concession: 0, currency: 'THB', adultMyr: 0 },
        // The real API times this option from "now" (here 12:37) and leaves out arrivalTime.
        departureTime: '12:37', leaveByEpochMs: Date.parse('2026-10-10T12:37:00+07:00'),
      },
      legs: [{ type: 'walking', distance: 718, duration: 10, polyline: 'x', from: legStop('HY3_19', 'Central Hat Yai', 'เซ็นทรัลหาดใหญ่'), to: legStop('HY3_20', 'Hat Yai Bus Terminal', 'สถานีขนส่งหาดใหญ่') }],
    },
  ],
};

export const HANDOFF_RESULT = {
  error: 'handoff-required',
  message: 'Part of this trip is in Malaysia. Plan it in our sister app Malaysia Transit, with your places already filled in.',
  handoff: {
    action: 'handoff',
    target: 'mt',
    url: 'https://malaysiatransit.techmavie.digital/journey-planner.html?from=Central+Hat+Yai&to=George+Town&src=hatyaitransit',
    message: { en: 'Part of this trip is in Malaysia.', th: 'การเดินทางนี้บางส่วนอยู่ในมาเลเซีย', ms: 'Sebahagian perjalanan ini di Malaysia.' },
  },
  origin: { stopId: 'HY3_19', name: 'Central Hat Yai', lat: 6.991169, lng: 100.484619, cls: 'HY' },
  destination: { lat: 5.4141, lng: 100.3288, text: 'George Town', name: 'George Town', cls: 'MY' },
};

/** Two-point encoded polyline: (38.5, -120.2) → (40.7, -120.95), from Google's documentation. */
export const SAMPLE_POLYLINE = '_p~iF~ps|U_ulLnnqC';
