// Drives the full pipeline with stubbed gh/Ollama/MCP — proves sync merging,
// classification application, bucket reorg, and the MCP tool loop without
// any network or Electron.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalyzer, applyClassifications, applyReorgOps, findOrCreateBucket, pruneEmptyBuckets, looksDegenerateReport,
} from '../src/main/services/analyzer.js';

function memStore({ repo, sprint, data, settings = {} }) {
  const state = { data: structuredClone(data) };
  return {
    getRepo: () => repo,
    getSprint: () => sprint,
    getSprintData: () => structuredClone(state.data),
    saveSprintData: (_id, d) => {
      state.data = structuredClone(d);
      return d;
    },
    getSettings: () => ({ mcpServers: [], ...settings }),
    peek: () => state.data,
  };
}

const repo = { id: 'r1', owner: 'acme', name: 'newton', contextPrompt: 'develop → stage → main', trackedBranches: [] };
const sprint = { id: 's1', repoId: 'r1', name: 'Sprint 1', startDate: '2026-06-01', endDate: '2026-06-21' };

function pr(number, over = {}) {
  return {
    number,
    title: `PR ${number}`,
    author: 'alice',
    base: 'develop',
    createdAt: '2026-06-01T00:00:00Z',
    mergedAt: '2026-06-02T00:00:00Z',
    additions: 1,
    deletions: 1,
    ...over,
  };
}

test('sync merges fetched PRs by number and preserves annotations', async () => {
  const existing = pr(1);
  existing.bucketId = 'bX';
  existing.ann = { workType: 'feature' };
  const store = memStore({ repo, sprint, data: { prs: [existing], buckets: [], reports: [] } });
  const github = {
    fetchMergedPRs: async () => [pr(1, { title: 'PR 1 updated' }), pr(2)],
  };
  const analyzer = createAnalyzer({ store, github, ollama: {}, mcp: {} });
  const result = await analyzer.sync('s1');
  assert.equal(result.added, 1);
  assert.equal(result.total, 2);
  const saved = store.peek();
  const one = saved.prs.find((p) => p.number === 1);
  assert.equal(one.title, 'PR 1 updated'); // refreshed fields
  assert.equal(one.bucketId, 'bX'); // kept classification
  assert.equal(one.ann.workType, 'feature');
  assert.ok(saved.lastSyncAt);
});

