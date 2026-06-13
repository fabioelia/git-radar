// State + actions + render loop. Views are pure HTML-string renderers;
// interaction flows through two delegated listeners via data-action /
// data-change attributes.

import { api } from './api.js';
import { escapeHtml } from './util.js';
import { sprintHeader } from './views/header.js';
import { renderDashboard } from './views/dashboard.js';
import { renderReport } from './views/report.js';
import { renderPrompts, exchangeToText } from './views/prompts.js';
import { renderSettings } from './views/settings.js';
import { renderInspector } from './views/inspector.js';

const state = {
  appInfo: null,
  settings: null,
  health: null,
  repos: [],
  currentRepoId: null,
  currentSprintId: null,
  data: null, // payload of sprint:data
  view: 'radar', // radar | report | settings
  task: null, // {name, message}
  modal: null, // {type: 'repo'|'rename-bucket', ...}
  expandedBuckets: new Set(),
  reportIndex: 0,
  models: [],
  ollamaTest: null,
  mcpTestResults: {},
};

const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast-root');

// ---------- rendering ----------

function render() {
  const prevScroll = $app.querySelector('.main')?.scrollTop || 0;
  $app.innerHTML = `
    <aside class="sidebar">${sidebar()}</aside>
    <main class="main">${mainView()}</main>`;
  const main = $app.querySelector('.main');
  if (main) main.scrollTop = prevScroll;
  $modal.innerHTML = state.modal ? modalHtml() : '';
  const focus = $modal.querySelector('[data-autofocus]');
  if (focus) focus.focus();
}

function sidebar() {
  const repoItems = state.repos
    .map((r) => `
      <button class="repo-item ${r.id === state.currentRepoId ? 'active' : ''}" data-action="select-repo" data-id="${r.id}">
        <span class="repo-name">${escapeHtml(r.name)}</span>
        <span class="repo-owner">${escapeHtml(r.owner)}</span>
      </button>`)
    .join('');

  return `
    <div class="brand"><span class="brand-icon">📡</span> Git Radar</div>
    <div class="repo-list">${repoItems}</div>
    <button class="btn ghost add-repo" data-action="add-repo">＋ Add repository</button>
    <div class="sidebar-footer">
      ${healthDots()}
      <button class="icon-btn" title="Settings" data-action="open-settings">⚙</button>
    </div>`;
}

function healthDots() {
  const h = state.health;
  const dot = (cls, label, title) =>
    `<span class="health" title="${escapeHtml(title)}"><span class="dot ${cls}"></span>${label}</span>`;
  if (!h) return `${dot('gray', 'gh', 'checking…')}${dot('gray', 'llm', 'checking…')}`;
  const ghCls = h.gh.ok && h.gh.authed ? 'ok' : h.gh.ok ? 'warn' : 'bad';
  const ghTitle = h.gh.ok && h.gh.authed ? h.gh.version || 'gh ready' : h.gh.error || 'run `gh auth login`';
  const olCls = h.ollama.ok && h.ollama.hasModel ? 'ok' : h.ollama.ok ? 'warn' : 'bad';
  const olTitle = h.ollama.ok
    ? h.ollama.hasModel
      ? `Ollama up · ${h.ollama.model}`
      : `Ollama up, but "${h.ollama.model}" is not pulled`
    : h.ollama.error || 'Ollama unreachable';
  return `${dot(ghCls, 'gh', ghTitle)}${dot(olCls, 'llm', olTitle)}${
    h.mcpConfigured ? dot('ok', `mcp×${h.mcpConfigured}`, `${h.mcpConfigured} MCP server(s) configured`) : ''}`;
}

