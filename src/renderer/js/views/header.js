// Sprint header shared by the Radar and Report views: repo title, sprint
// picker, pipeline actions, and the live task status pill.

import { escapeHtml, timeAgo, sprintProgress } from '../util.js';

export function sprintHeader(state) {
  const d = state.data;
  const { repo, sprint, sprints } = d;
  const progress = sprintProgress(sprint);
  const busy = Boolean(state.task);
  const pending = d.stats?.totals?.byType?.unclassified || 0;

  const sprintOptions = [...sprints]
    .reverse()
    .map((s) =>
      `<option value="${s.id}" ${s.id === sprint.id ? 'selected' : ''}>${escapeHtml(s.name)} · ${s.startDate} → ${s.endDate}</option>`)
    .join('');

  return `
  <header class="topbar">
    <div class="topbar-row">
      <div class="repo-title">
        <h1>${escapeHtml(repo.owner)}<span class="slash">/</span>${escapeHtml(repo.name)}</h1>
        <button class="icon-btn" title="Edit repo & release-cycle prompt" data-action="edit-repo" data-id="${repo.id}">✎</button>
      </div>
      <div class="sprint-controls">
        <select class="select" data-change="select-sprint" ${busy ? 'disabled' : ''}>${sprintOptions}</select>
        <button class="btn ghost" data-action="new-sprint" ${busy ? 'disabled' : ''} title="Start the next cycle">＋ New sprint</button>
        <span class="pill ${progress.ended ? 'warn' : ''}" title="${sprint.startDate} → ${sprint.endDate}">
          ${progress.ended ? '⏹ ended' : `⏱ ${progress.label}`}
        </span>
        <span class="pill muted" title="Last PR sync">synced ${timeAgo(d.lastSyncAt)}</span>
      </div>
    </div>
    <div class="topbar-row">
      <nav class="tabs">
        <button class="tab ${state.view === 'radar' ? 'active' : ''}" data-action="tab" data-view="radar">Radar</button>
        <button class="tab ${state.view === 'report' ? 'active' : ''}" data-action="tab" data-view="report">Report${d.reports.length ? ` (${d.reports.length})` : ''}</button>
        <button class="tab ${state.view === 'prompts' ? 'active' : ''}" data-action="tab" data-view="prompts" title="Every prompt sent to the local LLM, verbatim">Prompts${(d.llmLog || []).length ? ` (${d.llmLog.length})` : ''}</button>
      </nav>
      <div class="actionbar">
        ${busy
          ? `<span class="pill busy"><span class="spinner"></span><span id="task-message">${escapeHtml(state.task.message || 'Working…')}</span></span>`
          : `
        <button class="btn primary" data-action="scan" title="Sync merged PRs, then summarize any not-yet-summarized ones with the local LLM">📡 Scan</button>
        <button class="btn" data-action="gen-report" title="Generate the sprint report (uses MCP tools when configured)">📝 Report</button>
        <details class="more">
          <summary class="btn ghost" title="More pipeline actions">⋯</summary>
          <div class="menu">
            <button class="menu-item" data-action="sync">Sync PRs only</button>
            <button class="menu-item" data-action="summarize-pending" title="Run the local LLM over PRs that are synced but not yet summarized — no re-sync, no wipe">Summarize pending PRs${pending ? ` (${pending})` : ''}</button>
            <button class="menu-item" data-action="reorganize">Reorganize buckets</button>
            <button class="menu-item danger" data-action="recategorize">Re-summarize everything</button>
          </div>
        </details>`}
      </div>
    </div>
  </header>`;
}