test('categorize summarizes each PR (per-PR), fetches discussion, and builds buckets', async () => {
  const store = memStore({ repo, sprint, data: { prs: [pr(1), pr(2), pr(3)], buckets: [], reports: [] } });
  const seenPrompts = [];
  const detailCalls = [];
  const github = {
    fetchPRDetails: async (_repo, number) => {
      detailCalls.push(number);
      return { comments: [{ kind: 'comment', author: 'rev', body: `discuss ${number}`, createdAt: '2026-06-01T00:00:00Z' }] };
    },
  };
  const ollama = {
    chat: async ({ messages, schema }) => {
      assert.ok(schema, 'summarize must use structured outputs');
      const userMsg = messages.find((m) => m.role === 'user').content;
      seenPrompts.push(userMsg);
      const num = Number(userMsg.match(/#(\d+) "/)[1]);
      if (num === 1) return JSON.stringify({ bucket: 'Checkout', bucket_description: 'checkout work', work_type: 'feature', behind_flag: true, flag_name: 'new-co', user_facing: true, summary: 's1', detail: 'Rebuilt the cart summary.', risk: 'medium' });
      if (num === 2) return JSON.stringify({ bucket: 'checkout', work_type: 'defect', behind_flag: false, flag_name: '', user_facing: true, summary: 's2', detail: 'Fixed a promo NPE.' });
      return JSON.stringify({ bucket: 'Release Operations', work_type: 'release', behind_flag: false, flag_name: '', user_facing: false, summary: 's3', detail: 'Merged develop into stage.' });
    },
  };
  const analyzer = createAnalyzer({ store, ollama, github, mcp: {} });
  const result = await analyzer.categorize('s1');
  assert.equal(result.classified, 3);
  assert.equal(seenPrompts.length, 3); // one LLM call per PR
  assert.deepEqual(detailCalls.sort(), [1, 2, 3]); // discussion pulled deterministically per PR
  assert.match(seenPrompts[0], /ANALYZE THIS PR/);
  assert.match(seenPrompts[0], /PR DISCUSSION/);
  assert.match(seenPrompts[0], /discuss 1/); // the fetched comment is in the prompt

  const data = store.peek();
  assert.equal(data.buckets.length, 2); // "checkout" matched "Checkout" case-insensitively
  const checkout = data.buckets.find((b) => b.name === 'Checkout');
  assert.equal(checkout.description, 'checkout work');
  assert.equal(data.prs.filter((p) => p.bucketId === checkout.id).length, 2);
  const one = data.prs.find((p) => p.number === 1);
  assert.equal(one.ann.behindFlag, true);
  assert.equal(one.ann.detail, 'Rebuilt the cart summary.');
  assert.equal(one.ann.risk, 'medium');
  assert.equal(one.comments.length, 1); // discussion cached on the PR

  // second run with nothing new is a no-op (no LLM calls, no re-fetch)
  const llmCalls = seenPrompts.length;
  const fetches = detailCalls.length;
  const again = await analyzer.categorize('s1');
  assert.equal(again.classified, 0);
  assert.equal(seenPrompts.length, llmCalls);
  assert.equal(detailCalls.length, fetches);

  // each PR's exchange is logged verbatim for the Prompts tab (newest first)
  const log = data.llmLog;
  assert.equal(log.length, 3);
  assert.ok(log.every((e) => e.task === 'summarize'));
  assert.equal(log[0].messages[0].role, 'system');
  assert.ok(Number.isFinite(log[0].durationMs));
});

function concurrencyProbe() {
  let active = 0;
  let max = 0;
  return {
    chat: async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return JSON.stringify({ bucket: 'B', work_type: 'chore', behind_flag: false, user_facing: true, summary: 's', detail: 'd' });
    },
    maxActive: () => max,
  };
}

test('categorize summarizes strictly one at a time by default', async () => {
  const store = memStore({ repo, sprint, data: { prs: [pr(1), pr(2), pr(3)], buckets: [], reports: [] } });
  const probe = concurrencyProbe();
  const analyzer = createAnalyzer({ store, ollama: probe, github: {}, mcp: {} });
  const res = await analyzer.categorize('s1');
  assert.equal(res.classified, 3);
  assert.equal(probe.maxActive(), 1); // no parallelism unless asked for
});

test('categorize runs up to the configured number in parallel', async () => {
  const store = memStore({
    repo, sprint,
    data: { prs: [pr(1), pr(2), pr(3), pr(4), pr(5)], buckets: [], reports: [] },
    settings: { summaryConcurrency: 3 },
  });
  const probe = concurrencyProbe();
  const analyzer = createAnalyzer({ store, ollama: probe, github: {}, mcp: {} });
  const res = await analyzer.categorize('s1');
  assert.equal(res.classified, 5);
  assert.equal(probe.maxActive(), 3); // capped at the setting
});

test('categorize skips current PRs and re-summarizes only when the prompt changes', async () => {
  const repoMut = { id: 'r1', owner: 'acme', name: 'newton', contextPrompt: 'v1', trackedBranches: [] };
  const store = memStore({ repo: repoMut, sprint, data: { prs: [pr(1), pr(2)], buckets: [], reports: [] } });
  let calls = 0;
  const ollama = {
    chat: async () => { calls += 1; return JSON.stringify({ bucket: 'B', work_type: 'chore', behind_flag: false, user_facing: false, summary: 's', detail: 'd' }); },
  };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });

  await analyzer.categorize('s1');
  assert.equal(calls, 2); // both summarized
  assert.ok(store.peek().prs[0].ann.summaryFingerprint); // fingerprint stamped

  // re-running with the same prompt is a no-op — finished work is not redone
  const again = await analyzer.categorize('s1');
  assert.equal(again.classified, 0);
  assert.equal(calls, 2);

  // editing the release-cycle prompt makes both stale → they get re-summarized
  repoMut.contextPrompt = 'v2 — now trunk-based';
  const restaled = await analyzer.categorize('s1');
  assert.equal(restaled.classified, 2);
  assert.equal(calls, 4);
});

test('summarizePR re-runs one PR on demand and inspectPR builds the prompt without firing', async () => {
  const store = memStore({ repo, sprint, data: { prs: [pr(7)], buckets: [], reports: [] } });
  let chatCalls = 0;
  const github = {
    fetchPRDetails: async () => ({ comments: [{ kind: 'review', state: 'approved', author: 'lead', body: 'LGTM', createdAt: '2026-06-01T00:00:00Z' }] }),
    fetchPRDiff: async () => ({ diff: 'diff --git a/x b/x\n+hi', truncated: false, totalChars: 24 }),
  };
  const ollama = {
    chat: async () => { chatCalls += 1; return JSON.stringify({ bucket: 'Growth', work_type: 'feature', behind_flag: false, user_facing: true, summary: 'did a thing', detail: 'A thing happened.', risk: 'low' }); },
  };
  const analyzer = createAnalyzer({ store, ollama, github, mcp: {} });

  // inspectPR fires no LLM call, returns the built prompt + diff + discussion
  const inspect = await analyzer.inspectPR('s1', 7);
  assert.equal(chatCalls, 0);
  assert.equal(inspect.messages[0].role, 'system');
  assert.match(inspect.messages[1].content, /ANALYZE THIS PR/);
  assert.match(inspect.messages[1].content, /LGTM/);
  assert.equal(inspect.diff.totalChars, 24);

  // summarizePR fires once and applies the result
  const res = await analyzer.summarizePR('s1', 7);
  assert.equal(chatCalls, 1);
  assert.equal(res.pr.ann.workType, 'feature');
  assert.equal(res.pr.ann.detail, 'A thing happened.');
  assert.equal(store.peek().prs[0].bucketId, store.peek().buckets.find((b) => b.name === 'Growth').id);
  assert.equal(store.peek().llmLog[0].task, 'summarize');
});