function mainView() {
  if (state.view === 'settings') return renderSettings(state);
  if (!state.repos.length) {
    return `
    <section class="hero">
      <h1>📡 Git Radar</h1>
      <p>Track what your team <em>actually</em> shipped each release cycle. Merged PRs come in through
      the GitHub CLI, a local Gemma LLM organizes them into buckets of work, and at the end of the
      sprint you get the story: defect-chasing time per feature, work hidden behind flags, release
      mechanics, planned vs. actual.</p>
      <button class="btn primary" data-action="add-repo">＋ Track your first repository</button>
    </section>`;
  }
  if (!state.data) return '<section class="card empty-state"><h2>Pick a repository</h2></section>';
  const body = state.view === 'report'
    ? renderReport(state)
    : state.view === 'prompts'
      ? renderPrompts(state)
      : renderDashboard(state);
  return `${sprintHeader(state)}${body}`;
}

function modalHtml() {
  if (state.modal.type === 'pr-inspect') return renderInspector(state.modal);

  if (state.modal.type === 'rename-bucket') {
    return `
    <div class="modal-backdrop" data-action="modal-close">
      <div class="modal" data-action="noop">
        <h2>Rename bucket</h2>
        <input class="input" id="rename-input" data-autofocus value="${escapeHtml(state.modal.name)}" />
        <div class="form-actions">
          <button class="btn primary" data-action="rename-bucket-save">Rename</button>
          <button class="btn ghost" data-action="modal-close">Cancel</button>
        </div>
      </div>
    </div>`;
  }

  const repo = state.modal.repoId ? state.repos.find((r) => r.id === state.modal.repoId) : null;
  const promptPlaceholder = 'e.g. The newton monorepo releases every 3 weeks. General development merges into develop; '
    + 'at code freeze we start merging develop into stage; we release by merging stage into main. '
    + 'Feature work is usually gated behind LaunchDarkly flags (ld-*). Squads: checkout, payments, growth.';
  return `
  <div class="modal-backdrop" data-action="modal-close">
    <div class="modal wide" data-action="noop">
      <h2>${repo ? `Edit ${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}` : 'Track a repository'}</h2>
      <label>Repository <span class="muted">owner/name</span>
        <input class="input" id="repo-slug" data-autofocus placeholder="acme/newton" value="${repo ? escapeHtml(`${repo.owner}/${repo.name}`) : ''}" />
      </label>
      <label>Release-cycle prompt <span class="muted">how this repo ships — the LLM reads this on every pass</span>
        <textarea class="input" id="repo-prompt" rows="7" placeholder="${escapeHtml(promptPlaceholder)}">${repo ? escapeHtml(repo.contextPrompt) : ''}</textarea>
      </label>
      <div class="form-grid">
        <label>Cycle length (weeks)
          <input class="input" id="repo-weeks" type="number" min="1" max="12" value="${repo ? repo.sprintLengthWeeks : 3}" />
        </label>
        <label>Tracked base branches <span class="muted">optional, comma-separated; empty = all</span>
          <input class="input" id="repo-branches" placeholder="develop, stage, main" value="${repo ? escapeHtml(repo.trackedBranches.join(', ')) : ''}" />
        </label>
        ${repo ? '' : `
        <label>Current sprint started on
          <input class="input" id="repo-start" type="date" value="${new Date().toISOString().slice(0, 10)}" />
        </label>`}
      </div>
      <div class="form-actions">
        <button class="btn primary" data-action="repo-save" ${repo ? `data-id="${repo.id}"` : ''}>${repo ? 'Save' : 'Start tracking'}</button>
        <button class="btn ghost" data-action="modal-close">Cancel</button>
        <span class="spacer"></span>
        ${repo ? `<button class="btn danger" data-action="repo-delete" data-id="${repo.id}">Delete repo</button>` : ''}
      </div>
    </div>
  </div>`;
}

function toast(kind, text) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $toast.appendChild(el);
  setTimeout(() => el.remove(), 6500);
}

// ---------- data loading ----------

async function loadRepos() {
  state.repos = await api.reposList();
}

