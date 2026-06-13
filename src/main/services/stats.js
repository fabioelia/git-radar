// Deterministic statistics over annotated PRs. The LLM narrates; this file
// does all arithmetic. Pure functions only — fully unit-tested.

import { hoursBetween, isoDate, addDays, uniq } from './util.js';

export function computeStats({ sprint, prs, buckets }) {
  const merged = prs.filter((p) => p.mergedAt);

  const totals = {
    prs: merged.length,
    contributors: uniq(merged.map((p) => p.author)).length,
    additions: sum(merged, (p) => p.additions),
    deletions: sum(merged, (p) => p.deletions),
    byBase: countBy(merged, (p) => p.base || '(unknown)'),
    byType: countBy(merged, (p) => p.ann?.workType || 'unclassified'),
    avgCycleHours: avg(merged.map(cycleHours).filter(isFiniteNum)),
    behindFlag: merged.filter((p) => p.ann?.behindFlag).length,
    // Product lens: what users can see, and net-new user-facing capability.
    userFacing: merged.filter((p) => p.ann?.userFacing).length,
    shippedToUsers: merged.filter((p) => p.ann?.userFacing && p.ann?.workType === 'feature').length,
    breaking: merged.filter((p) => p.ann?.breaking).length,
    security: merged.filter((p) => p.ann?.security).length,
  };

  const flagPr = (p) => ({
    number: p.number,
    title: p.title,
    bucket: buckets.find((b) => b.id === p.bucketId)?.name || null,
    workType: p.ann?.workType || null,
    userImpact: p.ann?.userImpact || '',
  });
  // Announce-worthy changes the analyst should lead with.
  const highlights = merged.filter((p) => p.ann?.highlight).map(flagPr);
  // Must-never-bury changes — surfaced deterministically so the report can't miss them.
  const breakingChanges = merged.filter((p) => p.ann?.breaking).map(flagPr);
  const securityFixes = merged.filter((p) => p.ann?.security).map(flagPr);

  const perBucket = buckets
    .map((b) => bucketStats(b, merged.filter((p) => p.bucketId === b.id)))
    .filter((b) => b.prCount > 0)
    .sort((a, b) => b.prCount - a.prCount);

  const defectChasing = perBucket
    .filter((b) => b.defectCount > 0)
    .sort((a, b) => b.defectHours - a.defectHours);

  const hiddenWork = perBucket.filter((b) => b.hiddenFeature);

  return {
    totals,
    highlights,
    breakingChanges,
    securityFixes,
    perBucket,
    defectChasing,
    hiddenWork,
    unbucketed: merged.filter((p) => !p.bucketId).length,
    timeline: timeline(sprint, merged),
  };
}

function bucketStats(bucket, prs) {
  const defects = prs.filter((p) => p.ann?.workType === 'defect');
  const features = prs.filter((p) => p.ann?.workType === 'feature');
  const cycles = prs.map(cycleHours).filter(isFiniteNum);
  return {
    id: bucket.id,
    name: bucket.name,
    description: bucket.description || '',
    prCount: prs.length,
    byType: countBy(prs, (p) => p.ann?.workType || 'unclassified'),
    additions: sum(prs, (p) => p.additions),
    deletions: sum(prs, (p) => p.deletions),
    avgCycleHours: avg(cycles),
    defectCount: defects.length,
    // "Time chasing defects": wall-clock open→merge exposure across defect PRs.
    defectHours: sum(defects.map(cycleHours).filter(isFiniteNum), (h) => h),
    defectSharePct: prs.length ? Math.round((defects.length / prs.length) * 100) : 0,
    featureCount: features.length,
    userFacingCount: prs.filter((p) => p.ann?.userFacing).length,
    flags: uniq(prs.map((p) => p.ann?.flagName).filter(Boolean)),
    // Built, but users can't see it: every feature PR flagged or not user-facing.
    hiddenFeature:
      features.length > 0 &&
      features.every((p) => p.ann?.behindFlag || p.ann?.userFacing === false),
    contributors: uniq(prs.map((p) => p.author)),
    prNumbers: prs.map((p) => p.number),
  };
}

/** Merges per day per base branch across the sprint window (capped at today). */
function timeline(sprint, merged) {
  const branches = uniq(merged.map((p) => p.base || '(unknown)'));
  const byDay = new Map();
  for (const p of merged) {
    const day = isoDate(p.mergedAt);
    if (!byDay.has(day)) byDay.set(day, {});
    const row = byDay.get(day);
    const b = p.base || '(unknown)';
    row[b] = (row[b] || 0) + 1;
  }
  const today = isoDate(new Date());
  const end = sprint.endDate < today ? sprint.endDate : today;
  const days = [];
  for (let d = sprint.startDate; d <= end && days.length < 120; d = addDays(d, 1)) {
    days.push({ date: d, byBase: byDay.get(d) || {} });
  }
  // Merges recorded outside the window (e.g. window edited after sync) still count.
  for (const [day, row] of byDay) {
    if (day < sprint.startDate || day > end) days.push({ date: day, byBase: row, outside: true });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  return { branches, days };
}

function cycleHours(pr) {
  if (!pr.createdAt || !pr.mergedAt) return NaN;
  return hoursBetween(pr.createdAt, pr.mergedAt);
}

const isFiniteNum = (n) => Number.isFinite(n) && n >= 0;

function sum(arr, fn) {
  return arr.reduce((acc, x) => acc + (Number(fn(x)) || 0), 0);
}

function avg(nums) {
  return nums.length ? sum(nums, (n) => n) / nums.length : null;
}

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) {
    const k = fn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