test('failed LLM calls are logged with the prompt and persisted', async () => {
  const store = memStore({ repo, sprint, data: { prs: [pr(1)], buckets: [], reports: [] } });
  const ollama = { chat: async () => { throw new Error('model exploded'); } };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });
  await assert.rejects(() => analyzer.categorize('s1'), /model exploded/);
  const log = store.peek().llmLog;
  assert.equal(log.length, 1);
  assert.equal(log[0].error, 'model exploded');
  assert.equal(log[0].messages[0].role, 'system'); // the prompt that failed is preserved
});

test('reorganize applies merge/rename ops and prunes empty buckets', async () => {
  const data = {
    prs: [pr(1, { bucketId: 'a' }), pr(2, { bucketId: 'b' }), pr(3, { bucketId: 'c' })],
    buckets: [
      { id: 'a', name: 'Checkout' },
      { id: 'b', name: 'Checkout Flow' },
      { id: 'c', name: 'Payments' },
    ],
    reports: [],
  };
  const store = memStore({ repo, sprint, data });
  const ollama = {
    chat: async () => JSON.stringify({
      operations: [
        { op: 'merge', from: ['Checkout Flow'], into: 'Checkout', description: 'all checkout work' },
        { op: 'rename', bucket: 'Payments', to: 'Payments Service' },
      ],
    }),
  };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });
  const result = await analyzer.reorganize('s1');
  assert.equal(result.operations, 2);
  const after = store.peek();
  assert.deepEqual(after.buckets.map((b) => b.name).sort(), ['Checkout', 'Payments Service']);
  const checkout = after.buckets.find((b) => b.name === 'Checkout');
  assert.equal(checkout.description, 'all checkout work');
  assert.equal(after.prs.filter((p) => p.bucketId === checkout.id).length, 2);
});

test('report runs the MCP tool loop then saves the markdown', async () => {
  const classified = pr(1, { bucketId: 'a', ann: { workType: 'feature', behindFlag: false, userFacing: true } });
  const store = memStore({
    repo,
    sprint,
    data: { prs: [classified], buckets: [{ id: 'a', name: 'Checkout' }], reports: [] },
    settings: { mcpServers: [{ name: 'jira', command: 'noop' }] },
  });
  const toolCalls = [];
  const mcp = {
    connectServers: async () => [{ name: 'jira', ok: true, toolCount: 1 }],
    listAllTools: () => [{ name: 'jira.get_sprint', description: 'sprint goals', inputSchema: { type: 'object' } }],
    callTool: async (name, args) => {
      toolCalls.push({ name, args });
      return 'Sprint goal: ship checkout';
    },
  };
  let turn = 0;
  const ollama = {
    chat: async ({ messages }) => {
      turn += 1;
      if (turn === 1) {
        assert.match(messages[0].content, /jira\.get_sprint/);
        return '{"tool_call": {"name": "jira.get_sprint", "arguments": {"board": 7}}}';
      }
      assert.match(messages.at(-1).content, /Sprint goal: ship checkout/);
      return '## TL;DR\nShipped checkout, matched the plan.';
    },
  };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp });
  const report = await analyzer.generateReport('s1');
  assert.deepEqual(toolCalls, [{ name: 'jira.get_sprint', args: { board: 7 } }]);
  assert.match(report.markdown, /Shipped checkout/);
  assert.equal(report.toolCalls.length, 1);
  assert.equal(report.toolCalls[0].ok, true);
  assert.equal(store.peek().reports.length, 1);

  // both turns logged, newest first, with the mutated message array snapshotted
  const log = store.peek().llmLog;
  assert.deepEqual(log.map((e) => e.meta), ['after tool turn 1', 'initial prompt']);
  assert.equal(log[1].messages.length, 2); // initial turn: system + user only
  assert.equal(log[0].messages.length, 4); // after tool result was appended
});

