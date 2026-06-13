// The Report view: generated sprint reports with history and MCP tool trail.

import { escapeHtml } from '../util.js';
import { renderMarkdown } from '../components/markdown.js';

export function renderReport(state) {
  const d = state.data;
  const reports = d.reports || [];

  if (!reports.length) {
    return `
    <section class="card empty-state">
      <h2>No report yet for ${escapeHtml(d.sprint.name)}</h2>
      <p>Generate one with <strong>📝 Report</strong> above. The local LLM writes it from the bucket
      statistics plus a deterministic ledger of every merged PR — titles, authors and changed files${state.settings?.mcpServers?.length
        ? ', and can call your configured MCP tools (e.g. Jira) to compare planned vs. actual'
        : ''}.
      Classifying your PRs first sharpens the buckets, but the report stays grounded either way.</p>
    </section>`;
  }

  const idx = Math.min(state.reportIndex, reports.length - 1);
  const report = reports[idx];
  const options = reports
    .map((r, i) => `<option value="${i}" ${i === idx ? 'selected' : ''}>${new Date(r.createdAt).toLocaleString()}</option>`)
    .join('');

  const toolTrail = (report.toolCalls || []).length
    ? `<div class="tool-trail">MCP calls: ${report.toolCalls
        .map((t) => `<span class="chip ${t.ok ? '' : 'defect'}" title="${escapeHtml(t.error || 'ok')}">${t.ok ? '✓' : '✗'} ${escapeHtml(t.name)}</span>`)
        .join(' ')}</div>`
    : '';

  return `
  <section class="card report-card">
    <div class="report-toolbar">
      <select class="select" data-change="select-report">${options}</select>
      <span class="spacer"></span>
      <button class="btn ghost" data-action="copy-report" title="Copy markdown to clipboard">⧉ Copy markdown</button>
    </div>
    ${toolTrail}
    <article class="md">${renderMarkdown(report.markdown)}</article>
  </section>`;
}