async function refreshData() {
  if (!state.currentSprintId) {
    state.data = null;
    return;
  }
  try {
    state.data = await api.sprintData(state.currentSprintId);
    state.currentRepoId = state.data.repo.id;
  } catch (e) {
    state.data = null;
    state.currentSprintId = null;
    toast('error', e.message);
  }
}

async function selectSprint(sprintId) {
  state.currentSprintId = sprintId;
  state.expandedBuckets = new Set();
  state.reportIndex = 0;
  localStorage.setItem('grx:sprint', sprintId || '');
  await refreshData();
  if (state.view === 'settings') state.view = 'radar';
  render();
}

async function selectRepo(repoId) {
  state.currentRepoId = repoId;
  const repo = state.repos.find((r) => r.id === repoId);
  const latest = repo?.sprints?.at(-1);
  await selectSprint(latest ? latest.id : null);
}

async function runTask(name, fn) {
  if (state.task) {
    toast('warn', `Still busy with ${state.task.name}…`);
    return;
  }
  state.task = { name, message: 'Starting…' };
  render();
  try {
    await fn();
  } catch (e) {
    toast('error', e.message);
  } finally {
    state.task = null;
    await refreshData();
    render();
  }
}

// ---------- actions ----------

const actions = {
  noop: (_el, e) => e.stopPropagation(),

  'select-repo': (el) => selectRepo(el.dataset.id),
  'open-settings': () => {
    state.view = 'settings';
    render();
  },
  tab: (el) => {
    state.view = el.dataset.view;
    render();
  },

  'new-sprint': async () => {
    const sprint = await api.sprintCreate(state.currentRepoId, {});
    await loadRepos();
    toast('ok', `Started ${sprint.name} (${sprint.startDate} → ${sprint.endDate})`);
    await selectSprint(sprint.id);
  },

  scan: () =>
    runTask('scan', async () => {
      const r = await api.sprintScan(state.currentSprintId);
      toast('ok', `Scan done: ${r.added} new PR${r.added === 1 ? '' : 's'}, ${r.classified} classified, ${r.buckets} buckets${r.autoReorganized ? ' (auto-reorganized)' : ''}`);
    }),
  sync: () =>
    runTask('sync', async () => {
      const r = await api.sprintSync(state.currentSprintId);
      toast('ok', `Synced: ${r.added} new, ${r.total} total merged PRs`);
    }),
  recategorize: () => {
    if (!window.confirm('Re-classify ALL PRs from scratch? Buckets for this sprint will be rebuilt.')) return;
    runTask('classify', async () => {
      const r = await api.sprintCategorize(state.currentSprintId, { force: true });
      toast('ok', `Re-classified ${r.classified} PRs into ${r.buckets} buckets`);
    });
  },
  reorganize: () =>
    runTask('reorganize', async () => {
      const r = await api.sprintReorganize(state.currentSprintId);
      toast('ok', r.operations ? `Applied ${r.operations} bucket operations` : 'Buckets already coherent');
    }),
  'gen-report': () =>
    runTask('report', async () => {
      await api.sprintReport(state.currentSprintId);
      state.view = 'report';
      state.reportIndex = 0;
      toast('ok', 'Sprint report generated');
    }),

  'toggle-bucket': (el) => {
    const id = el.dataset.id;
    if (state.expandedBuckets.has(id)) state.expandedBuckets.delete(id);
    else state.expandedBuckets.add(id);
    render();
  },
  'rename-bucket': (el) => {
    state.modal = { type: 'rename-bucket', bucketId: el.dataset.id, name: el.dataset.name };
    render();
  },
  'rename-bucket-save': async () => {
    const name = document.getElementById('rename-input')?.value;
    await api.bucketRename(state.currentSprintId, state.modal.bucketId, name);
    state.modal = null;
    await refreshData();
    render();
  },

  'inspect-pr': async (el) => {
    const prNumber = Number(el.dataset.pr);
    state.modal = { type: 'pr-inspect', prNumber, loading: true };
    render();
    try {
      state.modal.data = await api.prInspect(state.currentSprintId, prNumber);
    } catch (e) {
      state.modal.error = e.message;
    }
    if (state.modal?.type === 'pr-inspect') state.modal.loading = false;
    render();
  },
  'run-pr-summary': async (el) => {
    if (state.modal?.type !== 'pr-inspect') return;
    const prNumber = Number(el.dataset.pr);
    state.modal.running = true;
    render();
    try {
      const res = await api.prSummarize(state.currentSprintId, prNumber);
      state.modal.result = { content: res.content };
      state.modal.data = await api.prInspect(state.currentSprintId, prNumber); // refresh prompt + current summary
      await refreshData();
      toast('ok', `PR #${prNumber} summarized`);
    } catch (e) {
      toast('error', e.message);
    } finally {
      if (state.modal?.type === 'pr-inspect') state.modal.running = false;
      render();
    }
  },
  'copy-prompt': async () => {
    const msgs = state.modal?.data?.messages || [];
    if (!msgs.length) return;
    await navigator.clipboard.writeText(msgs.map((m) => `## ${m.role}\n${m.content}`).join('\n\n'));
    toast('ok', 'Prompt copied');
  },

  'add-repo': () => {
    state.modal = { type: 'repo' };
    render();
  },
  'edit-repo': (el) => {
    state.modal = { type: 'repo', repoId: el.dataset.id };
    render();
  },
  'modal-close': () => {
    state.modal = null;
    render();
  },
  'repo-save': async (el) => {
    const payload = {
      id: el.dataset.id || undefined,
      slug: document.getElementById('repo-slug')?.value || '',
      contextPrompt: document.getElementById('repo-prompt')?.value || '',
      sprintLengthWeeks: document.getElementById('repo-weeks')?.value || 3,
      trackedBranches: (document.getElementById('repo-branches')?.value || '')
        .split(',').map((b) => b.trim()).filter(Boolean),
      firstSprintStart: document.getElementById('repo-start')?.value || undefined,
    };
    const saved = await api.repoSave(payload);
    state.modal = null;
    await loadRepos();
    toast('ok', `Tracking ${saved.owner}/${saved.name}`);
    if (state.currentRepoId !== saved.id) await selectRepo(saved.id);
    else {
      await refreshData();
      render();
    }
  },
  'repo-delete': async (el) => {
    const repo = state.repos.find((r) => r.id === el.dataset.id);
    if (!window.confirm(`Stop tracking ${repo?.owner}/${repo?.name}? Its sprint data will be deleted.`)) return;
    await api.repoDelete(el.dataset.id);
    state.modal = null;
    await loadRepos();
    state.currentRepoId = null;
    state.currentSprintId = null;
    state.data = null;
    if (state.repos.length) await selectRepo(state.repos[0].id);
    else render();
  },

  'settings-save': async () => {
    let mcpServers;
    try {
      mcpServers = JSON.parse(document.getElementById('set-mcp')?.value || '[]');
      if (!Array.isArray(mcpServers)) throw new Error('must be a JSON array');
      for (const s of mcpServers) {
        if (!s.name || !s.command) throw new Error('each server needs "name" and "command"');
      }
    } catch (e) {
      toast('error', `MCP config: ${e.message}`);
      return;
    }
    const temp = Number(document.getElementById('set-temp')?.value);
    state.settings = await api.settingsSave({
      ollamaUrl: document.getElementById('set-ollama-url')?.value?.trim(),
      ollamaModel: document.getElementById('set-ollama-model')?.value?.trim(),
      numCtx: Number(document.getElementById('set-numctx')?.value) || 16384,
      temperature: Number.isFinite(temp) ? temp : 0.2,
      mcpServers,
      autoPoll: document.getElementById('set-autopoll')?.checked || false,
      autoPollMinutes: Number(document.getElementById('set-autopoll-mins')?.value) || 15,
    });
    toast('ok', 'Settings saved');
    api.healthCheck().then((h) => {
      state.health = h;
      render();
    }).catch(() => {});
  },
  'test-ollama': async () => {
    try {
      state.models = await api.ollamaModels();
      state.ollamaTest = { ok: true };
    } catch (e) {
      state.ollamaTest = { ok: false, error: e.message };
    }
    render();
  },
  'test-mcp': async (el) => {
    const server = (state.settings.mcpServers || []).find((s) => s.name === el.dataset.name);
    if (!server) return;
    state.mcpTestResults[server.name] = { ok: false, error: 'testing…', tools: [] };
    render();
    state.mcpTestResults[server.name] = await api.mcpTest(server);
    render();
  },
  'recheck-health': async () => {
    state.health = await api.healthCheck();
    render();
  },

  'copy-exchange': async (el, e) => {
    e.preventDefault(); // the button lives inside a <summary> — don't toggle it
    e.stopPropagation();
    const entry = (state.data?.llmLog || []).find((x) => x.id === el.dataset.id);
    if (entry) {
      await navigator.clipboard.writeText(exchangeToText(entry));
      toast('ok', 'Exchange copied as text');
    }
  },

  'copy-report': async () => {
    const report = state.data?.reports?.[Math.min(state.reportIndex, (state.data?.reports?.length || 1) - 1)];
    if (report) {
      await navigator.clipboard.writeText(report.markdown || '');
      toast('ok', 'Report markdown copied');
    }
  },
};