test('report retries with a slimmer prompt when the model returns a degenerate response', async () => {
  assert.equal(looksDegenerateReport('Okay'), true);
  assert.equal(looksDegenerateReport('## Headlines\n- x'), false);

  const classified = pr(1, { bucketId: 'a', ann: { workType: 'feature', userFacing: true, userImpact: 'X' } });
  const store = memStore({ repo, sprint, data: { prs: [classified], buckets: [{ id: 'a', name: 'Checkout' }], reports: [] } });
  let turn = 0;
  const ollama = {
    chat: async () => { turn += 1; return turn === 1 ? 'Okay' : '## Headlines\n- shipped checkout'; },
  };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });
  const report = await analyzer.generateReport('s1');
  assert.equal(turn, 2); // initial degenerate response + one compact retry
  assert.match(report.markdown, /## Headlines/);
  assert.equal(store.peek().llmLog[0].meta, 'retry (compact prompt)');
});

test('large sprints map per-area then reduce, and cache area fragments across runs', async () => {
  const data = {
    prs: [
      pr(1, { bucketId: 'a', ann: { workType: 'feature', userFacing: true, userImpact: 'X', summaryFingerprint: 'f1' } }),
      pr(2, { bucketId: 'b', ann: { workType: 'defect', userFacing: true, summaryFingerprint: 'f2' } }),
    ],
    buckets: [{ id: 'a', name: 'Checkout' }, { id: 'b', name: 'Payments' }],
    reports: [],
  };
  const store = memStore({ repo, sprint, data, settings: { reportMapReduceThreshold: 1 } });
  const calls = [];
  const ollama = {
    chat: async ({ messages }) => {
      const isSection = /fragment for ONE area/.test(messages[0].content);
      calls.push(isSection ? 'section' : 'reduce');
      return isSection ? 'area fragment' : '## Headlines\n- shipped stuff';
    },
  };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });
  const report = await analyzer.generateReport('s1');
  assert.deepEqual(calls, ['section', 'section', 'reduce']); // 2 areas mapped + 1 synthesis
  assert.equal(report.strategy, 'map-reduce');
  assert.equal(report.sections.length, 2);
  assert.match(report.markdown, /## Headlines/);

  // re-run: PRs unchanged → cached fragments reused, only the reduce fires
  calls.length = 0;
  await analyzer.generateReport('s1');
  assert.deepEqual(calls, ['reduce']);
});

test('small sprints use the single-pass report', async () => {
  const store = memStore({
    repo,
    sprint,
    data: { prs: [pr(1, { bucketId: 'a', ann: { workType: 'feature', userFacing: true } })], buckets: [{ id: 'a', name: 'Checkout' }, { id: 'b', name: 'Payments' }], reports: [] },
  });
  const ollama = { chat: async () => '## Headlines\n- x' };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });
  const report = await analyzer.generateReport('s1');
  assert.equal(report.strategy, 'single'); // below the default PR threshold
});

test('report works with no MCP servers configured', async () => {
  const store = memStore({ repo, sprint, data: { prs: [], buckets: [], reports: [] } });
  const ollama = { chat: async () => '## TL;DR\nQuiet sprint.' };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });
  const report = await analyzer.generateReport('s1');
  assert.match(report.markdown, /Quiet sprint/);
  assert.deepEqual(report.toolCalls, []);
});

test('pure helpers: findOrCreateBucket, applyClassifications, applyReorgOps edge cases', () => {
  const data = { prs: [pr(9)], buckets: [] };
  const b1 = findOrCreateBucket(data, 'Growth');
  const b2 = findOrCreateBucket(data, '  growth ');
  assert.equal(b1.id, b2.id);

  // classification for an unknown PR number is skipped, unknown type coerced
  const applied = applyClassifications(data, [
    { number: 9, bucket: 'Growth', work_type: 'bogus', behind_flag: false, user_facing: true, summary: 'x' },
    { number: 999, bucket: 'Ghost', work_type: 'feature', behind_flag: false, user_facing: true, summary: 'y' },
  ]);
  assert.equal(applied, 1);
  assert.equal(data.prs[0].ann.workType, 'chore');

  // rename onto an existing bucket merges instead of clobbering
  const c1 = findOrCreateBucket(data, 'Checkout');
  data.prs.push(pr(10, { bucketId: c1.id }));
  const ops = applyReorgOps(data, [{ op: 'rename', bucket: 'Checkout', to: 'Growth' }]);
  assert.equal(ops, 1);
  pruneEmptyBuckets(data);
  assert.equal(data.buckets.filter((b) => b.name === 'Growth').length, 1);
  assert.equal(data.prs.find((p) => p.number === 10).bucketId, b1.id);
});
