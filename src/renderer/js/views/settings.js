// Settings: local LLM (Ollama/Gemma), MCP servers, GitHub CLI status, app info.

import { escapeHtml } from '../util.js';

const MCP_EXAMPLE = JSON.stringify(
  [
    {
      name: 'atlassian',
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse'],
    },
  ],
  null,
  2,
);

export function renderSettings(state) {
  const s = state.settings || {};
  const health = state.health;

  const modelOptions = (state.models || [])
    .map((m) => `<option value="${escapeHtml(m)}"></option>`)
    .join('');

  const ollamaTest = state.ollamaTest
    ? state.ollamaTest.ok
      ? `<span class="chip ok">✓ connected — ${state.models.length} models installed</span>`
      : `<span class="chip defect" title="${escapeHtml(state.ollamaTest.error)}">✗ ${escapeHtml(state.ollamaTest.error)}</span>`
    : '';

  const mcpRows = (s.mcpServers || [])
    .map((srv) => {
      const result = state.mcpTestResults[srv.name];
      const status = result
        ? result.ok
          ? `<span class="chip ok" title="${escapeHtml((result.tools || []).join(', '))}">✓ ${result.tools.length} tools</span>`
          : `<span class="chip defect" title="${escapeHtml(result.error)}">✗ failed</span>`
        : '';
      return `<div class="mcp-row"><code>${escapeHtml(srv.name)}</code>
        <span class="muted">${escapeHtml(srv.command)} ${escapeHtml((srv.args || []).join(' '))}</span>
        <span class="spacer"></span>${status}
        <button class="btn ghost" data-action="test-mcp" data-name="${escapeHtml(srv.name)}">Test</button></div>`;
    })
    .join('');

  const gh = health?.gh;
  const ghStatus = !health
    ? '<span class="muted">checking…</span>'
    : gh.ok && gh.authed
      ? `<span class="chip ok">✓ ${escapeHtml(gh.version || 'gh')} — authenticated</span>`
      : gh.ok
        ? `<span class="chip warn">⚠ gh installed but not authenticated — run <code>gh auth login</code></span>`
        : `<span class="chip defect">✗ ${escapeHtml(gh.error || 'gh not found')}</span>`;

  return `
  <header class="topbar"><div class="topbar-row">
    <div class="repo-title"><h1>Settings</h1></div>
    ${state.data ? '<button class="btn ghost" data-action="tab" data-view="radar">← Back to radar</button>' : ''}
  </div></header>

  <section class="card">
    <h2 class="card-title">Local LLM <span class="muted">Ollama</span></h2>
    <div class="form-grid">
      <label>Ollama URL
        <input class="input" id="set-ollama-url" value="${escapeHtml(s.ollamaUrl || '')}" placeholder="http://localhost:11434" />
      </label>
      <label>Model
        <input class="input" id="set-ollama-model" list="model-list" value="${escapeHtml(s.ollamaModel || '')}" placeholder="gemma3:12b" />
        <datalist id="model-list">${modelOptions}</datalist>
      </label>
      <label>Context window (num_ctx)
        <input class="input" id="set-numctx" type="number" min="2048" step="1024" value="${Number(s.numCtx) || 16384}" />
      </label>
      <label>Temperature
        <input class="input" id="set-temp" type="number" min="0" max="1" step="0.1" value="${Number.isFinite(Number(s.temperature)) ? Number(s.temperature) : 0.2}" />
      </label>
      <label>Summaries in parallel
        <input class="input" id="set-concurrency" type="number" min="1" max="8" step="1" value="${Number(s.summaryConcurrency) || 1}" />
      </label>
    </div>
    <div class="form-actions">
      <button class="btn ghost" data-action="test-ollama">Test connection</button>
      ${ollamaTest}
    </div>
    <p class="hint">Pull the model first: <code>ollama pull gemma3:12b</code> (or <code>gemma3:4b</code> on lighter machines).
    Per-PR summaries use JSON-schema-constrained outputs, so smaller Gemma variants stay parseable — they're just less nuanced.</p>
    <p class="hint"><strong>Summaries in parallel</strong> is how many PRs Git Radar summarizes at once — <code>1</code> means strictly one at a time.
    Raise it only if your Ollama serves concurrent requests (<code>OLLAMA_NUM_PARALLEL</code>); on a single local model, higher values usually just contend for the GPU.</p>
  </section>

  <section class="card">
    <h2 class="card-title">MCP servers <span class="muted">planning context</span></h2>
    <p class="hint">Git Radar is an MCP client. Configure stdio servers (JSON array of
    <code>{name, command, args, env?}</code>) and the report generator lets the LLM call their tools —
    e.g. pull sprint priorities from Jira to write the “planned vs. actual” section.</p>
    <textarea class="input mono" id="set-mcp" rows="8" spellcheck="false"
      placeholder='${escapeHtml(MCP_EXAMPLE)}'>${escapeHtml(JSON.stringify(s.mcpServers || [], null, 2))}</textarea>
    ${mcpRows ? `<div class="mcp-list">${mcpRows}</div>` : ''}
    <p class="hint">Example (Atlassian): <code>${escapeHtml(MCP_EXAMPLE.replace(/\n\s*/g, ' '))}</code></p>
  </section>

  <section class="card">
    <h2 class="card-title">GitHub CLI</h2>
    <div class="form-actions">${ghStatus}
      <button class="btn ghost" data-action="recheck-health">Re-check</button>
    </div>
    <p class="hint">All GitHub access goes through <code>gh</code> — Git Radar never stores tokens.</p>
  </section>

  <section class="card">
    <h2 class="card-title">Auto-poll <span class="muted">background merge checks</span></h2>
    <p class="hint">Git Radar is local-first with no public endpoint, so it can't receive GitHub webhooks.
    Instead it polls <code>gh</code> on an interval and runs a scan (sync + per-PR summary) on the sprint
    that's currently live — so new merges are already summarized when you sit down to plan.</p>
    <div class="form-grid">
      <label class="check">
        <input type="checkbox" id="set-autopoll" ${s.autoPoll ? 'checked' : ''} />
        Check for new merges automatically
      </label>
      <label>Interval (minutes)
        <input class="input" id="set-autopoll-mins" type="number" min="1" step="1" value="${Number(s.autoPollMinutes) || 15}" />
      </label>
    </div>
  </section>

  <div class="form-actions sticky-save">
    <button class="btn primary" data-action="settings-save">Save settings</button>
    ${state.appInfo ? `<span class="muted">data: ${escapeHtml(state.appInfo.dataDir || '')} · electron ${escapeHtml(state.appInfo.electron || '')}</span>` : ''}
  </div>`;
}