const changes = {
  'select-sprint': (el) => selectSprint(el.value),
  'select-report': (el) => {
    state.reportIndex = Number(el.value) || 0;
    render();
  },
  'move-pr': async (el) => {
    await api.prMove(state.currentSprintId, Number(el.dataset.pr), el.value || null);
    await refreshData();
    render();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const handler = actions[el.dataset.action];
  if (!handler) return;
  try {
    await handler(el, e);
  } catch (err) {
    toast('error', err.message);
    render();
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  try {
    await changes[el.dataset.change]?.(el);
  } catch (err) {
    toast('error', err.message);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.modal) {
    state.modal = null;
    render();
  }
  if (e.key === 'Enter' && state.modal?.type === 'rename-bucket') {
    actions['rename-bucket-save']().catch((err) => toast('error', err.message));
  }
});

// ---------- init ----------

async function init() {
  try {
    [state.appInfo, state.settings] = await Promise.all([
      api.appInfo().catch(() => null),
      api.settingsGet(),
    ]);
    await loadRepos();

    const saved = localStorage.getItem('grx:sprint');
    const all = state.repos.flatMap((r) => r.sprints.map((s) => ({ ...s, repoId: r.id })));
    const target = all.find((s) => s.id === saved) || state.repos[0]?.sprints?.at(-1);
    if (target) {
      state.currentRepoId = target.repoId;
      state.currentSprintId = target.id;
      await refreshData();
    }
    render();

    api.healthCheck().then((h) => {
      state.health = h;
      render();
    }).catch(() => {});

    api.onProgress((p) => {
      if (state.task && p.message) {
        state.task.message = p.message;
        const el = document.getElementById('task-message');
        if (el) el.textContent = p.message;
      }
    });

    // Background auto-poll picked up new merges — refresh if it's the sprint on screen.
    api.onDataChanged(async (p) => {
      if (state.task || state.modal) return; // don't disrupt an in-progress run or open modal
      if (p?.sprintId && p.sprintId === state.currentSprintId) {
        await refreshData();
        render();
        toast('ok', 'Auto-poll picked up new merges');
      }
    });
  } catch (e) {
    document.getElementById('app').innerHTML =
      `<section class="hero"><h1>Git Radar failed to start</h1><p>${escapeHtml(e.message)}</p></section>`;
  }
}

init();
