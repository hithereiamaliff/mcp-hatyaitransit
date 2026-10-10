/**
 * Formatting helpers (src/format.ts): language picking, stop compaction, departure times,
 * polyline decoding.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { compactStop, decodePolyline, localize, notesForRoutes, NOTES, pickLang, resolveDepartAt } from '../src/format.js';
import { CENTRAL_STOP, SAMPLE_POLYLINE } from './fixtures.js';
import { MONDAY_6AM } from './helpers.js';

describe('localize / pickLang', () => {
  test('replaces { th, en, ms } objects with one language, deeply', () => {
    const input = { name: { th: 'วนซ้าย', en: 'Loop Left', ms: 'Pusingan Kiri' }, list: [{ note: { en: 'Hi', th: 'สวัสดี' } }], n: 3 };
    assert.deepEqual(localize(input, 'th'), { name: 'วนซ้าย', list: [{ note: 'สวัสดี' }], n: 3 });
    assert.deepEqual(localize(input, 'ms'), { name: 'Pusingan Kiri', list: [{ note: 'Hi' }], n: 3 }, 'falls back to English');
  });

  test('collapses note_en / note_th / note_ms into one field', () => {
    const input = { channel: 'counter-2h', note_en: 'Counter only', note_th: 'ช่องขายตั๋ว', note_ms: 'Kaunter sahaja' };
    assert.deepEqual(localize(input, 'ms'), { channel: 'counter-2h', note: 'Kaunter sahaja' });
  });

  test('objects that only look a bit like translations are left alone', () => {
    assert.deepEqual(localize({ en: 1, th: 2 }, 'en'), { en: 1, th: 2 });
    assert.equal(pickLang('plain', 'th'), 'plain');
    assert.equal(pickLang(null, 'th'), null);
  });
});

describe('compactStop', () => {
  test('stop endpoint shape: one name plus the Thai name, no map-only fields', () => {
    const s = compactStop(CENTRAL_STOP, 'en', { aliases: 2 });
    assert.deepEqual(s, {
      id: 'HY3_19', name: 'Central Hat Yai', nameTh: 'เซ็นทรัลหาดใหญ่', lat: 6.991169, lng: 100.484619,
      routes: ['HY3', 'HY8299'], aliases: ['เซ็นทรัลเฟสติวัล', 'CentralFestival Hatyai'], locationVerified: false,
    });
    assert.equal(compactStop(CENTRAL_STOP, 'th')?.nameTh, undefined, 'no separate Thai name when answering in Thai');
  });

  test('journey-leg shape (name_th etc.)', () => {
    const leg = { stopId: 'SRT_HAT_YAI', name: 'Hat Yai Junction', name_en: 'Hat Yai Junction', name_th: 'ชุมทางหาดใหญ่', name_ms: 'Hat Yai Junction', lat: 7, lng: 100, verified: false };
    assert.deepEqual(compactStop(leg, 'en', { coords: false, verified: false }), { id: 'SRT_HAT_YAI', name: 'Hat Yai Junction', nameTh: 'ชุมทางหาดใหญ่' });
  });
});

describe('resolveDepartAt (Thailand time)', () => {
  test('"HH:MM" later today stays today', () => {
    assert.deepEqual(resolveDepartAt('07:30', MONDAY_6AM), { iso: '2026-10-12T07:30:00+07:00', note: undefined });
  });

  test('"HH:MM" that has passed means tomorrow, with a note', () => {
    const r = resolveDepartAt('5:00', MONDAY_6AM);
    assert.equal(r?.iso, '2026-10-13T05:00:00+07:00');
    assert.match(r?.note ?? '', /tomorrow/);
  });

  test('a local date-time gets +07:00; full ISO times are used as given', () => {
    assert.equal(resolveDepartAt('2026-10-20T13:00', MONDAY_6AM)?.iso, '2026-10-20T13:00:00+07:00');
    assert.equal(resolveDepartAt('2026-10-20 13:00:15', MONDAY_6AM)?.iso, '2026-10-20T13:00:15+07:00');
    assert.equal(resolveDepartAt('2026-10-20T06:00:00Z', MONDAY_6AM)?.iso, '2026-10-20T06:00:00Z');
    assert.equal(resolveDepartAt('2026-10-20T13:00:00+08:00', MONDAY_6AM)?.iso, '2026-10-20T13:00:00+08:00');
  });

  test('nonsense is refused', () => {
    for (const bad of ['tomorrow', '25:00', '2026-13-45T10:00', '7pm', '']) assert.equal(resolveDepartAt(bad, MONDAY_6AM), null, bad);
  });
});

describe('misc', () => {
  test('decodePolyline (Google sample)', () => {
    assert.deepEqual(decodePolyline(SAMPLE_POLYLINE), [[38.5, -120.2], [40.7, -120.95]]);
  });

  test('notesForRoutes picks the caveats for the routes present', () => {
    const notes = notesForRoutes(['HY3', 'HY8299']);
    assert.ok(notes.includes(NOTES.timezone) && notes.includes(NOTES.evEstimated) && notes.includes(NOTES.minibusHoursOnly));
    assert.ok(!notes.includes(NOTES.srtShuttle));
  });
});
