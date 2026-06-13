import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../src/main/services/stats.js';

const sprint = { startDate: '2026-06-01', endDate: '2026-06-05' };

function pr(number, over = {}) {
  return {
    number,
    title: `PR ${number}`,
    author: 'alice',
    base: 'develop',
    createdAt: '2026-06-01T00:00:00Z',
    mergedAt: '2026-06-02T00:00:00Z', // 24h cycle
    additions: 10,
    deletions: 5,
    ...over,
  };
}

const buckets = [
  { id: 'b1', name: 'Checkout' },
  { id: 'b2', name: 'Release Operations' },
];

const prs = [
  pr(1, { bucketId: 'b1', ann: { workType: 'feature', behindFlag: true, flagName: 'new-checkout', userFacing: true } }),
  pr(2, { bucketId: 'b1', ann: { workType: 'defect', behindFlag: false, userFacing: true }, mergedAt: '2026-06-03T00:00:00Z' }), // 48h defect
  pr(3, { bucketId: 'b1', ann: { workType: 'defect', behindFlag: false, userFacing: true } }), // 24h defect
  pr(4, { bucketId: 'b2', base: 'stage', ann: { workType: 'release', behindFlag: false, userFacing: false }, author: 'bob' }),
  pr(5, {}), // unbucketed, unclassified
];

test('totals and per-bucket aggregation', () => {
  const stats = computeStats({ sprint, prs, buckets });
  assert.equal(stats.totals.prs, 5);
  assert.equal(stats.totals.contributors, 2);
  assert.equal(stats.totals.byBase.develop, 4);
  assert.equal(stats.totals.byBase.stage, 1);
  assert.equal(stats.totals.byType.defect, 2);
  assert.equal(stats.totals.byType.unclassified, 1);
  assert.equal(stats.totals.behindFlag, 1);
  assert.equal(stats.unbucketed, 1);

  const checkout = stats.perBucket.find((b) => b.name === 'Checkout');
  assert.equal(checkout.prCount, 3);
  assert.equal(checkout.defectCount, 2);
  assert.equal(checkout.defectHours, 72); // 48 + 24
  assert.equal(checkout.defectSharePct, 67);
  assert.deepEqual(checkout.flags, ['new-checkout']);
});

test('hidden feature detection: all feature PRs flagged or invisible', () => {
  const stats = computeStats({ sprint, prs, buckets });
  const checkout = stats.perBucket.find((b) => b.name === 'Checkout');
  assert.equal(checkout.hiddenFeature, true); // its only feature PR is behind a flag
  assert.deepEqual(stats.hiddenWork.map((b) => b.name), ['Checkout']);

  // add a visible, unflagged feature → no longer hidden
  const visible = [...prs, pr(6, { bucketId: 'b1', ann: { workType: 'feature', behindFlag: false, userFacing: true } })];
  const stats2 = computeStats({ sprint, prs: visible, buckets });
  assert.equal(stats2.perBucket.find((b) => b.name === 'Checkout').hiddenFeature, false);
  assert.equal(stats2.hiddenWork.length, 0);
});

test('defect chasing is sorted by turnaround time', () => {
  const stats = computeStats({ sprint, prs, buckets });
  assert.deepEqual(stats.defectChasing.map((b) => b.name), ['Checkout']);
  assert.equal(stats.defectChasing[0].defectHours, 72);
});

test('timeline covers the window and stacks by base branch', () => {
  const stats = computeStats({ sprint, prs, buckets });
  const { days, branches } = stats.timeline;
  assert.ok(branches.includes('develop') && branches.includes('stage'));
  const june2 = days.find((d) => d.date === '2026-06-02');
  assert.equal(june2.byBase.develop, 3); // PRs 1, 3, 5
  assert.equal(june2.byBase.stage, 1); // PR 4
  const june3 = days.find((d) => d.date === '2026-06-03');
  assert.equal(june3.byBase.develop, 1); // PR 2
  // every window day up to the end is present (sprint is in the past)
  assert.deepEqual(days.map((d) => d.date), ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']);
});

test('product lens: user-facing count, shipped-to-users, and highlights', () => {
  const stats = computeStats({ sprint, prs, buckets });
  assert.equal(stats.totals.userFacing, 3); // PRs 1,2,3 are user-facing
  assert.equal(stats.totals.shippedToUsers, 1); // only PR 1 is a user-facing feature
  assert.deepEqual(stats.highlights, []); // none flagged in the base fixture

  const withHighlight = [...prs, pr(6, { bucketId: 'b1', ann: { workType: 'feature', userFacing: true, highlight: true, userImpact: 'New thing for users' } })];
  const s2 = computeStats({ sprint, prs: withHighlight, buckets });
  assert.deepEqual(s2.highlights.map((h) => h.number), [6]);
  assert.equal(s2.highlights[0].bucket, 'Checkout');
  assert.equal(s2.highlights[0].userImpact, 'New thing for users');
  assert.equal(s2.perBucket.find((b) => b.name === 'Checkout').userFacingCount, 4); // 1,2,3,6
});

test('breaking changes and security fixes are surfaced deterministically', () => {
  const items = [
    pr(1, { bucketId: 'b1', ann: { workType: 'feature', userFacing: true, breaking: true, userImpact: 'API v1 removed' } }),
    pr(2, { bucketId: 'b1', ann: { workType: 'defect', userFacing: true, security: true } }),
    pr(3, { bucketId: 'b1', ann: { workType: 'chore', userFacing: false } }),
  ];
  const stats = computeStats({ sprint, prs: items, buckets });
  assert.equal(stats.totals.breaking, 1);
  assert.equal(stats.totals.security, 1);
  assert.deepEqual(stats.breakingChanges.map((b) => b.number), [1]);
  assert.equal(stats.breakingChanges[0].userImpact, 'API v1 removed');
  assert.deepEqual(stats.securityFixes.map((s) => s.number), [2]);
});

test('empty sprint produces sane zeros', () => {
  const stats = computeStats({ sprint, prs: [], buckets: [] });
  assert.equal(stats.totals.prs, 0);
  assert.equal(stats.totals.avgCycleHours, null);
  assert.deepEqual(stats.perBucket, []);
  assert.deepEqual(stats.defectChasing, []);
});
