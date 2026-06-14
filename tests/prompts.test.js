// The report prompt must carry deterministic per-PR ground truth — but stay
// COMPACT so it fits a local model's context window. These tests lock in the
// two-tier ledger (notable PRs in full + internal PRs collapsed), compact mode,
// and the product-notes framing.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReportMessages, prLedger, buildSummarizeMessages, PR_SUMMARY_SCHEMA,
  summaryFingerprint, isSummaryStale, PROMPT_VERSION,
  buildBucketSectionMessages, buildReduceMessages,
} from '../src/main/services/prompts.js';

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

test('prLedger lists notable PRs in full and collapses internal PRs to one compact line', () => {
  const prs = [
    pr(101, { author: 'bob', ann: { workType: 'feature', userFacing: true, userImpact: 'Users can now do X.' } }),
    pr(102, { author: 'sam', ann: { workType: 'chore', userFacing: false } }), // internal → "other"
  ];
  const out = prLedger({ buckets: [], prs });
  assert.match(out, /Unbucketed \/ unclassified \(2 PRs\)/);
  assert.match(out, /#101 "PR 101" — bob · feature · user-facing/);
  assert.match(out, /→ Users can now do X\./);
  assert.match(out, /other \(internal\/chore, titles only\): #102 PR 102/);
});

test('prLedger groups by bucket and uses user impact (falling back to summary) for notable PRs', () => {
  const buckets = [{ id: 'b1', name: 'Checkout', description: 'checkout work' }];
  const prs = [
    pr(1, { bucketId: 'b1', ann: { workType: 'feature', userFacing: true, behindFlag: true, flagName: 'new-co', summary: 'rebuilt cart' } }),
    pr(2, { bucketId: 'b1', ann: { workType: 'chore', userFacing: false } }),
  ];
  const out = prLedger({ buckets, prs });
  assert.match(out, /### Checkout — checkout work \(2 PRs\)/);
  assert.match(out, /#1 "PR 1" — alice · feature · user-facing · flag:new-co/);
  assert.match(out, /→ rebuilt cart/); // no userImpact → falls back to the summary
  assert.match(out, /other \(internal\/chore, titles only\): #2 PR 2/);
});

test('prLedger caps the internal/chore list and notes the remainder', () => {
  const prs = Array.from({ length: 60 }, (_, i) => pr(i + 1, { ann: { workType: 'chore', userFacing: false } }));
  const out = prLedger({ buckets: [], prs });
  assert.match(out, /\+10 more/); // 60 internal, 50 listed
});

test('prLedger compact mode drops the internal/chore titles entirely', () => {
  const prs = [
    pr(1, { ann: { workType: 'feature', userFacing: true, userImpact: 'X' } }),
    pr(2, { ann: { workType: 'chore', userFacing: false } }),
  ];
  const out = prLedger({ buckets: [], prs, includeOther: false });
  assert.match(out, /#1 "PR 1"/);
  assert.doesNotMatch(out, /other \(internal\/chore/);
  assert.match(out, /\(\+1 internal\/chore PRs — see stats\)/);
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

test('summaryFingerprint tracks the release-cycle prompt; isSummaryStale follows it', () => {
  const repoA = { contextPrompt: 'develop → stage → main' };
  const repoB = { contextPrompt: 'trunk-based' };
  assert.ok(summaryFingerprint(repoA).startsWith(`${PROMPT_VERSION}:`));
  assert.notEqual(summaryFingerprint(repoA), summaryFingerprint(repoB));

  assert.equal(isSummaryStale({ number: 1 }, repoA), true); // never summarized
  const done = { number: 1, ann: { summaryFingerprint: summaryFingerprint(repoA) } };
  assert.equal(isSummaryStale(done, repoA), false); // same prompt → current
  assert.equal(isSummaryStale(done, repoB), true); // prompt changed → stale
});

test('PR_SUMMARY_SCHEMA requires the planning + product fields and has breaking/security flags', () => {
  assert.deepEqual(
    PR_SUMMARY_SCHEMA.required.sort(),
    ['behind_flag', 'bucket', 'detail', 'summary', 'user_facing', 'user_impact', 'work_type'],
  );
  assert.deepEqual(PR_SUMMARY_SCHEMA.properties.risk.enum, ['low', 'medium', 'high']);
  assert.equal(PR_SUMMARY_SCHEMA.properties.highlight.type, 'boolean');
  assert.equal(PR_SUMMARY_SCHEMA.properties.breaking.type, 'boolean');
  assert.equal(PR_SUMMARY_SCHEMA.properties.security.type, 'boolean');
  assert.deepEqual(PR_SUMMARY_SCHEMA.properties.changelog_category.enum,
    ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security', 'none']);
  assert.deepEqual(PR_SUMMARY_SCHEMA.properties.audience.enum,
    ['end_user', 'developer', 'admin', 'internal']);
});

test('buildSummarizeMessages asks for Keep-a-Changelog category, audience, impact and flags', () => {
  const system = buildSummarizeMessages({ repo: { owner: 'a', name: 'b' }, buckets: [], pr: pr(1, { comments: [] }) })[0].content;
  assert.match(system, /user_impact: if user_facing/);
  assert.match(system, /never vague filler like "various fixes"/);
  assert.match(system, /changelog_category: the Keep a Changelog category/);
  assert.match(system, /audience: who the change is primarily for/);
  assert.match(system, /breaking: true if this is backward-incompatible/);
  assert.match(system, /security: true if it fixes a vulnerability/);
});

test('buildSummarizeMessages shows the deterministic conventional-commit hint', () => {
  const withCc = pr(1, { comments: [], conventional: { type: 'feat', scope: 'connectors', breaking: true, subject: 'x' } });
  const user = buildSummarizeMessages({ repo: { owner: 'a', name: 'b' }, buckets: [], pr: withCc })[1].content;
  assert.match(user, /conventional commit: feat\(connectors\) — BREAKING CHANGE/);
});

test('prLedger surfaces a conventional-commit breaking change even when unsummarized', () => {
  const prs = [pr(5, { ann: undefined, conventional: { type: 'feat', scope: '', breaking: true, subject: 'x' } })];
  const out = prLedger({ buckets: [], prs });
  assert.match(out, /⚠ #5 "PR 5" — alice · feat/); // breaking marker + cc type, no summary needed
});

test('prLedger shows breaking/security/highlight markers, category, and the one-line impact', () => {
  const prs = [pr(9, {
    ann: { workType: 'feature', userFacing: true, breaking: true, security: true, highlight: true, changelogCategory: 'removed', userImpact: 'The v1 export is gone; migrate to v2.', risk: 'high' },
  })];
  const out = prLedger({ buckets: [], prs });
  assert.match(out, /⚠ 🔒 ★ #9 "PR 9" — alice · feature · removed · user-facing · high risk/);
  assert.match(out, /→ The v1 export is gone; migrate to v2\./);
});

test('buildReportMessages frames the report as product notes and forbids the "unclassified" cop-out', () => {
  const messages = buildReportMessages({
    repo, sprint, stats: emptyStats, buckets: [], prs: [pr(101)], tools: [],
  });
  const system = messages.find((m) => m.role === 'system').content;
  assert.match(system, /product notes/i);
  assert.match(system, /## Headlines/);
  assert.match(system, /## Breaking changes, deprecations & security/);
  assert.match(system, /## New for users/);
  assert.match(system, /## Invisible this sprint/);
  assert.match(system, /Never answer "unclassified"/);
  assert.match(system, /various bug fixes/); // bans vague filler
  assert.match(system, /Do NOT paste raw PR titles/);
  assert.match(system, /must NEVER be buried/);
});

test('buildBucketSectionMessages (map) scopes to one area with its PRs and asks for a fragment', () => {
  const msgs = buildBucketSectionMessages({
    repo,
    bucket: { name: 'Connectors', description: 'data connectors' },
    prs: [pr(1, { ann: { workType: 'feature', userFacing: true, userImpact: 'Users can now connect X.' } })],
    bucketStats: { prCount: 1, byType: { feature: 1 }, userFacingCount: 1 },
  });
  assert.match(msgs[0].content, /fragment for ONE area/);
  const user = msgs[1].content;
  assert.match(user, /AREA: Connectors — data connectors/);
  assert.match(user, /#1 "PR 1"/);
  assert.match(user, /→ Users can now connect X\./);
});

test('buildReduceMessages synthesizes area fragments + stats into the report', () => {
  const sections = [{ area: 'Connectors', markdown: 'connectors fragment text' }, { area: 'UI', markdown: 'ui fragment text' }];
  const msgs = buildReduceMessages({ repo, sprint, stats: emptyStats, sections, tools: [] });
  assert.match(msgs[0].content, /SYNTHESIZE them/);
  assert.match(msgs[0].content, /## Headlines/);
  const user = msgs[1].content;
  assert.match(user, /AREA SECTIONS/);
  assert.match(user, /## Connectors\nconnectors fragment text/);
  assert.match(user, /STATS \(computed deterministically/);
});

test('buildReportMessages embeds the deterministic ledger in the user turn', () => {
  const messages = buildReportMessages({
    repo, sprint, stats: emptyStats, buckets: [], prs: [pr(101, { ann: { workType: 'feature', userFacing: true, userImpact: 'New thing.' } })], tools: [],
  });
  const user = messages.find((m) => m.role === 'user').content;
  assert.match(user, /MERGED PRS \(deterministic/);
  assert.match(user, /#101 "PR 101" — alice/);
  // and the system prompt tells the model to trust and use it
  const system = messages.find((m) => m.role === 'system').content;
  assert.match(system, /MERGED PRS ledger/);
});
