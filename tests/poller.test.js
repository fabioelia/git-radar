// The background auto-poll loop, driven with stubbed store/scan/timers — no
// real intervals, no Electron, no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from '../src/main/services/poller.js';

const today = () => new Date('2026-06-13T12:00:00Z');

function storeStub(sprintsByRepo) {
  return {
    listRepos: () => Object.keys(sprintsByRepo).map((id) => ({ id })),
    listSprints: (id) => sprintsByRepo[id] || [],
  };
}

test('liveSprints picks today\'s window per repo, falling back to the latest', () => {
  const store = storeStub({
    r1: [
      { id: 's-old', startDate: '2026-05-01', endDate: '2026-05-21' },
      { id: 's-live', startDate: '2026-06-08', endDate: '2026-06-28' },
    ],
    r2: [{ id: 's-past', startDate: '2026-01-01', endDate: '2026-01-21' }], // none live → latest
    r3: [], // no sprints → skipped
  });
  const poller = createPoller({ store, scan: async () => ({}), now: today });
  assert.deepEqual(poller.liveSprints().map((s) => s.id).sort(), ['s-live', 's-past']);
});

test('pollOnce scans each live sprint and flags whether anything changed', async () => {
  const scanned = [];
  const events = [];
  const store = storeStub({
    r1: [{ id: 's-live', name: 'Sprint 1', startDate: '2026-06-08', endDate: '2026-06-28' }],
  });
  const scan = async (id) => { scanned.push(id); return { added: 2, classified: 1 }; };
  const poller = createPoller({ store, scan, now: today, emit: (e) => events.push(e) });

  const { results } = await poller.pollOnce();
  assert.deepEqual(scanned, ['s-live']);
  assert.equal(results[0].changed, true);
  assert.equal(events[0].task, 'autopoll');
  assert.equal(events[0].changed, true);
  assert.match(events[0].message, /2 new, 1 summarized/);
});

test('pollOnce swallows scan failures per sprint and keeps going', async () => {
  const events = [];
  const store = storeStub({
    r1: [{ id: 'a', name: 'A', startDate: '2026-06-08', endDate: '2026-06-28' }],
    r2: [{ id: 'b', name: 'B', startDate: '2026-06-08', endDate: '2026-06-28' }],
  });
  const scan = async (id) => { if (id === 'a') throw new Error('gh down'); return { added: 0, classified: 0 }; };
  const poller = createPoller({ store, scan, now: today, emit: (e) => events.push(e) });

  const { results } = await poller.pollOnce();
  assert.equal(results.length, 2);
  assert.ok(results.find((r) => r.error === 'gh down'));
  assert.ok(events.some((e) => e.error && /gh down/.test(e.message)));
});

test('pollOnce is reentrancy-guarded', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const store = storeStub({ r1: [{ id: 's', name: 'S', startDate: '2026-06-08', endDate: '2026-06-28' }] });
  const scan = async () => { await gate; return { added: 1, classified: 0 }; };
  const poller = createPoller({ store, scan, now: today });

  const first = poller.pollOnce();
  const second = await poller.pollOnce(); // first is still mid-scan
  assert.equal(second.skipped, 'in-progress');
  release();
  await first;
});

test('apply schedules/clears the interval from settings', () => {
  const scheduled = [];
  const cleared = [];
  let token = 0;
  const poller = createPoller({
    store: storeStub({}),
    scan: async () => ({}),
    now: today,
    schedule: (fn, ms) => { const t = ++token; scheduled.push({ t, ms }); return { t, unref() {} }; },
    unschedule: (t) => cleared.push(t.t),
  });

  assert.equal(poller.apply({ autoPoll: false }), null);
  assert.equal(scheduled.length, 0);

  const mins = poller.apply({ autoPoll: true, autoPollMinutes: 5 });
  assert.equal(mins, 5);
  assert.equal(scheduled[0].ms, 5 * 60000);

  poller.apply({ autoPoll: true, autoPollMinutes: 10 }); // re-apply clears the old timer first
  assert.deepEqual(cleared, [1]);
  poller.stop();
  assert.deepEqual(cleared, [1, 2]);
});
