// The IPC surface. Every handler returns {ok, data|error} so the renderer
// gets clean error messages instead of Electron's wrapped stack strings.
// Long-running pipeline tasks are serialized through one lock and stream
// progress events to the window.

import { ipcMain } from 'electron';
import * as store from './services/store.js';
import * as github from './services/github.js';
import * as mcp from './services/mcp.js';
import { createOllama } from './services/ollama.js';
import { createAnalyzer } from './services/analyzer.js';
import { createPoller } from './services/poller.js';
import { computeStats } from './services/stats.js';
import { isSummaryStale } from './services/prompts.js';

export function registerIpc(getWindow, appInfo) {
  const ollama = createOllama(() => store.getSettings());
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const emit = (progress) => send('grx:progress', progress);
  const analyzer = createAnalyzer({ store, ollama, github, mcp, emit });

  let runningTask = null;
  const exclusive = (name, fn) => async (...args) => {
    if (runningTask) throw new Error(`Still busy with "${runningTask}" — wait for it to finish.`);
    runningTask = name;
    try {
      return await fn(...args);
    } finally {
      runningTask = null;
    }
  };

  // One scan = sync + per-PR summarize. Shared by the manual button and the poller.
  const scan = exclusive('scan', async (id) => {
    const synced = await analyzer.sync(id);
    const categorized = await analyzer.categorize(id, { force: false });
    return { ...synced, ...categorized };
  });

  // Background "check for updates": polls gh and, when a poll picks up changes,
  // nudges the renderer to refresh the affected sprint.
  const poller = createPoller({
    store,
    scan,
    emit: (p) => {
      emit(p);
      if (p.changed) send('grx:data-changed', { sprintId: p.sprintId });
    },
  });
  poller.apply(store.getSettings());

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    });
  };

  // ---- app / settings / health ----
  handle('app:info', () => ({ ...appInfo, dataDir: store.getDataDir() }));
  handle('settings:get', () => store.getSettings());
  handle('settings:save', (settings) => {
    const saved = store.saveSettings(settings);
    poller.apply(saved); // start/stop/reschedule the background poll
    return saved;
  });
  handle('health:check', async () => {
    const settings = store.getSettings();
    const [gh, ol] = await Promise.all([github.checkGh(), ollama.health()]);
    return { gh, ollama: ol, mcpConfigured: (settings.mcpServers || []).length };
  });
  handle('ollama:models', () => ollama.listModels());
  handle('mcp:test', (server) => mcp.testServer(server));

  // ---- repos / sprints ----
  handle('repos:list', () =>
    store.listRepos().map((r) => ({ ...r, sprints: store.listSprints(r.id) })));
  handle('repo:save', (repo) => store.saveRepo(repo));
  handle('repo:delete', (id) => store.deleteRepo(id));
  handle('sprint:create', (repoId, opts) => store.createSprint(repoId, opts || {}));

  // Everything the dashboard needs for one sprint, in one round trip.
  handle('sprint:data', (sprintId) => {
    const sprint = store.getSprint(sprintId);
    if (!sprint) throw new Error('Sprint not found');
    const repo = store.getRepo(sprint.repoId);
    const data = store.getSprintData(sprintId);
    return {
      sprint,
      repo,
      sprints: store.listSprints(sprint.repoId),
      // `stale` marks a PR summarized with an older prompt (annotated but
      // fingerprint mismatch); pendingSummary counts everything a scan would
      // (re)process — never-summarized plus stale.
      prs: data.prs.map((p) => ({ ...p, stale: Boolean(p.ann) && isSummaryStale(p, repo) })),
      buckets: data.buckets,
      reports: data.reports || [],
      llmLog: data.llmLog || [],
      lastSyncAt: data.lastSyncAt,
      pendingSummary: data.prs.filter((p) => p.mergedAt && isSummaryStale(p, repo)).length,
      stats: computeStats({ sprint, prs: data.prs, buckets: data.buckets }),
    };
  });

  // ---- pipeline (serialized) ----
  handle('sprint:sync', exclusive('sync', (id) => analyzer.sync(id)));
  handle('sprint:categorize', exclusive('categorize', (id, opts) => analyzer.categorize(id, opts || {})));
  handle('sprint:reorganize', exclusive('reorganize', (id) => analyzer.reorganize(id)));
  handle('sprint:report', exclusive('report', (id) => analyzer.generateReport(id)));
  handle('sprint:scan', scan);

  // Per-PR inspector: build the exact prompt (no LLM) + pull diff/discussion,
  // and re-fire the summarizer for one PR to test how it behaves.
  handle('pr:inspect', (sprintId, prNumber) => analyzer.inspectPR(sprintId, prNumber));
  handle('pr:summarize', exclusive('summarize', (sprintId, prNumber) => analyzer.summarizePR(sprintId, prNumber)));

  // ---- manual curation ----
  handle('bucket:rename', (sprintId, bucketId, name) => {
    const data = store.getSprintData(sprintId);
    const bucket = data.buckets.find((b) => b.id === bucketId);
    if (!bucket) throw new Error('Bucket not found');
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('Bucket name cannot be empty');
    bucket.name = trimmed;
    store.saveSprintData(sprintId, data);
    return bucket;
  });

  handle('pr:move', (sprintId, prNumber, bucketId) => {
    const data = store.getSprintData(sprintId);
    const pr = data.prs.find((p) => p.number === prNumber);
    if (!pr) throw new Error('PR not found');
    if (bucketId && !data.buckets.some((b) => b.id === bucketId)) throw new Error('Bucket not found');
    pr.bucketId = bucketId || undefined;
    store.saveSprintData(sprintId, data);
    return pr;
  });
}
