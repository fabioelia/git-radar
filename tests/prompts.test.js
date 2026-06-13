// The report prompt must carry deterministic per-PR ground truth — titles,
// authors, churn and changed files — so the analyst can describe what shipped
// even before any LLM classification has run. These tests lock that in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportMessages, prLedger } from '../src/main/services/prompts.js';

const repo = { owner: 'acme', name: 'newton', contextPrompt: 'develop → stage → main' };
const sprint = { name: 'Sprint 1', startDate: '2026-06-08', endDate: '2026-06-28' };
const emptyStats = {
  totals: { prs: 0 }, perBucket: [], defectChasing: [], hiddenWork: [], unbucketed: 0,
};

function pr(number, over = {}) {
  return {
    number,
    title: `PR ${number}`,
    body: `body of PR ${number}`,
    author: 'alice',
    base: 'develop',
    head: `feature/${number}`,
    createdAt: '2026-06-10T00:00:00Z',
    mergedAt: '2026-06-11T00:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    dirs: [],
    files: [{ path: `packages/checkout/file${number}.ts`, additions: 10, deletions: 2 }],
    ...over,
  };
}

test('prLedger lists unbucketed PRs with title, author, churn and files', () => {
  const out = prLedger({ buckets: [], prs: [pr(101, { author: 'bob' })] });
  assert.match(out, /Unbucketed \/ unclassified \(1 PRs\)/);
  assert.match(out, /#101 "PR 101" — bob · unclassified/);
  assert.match(out, /\+10\/-2 in 1 files/);
  assert.match(out, /files: packages\/checkout\/file101\.ts/);
  assert.match(out, /body: body of PR 101/);
});

test('prLedger groups classified PRs under their bucket and uses the summary', () => {
  const buckets = [{ id: 'b1', name: 'Checkout', description: 'checkout work' }];
  const prs = [
    pr(1, { bucketId: 'b1', ann: { workType: 'feature', behindFlag: true, flagName: 'new-co', summary: 'rebuilt cart' } }),
    pr(2), // unbucketed
  ];
  const out = prLedger({ buckets, prs });
  assert.match(out, /### Checkout — checkout work \(1 PRs\)/);
  assert.match(out, /#1 "PR 1" — alice · feature \[flag:new-co\]/);
  assert.match(out, /summary: rebuilt cart/); // classified PRs prefer the LLM summary
  assert.match(out, /Unbucketed \/ unclassified \(1 PRs\)/);
});

test('prLedger caps the listing but tells the reader how many were omitted', () => {
  const prs = Array.from({ length: 160 }, (_, i) => pr(i + 1));
  const out = prLedger({ buckets: [], prs });
  assert.match(out, /and 10 more merged PRs not listed/);
});

test('prLedger ignores PRs that never merged', () => {
  const out = prLedger({ buckets: [], prs: [pr(1, { mergedAt: null })] });
  assert.match(out, /no merged PRs in this window/);
});

test('buildReportMessages embeds the deterministic ledger in the user turn', () => {
  const messages = buildReportMessages({
    repo, sprint, stats: emptyStats, buckets: [], prs: [pr(101)], tools: [],
  });
  const user = messages.find((m) => m.role === 'user').content;
  assert.match(user, /MERGED PRS \(deterministic/);
  assert.match(user, /#101 "PR 101" — alice/);
  // and the system prompt tells the model to trust and use it
  const system = messages.find((m) => m.role === 'system').content;
  assert.match(system, /MERGED PRS ledger/);
});
