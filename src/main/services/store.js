// Local-first JSON persistence. One document for settings/repos/sprints,
// one file per sprint for its PRs/buckets/reports. Atomic writes via
// tmp+rename. Deliberately free of electron imports so tests can drive it.

import fs from 'node:fs';
import path from 'node:path';
import { uid, addDays, isoDate } from './util.js';

let dataDir = null;

export const DEFAULT_SETTINGS = {
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma3:12b',
  numCtx: 16384,
  temperature: 0.2,
  summaryConcurrency: 1,
  mcpServers: [],
  autoPoll: false,
  autoPollMinutes: 15,
};

function dbPath() {
  return path.join(dataDir, 'git-radar.json');
}

function sprintPath(sprintId) {
  return path.join(dataDir, 'sprints', `${sprintId}.json`);
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function emptyDb() {
  return { settings: { ...DEFAULT_SETTINGS }, repos: [], sprints: [] };
}

function readDb() {
  return readJson(dbPath(), emptyDb());
}

function writeDb(db) {
  writeJson(dbPath(), db);
}

export function initStore(dir) {
  dataDir = dir;
  fs.mkdirSync(path.join(dataDir, 'sprints'), { recursive: true });
  if (!fs.existsSync(dbPath())) writeDb(emptyDb());
}

export function getDataDir() {
  return dataDir;
}

// ---- settings ----

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readDb().settings };
}

export function saveSettings(settings) {
  const db = readDb();
  db.settings = { ...DEFAULT_SETTINGS, ...db.settings, ...settings };
  writeDb(db);
  return db.settings;
}

// ---- repos ----

export function listRepos() {
  return readDb().repos;
}

export function getRepo(id) {
  return readDb().repos.find((r) => r.id === id) || null;
}

/**
 * Upsert a repo. `repo.slug` is "owner/name". Creates the first sprint when
 * the repo is new, anchored at `repo.firstSprintStart` (default: today).
 */
export function saveRepo(repo) {
  const db = readDb();
  const slug = String(repo.slug || '').trim().replace(/^https?:\/\/github\.com\//i, '');
  const m = slug.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) throw new Error(`"${repo.slug}" is not a valid owner/repo`);
  const [, owner, name] = m;

  const base = {
    owner,
    name,
    contextPrompt: String(repo.contextPrompt || '').trim(),
    sprintLengthWeeks: Math.max(1, Number(repo.sprintLengthWeeks) || 3),
    trackedBranches: (repo.trackedBranches || [])
      .map((b) => String(b).trim())
      .filter(Boolean),
  };

  let saved;
  if (repo.id) {
    const i = db.repos.findIndex((r) => r.id === repo.id);
    if (i === -1) throw new Error('Repo not found');
    saved = { ...db.repos[i], ...base };
    db.repos[i] = saved;
  } else {
    saved = { id: uid(), createdAt: new Date().toISOString(), ...base };
    db.repos.push(saved);
  }
  writeDb(db);

  if (!listSprints(saved.id).length) {
    const start = repo.firstSprintStart || isoDate(new Date());
    createSprint(saved.id, { startDate: start });
  }
  return saved;
}

export function deleteRepo(id) {
  const db = readDb();
  db.repos = db.repos.filter((r) => r.id !== id);
  const dead = db.sprints.filter((s) => s.repoId === id);
  db.sprints = db.sprints.filter((s) => s.repoId !== id);
  writeDb(db);
  for (const s of dead) {
    try {
      fs.rmSync(sprintPath(s.id), { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// ---- sprints ----

export function listSprints(repoId) {
  return readDb()
    .sprints.filter((s) => s.repoId === repoId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

export function getSprint(id) {
  return readDb().sprints.find((s) => s.id === id) || null;
}

export function createSprint(repoId, { startDate, endDate, name } = {}) {
  const db = readDb();
  const repo = db.repos.find((r) => r.id === repoId);
  if (!repo) throw new Error('Repo not found');
  const existing = db.sprints.filter((s) => s.repoId === repoId);
  const last = existing.sort((a, b) => a.startDate.localeCompare(b.startDate)).at(-1);

  const start = startDate || (last ? addDays(last.endDate, 1) : isoDate(new Date()));
  const end = endDate || addDays(start, repo.sprintLengthWeeks * 7 - 1);
  const sprint = {
    id: uid(),
    repoId,
    name: name || `Sprint ${existing.length + 1}`,
    startDate: start,
    endDate: end,
    createdAt: new Date().toISOString(),
  };
  db.sprints.push(sprint);
  writeDb(db);
  saveSprintData(sprint.id, emptySprintData());
  return sprint;
}

// ---- per-sprint data (PRs / buckets / reports) ----

export function emptySprintData() {
  return { prs: [], buckets: [], reports: [], llmLog: [], lastSyncAt: null };
}

export function getSprintData(sprintId) {
  return readJson(sprintPath(sprintId), emptySprintData());
}

export function saveSprintData(sprintId, data) {
  writeJson(sprintPath(sprintId), data);
  return data;
}
