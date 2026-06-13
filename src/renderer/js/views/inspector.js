// The per-PR inspector modal: the raw material (diff + discussion), the exact
// prompt Git Radar generates for this PR, and a control to fire the summarizer
// on demand and watch how it behaves — without leaving the radar.

import { escapeHtml, formatHours, cycleHours } from '../util.js';

export function renderInspector(modal) {
  const m = modal;
  const title = m.data?.pr
    ? `#${m.data.pr.number} ${escapeHtml(m.data.pr.title)}`
    : `#${escapeHtml(String(m.prNumber))}`;

  return `
  <div class="modal-backdrop" data-action="modal-close">
    <div class="modal wide inspector" data-action="noop">
      <div class="inspector-head">
        <h2>${title}</h2>
        <button class="icon-btn" data-action="modal-close" title="Close">✕</button>
      </div>
      ${m.loading ? '<p class="muted">Loading diff, discussion and the generated prompt…</p>' : body(m)}
    </div>
  </div>`;
}

function body(m) {
  if (m.error) return `<p class="chip defect">✗ ${escapeHtml(m.error)}</p>`;
  const { pr, bucket, messages, diff } = m.data;
  return `
    ${annBlock(pr, bucket, m)}
    ${promptBlock(messages)}
    ${discussionBlock(pr)}
    ${diffBlock(diff)}`;
}

function annBlock(pr, bucket, m) {
  const a = pr.ann;
  const meta = [
    `${escapeHtml(pr.author)}`,
    `${escapeHtml(pr.base)} ← ${escapeHtml(pr.head || '?')}`,
    `+${pr.additions}/−${pr.deletions} in ${pr.changedFiles} files`,
    `open→merge ${formatHours(cycleHours(pr))}`,
  ].join(' · ');

  const current = a
    ? `<div class="ann-card">
        <div class="ann-row">
          ${a.highlight ? '<span class="chip highlight" title="Notable / announce-worthy">★ highlight</span>' : ''}
          <span class="chip">${escapeHtml(a.workType || '?')}</span>
          <span class="chip">${a.userFacing ? 'user-facing' : 'internal'}</span>
          ${bucket ? `<span class="chip">${escapeHtml(bucket.name)}</span>` : '<span class="muted">no bucket</span>'}
          ${a.risk ? `<span class="chip risk-${a.risk}">${escapeHtml(a.risk)} risk</span>` : ''}
          ${a.behindFlag ? `<span class="chip flag">🚩${a.flagName ? ` ${escapeHtml(a.flagName)}` : ''}</span>` : ''}
        </div>
        ${a.summary ? `<p class="ann-summary">${escapeHtml(a.summary)}</p>` : ''}
        ${a.userImpact ? `<p class="ann-impact"><strong>User impact:</strong> ${escapeHtml(a.userImpact)}</p>` : ''}
        ${a.detail ? `<p class="ann-detail">${escapeHtml(a.detail)}</p>` : ''}
      </div>`
    : '<p class="muted">Not summarized yet.</p>';

  return `
    <section class="inspector-section">
      <div class="inspector-section-head">
        <h3>Current summary</h3>
        <span class="spacer"></span>
        <a class="btn ghost" href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">Open on GitHub ↗</a>
        <button class="btn primary" data-action="run-pr-summary" data-pr="${pr.number}" ${m.running ? 'disabled' : ''}>
          ${m.running ? 'Summarizing…' : a ? '↻ Re-run summary' : '▶ Run summary'}
        </button>
      </div>
      <p class="muted">${meta}</p>
      ${current}
      ${m.result ? resultBlock(m.result) : ''}
    </section>`;
}

function resultBlock(result) {
  return `
    <details class="inspector-details" open>
      <summary>Latest run — raw model response</summary>
      <pre class="code-block">${escapeHtml(result.content || '')}</pre>
    </details>`;
}

function promptBlock(messages) {
  const rows = (messages || [])
    .map((msg) => `
      <div class="prompt-msg">
        <div class="prompt-role">${escapeHtml(msg.role)}</div>
        <pre class="code-block">${escapeHtml(msg.content)}</pre>
      </div>`)
    .join('');
  return `
    <section class="inspector-section">
      <div class="inspector-section-head">
        <h3>Generated prompt</h3>
        <span class="spacer"></span>
        <button class="btn ghost" data-action="copy-prompt" title="Copy the full prompt">⧉ Copy prompt</button>
      </div>
      <p class="hint">Exactly what gets sent to the local model for this PR, schema-constrained to the summary fields.</p>
      ${rows}
    </section>`;
}

function discussionBlock(pr) {
  const comments = pr.comments || [];
  if (!comments.length) {
    return '<section class="inspector-section"><h3>Discussion</h3><p class="muted">No comments or reviews captured on this PR.</p></section>';
  }
  const rows = comments
    .map((c) => {
      const tag = c.kind === 'review'
        ? `review · ${escapeHtml(c.state || 'commented')}`
        : c.kind === 'review_comment'
          ? `inline${c.path ? ` · ${escapeHtml(c.path)}` : ''}`
          : 'comment';
      return `<li><span class="chip">${tag}</span> <strong>${escapeHtml(c.author)}</strong>
        <div class="comment-body">${escapeHtml(c.body || '')}</div></li>`;
    })
    .join('');
  return `
    <section class="inspector-section">
      <h3>Discussion <span class="muted">${comments.length}</span></h3>
      <ul class="comment-list">${rows}</ul>
    </section>`;
}

function diffBlock(diff) {
  if (!diff || diff.error) {
    return `<section class="inspector-section"><h3>Diff</h3><p class="muted">${
      diff?.error ? `Could not load diff: ${escapeHtml(diff.error)}` : 'Diff unavailable.'}</p></section>`;
  }
  const note = diff.truncated
    ? `<p class="hint">Showing the first ${Math.round(diff.diff.length / 1000)}k of ${Math.round(diff.totalChars / 1000)}k characters.</p>`
    : '';
  return `
    <section class="inspector-section">
      <details class="inspector-details">
        <summary>Diff <span class="muted">${Math.round(diff.totalChars / 1000)}k chars</span></summary>
        ${note}
        <pre class="code-block diff">${escapeHtml(diff.diff || '(empty diff)')}</pre>
      </details>
    </section>`;
}
