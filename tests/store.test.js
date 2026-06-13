import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/main/services/store.js';

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-radar-test-'));
  store.initStore(dir);
  return dir;
}

test('settings round-trip with defaults', () => {
  freshStore();
  const s = store.getSettings();
  assert.equal(s.ollamaUrl, 'http://localhost:11434');
  assert.equal(s.ollamaModel, 'gemma3:12b');
  store.saveSettings({ ollamaModel: 'gemma3:4b' });
  assert.equal(store.getSettings().ollamaModel, 'gemma3:4b');
  assert.equal(store.getSettings().ollamaUrl, 'http://localhost:11434'); // untouched default survives
});

test('repo save parses slug, creates first sprint with cycle length', () => {
  freshStore();
  const repo = store.saveRepo({
    slug: 'acme/newton',
    contextPrompt: 'releases every 3 weeks',
    sprintLengthWeeks: 3,
    firstSprintStart: '2026-06-01',
  });
  assert.equal(repo.owner, 'acme');
  assert.equal(repo.name, 'newton');
  const sprints = store.listSprints(repo.id);
  assert.equal(sprints.length, 1);
  assert.equal(sprints[0].startDate, '2026-06-01');
  assert.equal(sprints[0].endDate, '2026-06-21'); // 21 days inclusive
  assert.equal(sprints[0].name, 'Sprint 1');
});

test('repo save accepts github URLs and rejects junk', () => {
  freshStore();
  const repo = store.saveRepo({ slug: 'https://github.com/acme/rocket.git' });
  assert.equal(repo.owner, 'acme');
  assert.equal(repo.name, 'rocket');
  assert.throws(() => store.saveRepo({ slug: 'not a repo' }), /not a valid/);
});

test('sprint rollover starts the day after the previous end', () => {
  freshStore();
  const repo = store.saveRepo({ slug: 'a/b', sprintLengthWeeks: 2, firstSprintStart: '2026-06-01' });
  const next = store.createSprint(repo.id, {});
  assert.equal(next.startDate, '2026-06-15');
  assert.equal(next.endDate, '2026-06-28');
  assert.equal(next.name, 'Sprint 2');
});

test('sprint data persists PRs/buckets/reports', () => {
  freshStore();
  const repo = store.saveRepo({ slug: 'a/b', firstSprintStart: '2026-06-01' });
  const sprint = store.listSprints(repo.id)[0];
  const data = store.getSprintData(sprint.id);
  data.prs.push({ number: 1, title: 'hello' });
  data.buckets.push({ id: 'x', name: 'Checkout' });
  store.saveSprintData(sprint.id, data);
  const loaded = store.getSprintData(sprint.id);
  assert.equal(loaded.prs[0].title, 'hello');
  assert.equal(loaded.buckets[0].name, 'Checkout');
});

test('deleting a repo removes its sprints and data files', () => {
  const dir = freshStore();
  const repo = store.saveRepo({ slug: 'a/b', firstSprintStart: '2026-06-01' });
  const sprint = store.listSprints(repo.id)[0];
  const file = path.join(dir, 'sprints', `${sprint.id}.json`);
  assert.ok(fs.existsSync(file));
  store.deleteRepo(repo.id);
  assert.equal(store.listRepos().length, 0);
  assert.equal(store.listSprints(repo.id).length, 0);
  assert.ok(!fs.existsSync(file));
});
