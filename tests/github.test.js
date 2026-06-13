import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDirs, topFiles, normalizeComments } from '../src/main/services/github.js';

test('summarizeDirs condenses monorepo paths to leading segments', () => {
  const files = [
    { path: 'packages/checkout/src/cart.ts' },
    { path: 'packages/checkout/src/pay.ts' },
    { path: 'packages/checkout/test/pay.test.ts' },
    { path: 'packages/api/server.ts' },
    { path: 'README.md' },
  ];
  const dirs = summarizeDirs(files);
  assert.deepEqual(dirs[0], { dir: 'packages/checkout', files: 3 });
  assert.deepEqual(dirs[1], { dir: 'packages/api', files: 1 });
  assert.ok(dirs.some((d) => d.dir === '(root)' && d.files === 1));
});

test('summarizeDirs handles empty/missing input and caps the list', () => {
  assert.deepEqual(summarizeDirs(undefined), []);
  assert.deepEqual(summarizeDirs([]), []);
  const many = Array.from({ length: 40 }, (_, i) => ({ path: `pkg${i}/file.js` }));
  assert.equal(summarizeDirs(many).length, 12);
});

test('topFiles keeps the changed-file paths, ordered by churn and capped', () => {
  const files = [
    { path: 'packages/api/server.ts', additions: 2, deletions: 1 },
    { path: 'packages/checkout/pay.ts', additions: 100, deletions: 20 },
    { path: 'README.md', additions: 0, deletions: 0 },
  ];
  const out = topFiles(files);
  assert.equal(out[0].path, 'packages/checkout/pay.ts'); // highest churn first
  assert.equal(out[0].additions, 100);
  assert.equal(out.length, 3);
});

test('topFiles handles missing input, string entries, and caps the list', () => {
  assert.deepEqual(topFiles(undefined), []);
  assert.deepEqual(topFiles([]), []);
  assert.deepEqual(topFiles(['a/b.js']), [{ path: 'a/b.js', additions: 0, deletions: 0 }]);
  const many = Array.from({ length: 80 }, (_, i) => ({ path: `pkg${i}/file.js`, additions: i, deletions: 0 }));
  assert.equal(topFiles(many).length, 50);
});

test('normalizeComments merges issue comments, reviews and inline comments chronologically', () => {
  const out = normalizeComments({
    view: {
      comments: [{ author: { login: 'ann' }, body: 'second', createdAt: '2026-06-02T00:00:00Z' }],
      reviews: [
        { author: { login: 'lead' }, body: 'needs work', state: 'CHANGES_REQUESTED', submittedAt: '2026-06-03T00:00:00Z' },
        { author: { login: 'bot' }, body: '', state: '', submittedAt: '2026-06-04T00:00:00Z' }, // empty → dropped
      ],
    },
    reviewComments: [{ user: { login: 'sam' }, body: 'inline note', path: 'src/x.ts', created_at: '2026-06-01T00:00:00Z' }],
  });
  assert.deepEqual(out.map((c) => c.kind), ['review_comment', 'comment', 'review']); // sorted by time
  assert.equal(out[0].path, 'src/x.ts');
  assert.equal(out[2].state, 'changes_requested');
});

test('normalizeComments tolerates empty/missing input and caps the list', () => {
  assert.deepEqual(normalizeComments(), []);
  assert.deepEqual(normalizeComments({}), []);
  const many = { view: { comments: Array.from({ length: 60 }, (_, i) => ({ author: { login: 'u' }, body: `c${i}`, createdAt: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z` })) } };
  assert.equal(normalizeComments(many).length, 40);
});
