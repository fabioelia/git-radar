// Drives the full pipeline with stubbed gh/Ollama/MCP — proves sync merging,
// classification application, bucket reorg, and the MCP tool loop without
// any network or Electron.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalyzer, applyClassifications, applyReorgOps, findOrCreateBucket, pruneEmptyBuckets,
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

test('categorize batches PRs through the LLM and builds buckets', async () => {
  const store = memStore({ repo, sprint, data: { prs: [pr(1), pr(2), pr(3)], buckets: [], reports: [] } });
  const seenBatches = [];
  const ollama = {
    chat: async ({ messages, schema }) => {
      assert.ok(schema, 'classification must use structured outputs');
      const userMsg = messages.find((m) => m.role === 'user').content;
      seenBatches.push(userMsg);
      return JSON.stringify({
        classifications: [
          { number: 1, bucket: 'Checkout', bucket_description: 'checkout work', work_type: 'feature', behind_flag: true, flag_name: 'new-co', user_facing: true, summary: 's1' },
          { number: 2, bucket: 'checkout', work_type: 'defect', behind_flag: false, flag_name: '', user_facing: true, summary: 's2' },
          { number: 3, bucket: 'Release Operations', work_type: 'release', behind_flag: false, flag_name: '', user_facing: false, summary: 's3' },
        ],
      });
    },
  };
  const analyzer = createAnalyzer({ store, ollama, github: {}, mcp: {} });
  const result = await analyzer.categorize('s1');
  assert.equal(result.classified, 3);
  const data = store.peek();
  assert.equal(data.buckets.length, 2); // "checkout" matched "Checkout" case-insensitively
  const checkout = data.buckets.find((b) => b.name === 'Checkout');
  assert.equal(checkout.description, 'checkout work');
  assert.equal(data.prs.filter((p) => p.bucketId === checkout.id).length, 2);
  assert.equal(data.prs.find((p) => p.number === 1).ann.behindFlag, true);

  // second run with nothing new is a no-op (no LLM calls)
  const calls = seenBatches.length;
  const again = await analyzer.categorize('s1');
  assert.equal(again.classified, 0);
  assert.equal(seenBatches.length, calls);
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
