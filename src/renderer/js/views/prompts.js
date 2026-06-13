// The Prompts view: a transparent log of every exchange with the local LLM —
// the exact system/user messages sent (including the repo's release-cycle
// prompt) and the raw response that came back.

import { escapeHtml, formatHours, timeAgo } from '../util.js';

const TASK_COLORS = { summarize: '#4da3ff', reorganize: '#ffd166', report: '#3ddc97' };

export function renderPrompts(state) {
  const log = state.data.llmLog || [];

  if (!log.length) {
    return `
    <section class="card empty-state">
      <h2>No LLM calls yet</h2>
      <p>Every prompt Git Radar sends to Gemma lands here verbatim — per-PR summaries,
      bucket reorganizations, and each report turn (including MCP tool results fed back).
      Run <strong>📡 Scan</strong> or <strong>📝 Report</strong> and the full exchanges will show up,
      newest first. Your repo's release-cycle prompt is embedded in every system message.</p>
    </section>`;
  }

  return `
  <section class="buckets-head">
    <h2>LLM exchanges <span class="muted">${log.length} most recent</span></h2>
    <p class="hint">Verbatim record of what was sent to <code>${escapeHtml(log[0].model || '')}</code> and what came back.
    Per-PR summary and reorganization calls are constrained to a JSON schema; report calls are free-form.</p>
  </section>
  ${log.map(entry).join('')}`;
}

function entry(e) {
  const color = TASK_COLORS[e.task] || '#8a93a6';
  const status = e.error
    ? `<span class="chip defect" title="${escapeHtml(e.error)}">✗ failed</span>`
    : `<span class="chip ok">✓ ${formatDuration(e.durationMs)}</span>`;
  const tokensHint = `${charCount(e)} chars sent`;

  return `
  <details class="card llm-entry">
    <summary class="llm-summary">
      <span class="type-chip" style="--c:${color}">${escapeHtml(e.task)}</span>
      <span class="llm-meta">${escapeHtml(e.meta || '')}</span>
      ${status}
      <span class="spacer"></span>
      <span class="muted" title="${escapeHtml(e.createdAt || '')}">${timeAgo(e.createdAt)} · ${escapeHtml(e.model || '')} · ${tokensHint}</span>
      <button class="btn ghost btn-small" data-action="copy-exchange" data-id="${e.id}">⧉ Copy</button>
    </summary>
    <div class="llm-body">
      ${e.messages.map((m) => block(roleLabel(m.role), m.content)).join('')}
      ${e.error
        ? block('error', e.error, 'err')
        : block('response', e.response || '', 'resp')}
    </div>
  </details>`;
}

function block(label, content, kind = '') {
  return `
  <div class="llm-msg ${kind}">
    <div class="role-label">${escapeHtml(label)}</div>
    <pre class="prompt-pre">${escapeHtml(content)}</pre>
  </div>`;
}

function roleLabel(role) {
  return role === 'system' ? 'system prompt' : role === 'user' ? 'user message' : role;
}

function charCount(e) {
  const n = (e.messages || []).reduce((acc, m) => acc + (m.content?.length || 0), 0);
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90000) return `${(ms / 1000).toFixed(1)}s`;
  return formatHours(ms / 36e5);
}

/** Plain-text rendering of an exchange, for the copy button. */
export function exchangeToText(e) {
  const head = `# ${e.task} — ${e.meta || ''} — ${e.model || ''} — ${e.createdAt || ''}`;
  const msgs = (e.messages || []).map((m) => `## ${m.role}\n${m.content}`);
  const tail = e.error ? `## error\n${e.error}` : `## response\n${e.response || ''}`;
  return [head, ...msgs, tail].join('\n\n');
}
