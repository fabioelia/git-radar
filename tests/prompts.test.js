// The report prompt must carry deterministic per-PR ground truth — titles,
// authors, churn and changed files — so the analyst can describe what shipped
// even before any LLM classification has run. These tests lock that in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportMessages, prLedger, buildSummarizeMessages, PR_SUMMARY_SCHEMA } from '../src/main/services/prompts.js';

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

test('buildSummarizeMessages puts the PR, its files and its discussion in the prompt', () => {
  const prWithComments = pr(55, {
    author: 'dana',
    comments: [
      { kind: 'review', state: 'approved', author: 'lead', body: 'ship it' },
      { kind: 'review_comment', author: 'sam', body: 'guard this null', path: 'src/pay.ts' },
    ],
  });
  const messages = buildSummarizeMessages({ repo: { owner: 'a', name: 'b', contextPrompt: '' }, buckets: [], pr: prWithComments });
  assert.equal(messages.length, 2);
  const user = messages[1].content;
  assert.match(user, /ANALYZE THIS PR:/);
  assert.match(user, /#55 "PR 55"/);
  assert.match(user, /packages\/checkout\/file55\.ts/); // file list present
  assert.match(user, /PR DISCUSSION \(2 items\)/);
  assert.match(user, /\[review\/approved\] lead: ship it/);
  assert.match(user, /\[inline src\/pay\.ts\] sam: guard this null/);
  // the system prompt asks for the detail + risk fields
  assert.match(messages[0].content, /detail: 2–4 sentences/);
});

test('buildSummarizeMessages notes when there is no discussion', () => {
  const messages = buildSummarizeMessages({ repo: { owner: 'a', name: 'b' }, buckets: [{ name: 'Checkout', description: 'co', prCount: 3 }], pr: pr(1, { comments: [] }) });
  assert.match(messages[1].content, /PR DISCUSSION: \(none captured\)/);
  assert.match(messages[1].content, /- Checkout: co \[3 PRs\]/); // existing buckets offered for reuse
});

test('PR_SUMMARY_SCHEMA requires the planning fields', () => {
  assert.deepEqual(PR_SUMMARY_SCHEMA.required.sort(), ['behind_flag', 'bucket', 'detail', 'summary', 'user_facing', 'work_type']);
  assert.deepEqual(PR_SUMMARY_SCHEMA.properties.risk.enum, ['low', 'medium', 'high']);
});

test('prLedger surfaces the detail and comment count when present', () => {
  const prs = [pr(9, { comments: [{}, {}, {}], ann: { workType: 'feature', detail: 'Big rework of the cart.', risk: 'high' } })];
  const out = prLedger({ buckets: [], prs });
  assert.match(out, /3 comments/);
  assert.match(out, /high risk/);
  assert.match(out, /detail: Big rework of the cart\./);
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
