import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDirs } from '../src/main/services/github.js';

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
