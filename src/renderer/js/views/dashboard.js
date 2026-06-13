// The Radar view: KPIs, merge timeline, and the buckets-of-work grid.

import { escapeHtml, formatHours, fmtInt, cycleHours } from '../util.js';
import { timelineChart, typeBar, typeChip, TYPE_COLORS } from '../components/charts.js';

export function renderDashboard(state) {
  const d = state.data;
  const { stats } = d;
  return `
    ${kpis(stats)}
    ${pendingBanner(state)}
    <section class="card">
      <h2 class="card-title">Merge timeline <span class="muted">per base branch</span></h2>
      ${timelineChart(stats.timeline)}
    </section>
    ${bucketsSection(state)}
    ${unbucketedSection(state)}
  `;
}

/** Merged PRs a scan would (re)summarize: never-summarized plus prompt-stale. */
function pendingCount(state) {
  return state.data.pendingSummary || 0;
}

/**
 * When some PRs are summarized and others aren't, surface the backlog with a
 * one-click batch action. (When NOTHING is summarized yet, the buckets section
 * carries the same CTA, so we don't double up here.)
 */
function pendingBanner(state) {
  const pending = pendingCount(state);
  if (!pending || !state.data.buckets.length) return '';
  return `
  <section class="card pending-banner">
    <div><strong>${pending} PR${pending === 1 ? '' : 's'} pending summary</strong>
      <span class="muted"> — new, or summarized with an older prompt. A scan re-runs only these.</span></div>
    <span class="spacer"></span>
    <button class="btn primary" data-action="summarize-pending">Summarize ${pending} pending</button>
  </section>`;
}

function kpis(stats) {
  const t = stats.totals;
  const defectHoursTotal = stats.perBucket.reduce((a, b) => a + b.defectHours, 0);
  const cells = [
    ['Merged PRs', fmtInt(t.prs)],
    ['Contributors', fmtInt(t.contributors)],
    ['Features', fmtInt(t.byType.feature || 0)],
    ['Defects', fmtInt(t.byType.defect || 0)],
    ['Defect turnaround', formatHours(defectHoursTotal), 'total open→merge time across defect PRs'],
    ['Behind flags', fmtInt(t.behindFlag)],
    ['Avg PR cycle', formatHours(t.avgCycleHours)],
    ['Churn', `+${fmtInt(t.additions)} / −${fmtInt(t.deletions)}`],
  ];
  return `<section class="kpis">${cells
    .map(([label, value, title]) =>
      `<div class="kpi" ${title ? `title="${escapeHtml(title)}"` : ''}><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`)
    .join('')}</section>`;
}

function bucketsSection(state) {
  const d = state.data;
  if (!d.prs.length) {
    return emptyCard('No PRs yet',
      'Hit <strong>📡 Scan</strong> to pull the PRs merged during this sprint window and let the local LLM organize them into buckets of work.');
  }
  if (!d.buckets.length) {
    const loose = [...d.prs].sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
    return `
    <section class="card">
      <div class="pending-head">
        <h2 class="card-title">${d.prs.length} merged PRs <span class="muted">not summarized yet</span></h2>
        <span class="spacer"></span>
        <button class="btn primary" data-action="summarize-pending">Summarize all ${d.prs.length}</button>
      </div>
      <p class="hint">Run the whole queue through the local LLM at once with the button above —
      or 🔍 inspect any PR to see its diff and discussion, view the generated prompt, and run the summary on just that one.</p>
      <ul class="pr-list">${loose.map((p) => prRow(p, d.buckets)).join('')}</ul>
    </section>`;
  }
  const cards = d.stats.perBucket.map((b) => bucketCard(b, state)).join('');
  return `
    <section class="buckets-head">
      <h2>Buckets of work <span class="muted">${d.buckets.length}</span></h2>
      <p class="hint">Buckets are what the work is <em>about</em> — defects live inside the feature they chase. The LLM reorganizes them as the cycle evolves; drag-free manual moves via each PR's bucket selector.</p>
    </section>
    <section class="buckets">${cards}</section>`;
}

function bucketCard(b, state) {
  const d = state.data;
  const prs = d.prs
    .filter((p) => p.bucketId === b.id)
    .sort((x, y) => String(y.mergedAt).localeCompare(String(x.mergedAt)));
  const expanded = state.expandedBuckets.has(b.id);
  const visible = expanded ? prs : prs.slice(0, 5);

  const chips = [
    `<span class="chip">${b.prCount} PR${b.prCount === 1 ? '' : 's'}</span>`,
    b.defectCount
      ? `<span class="chip defect" title="${b.defectCount} defect PRs · ${b.defectSharePct}% of bucket · total open→merge ${formatHours(b.defectHours)}">🐞 ${formatHours(b.defectHours)}</span>`
      : '',
    b.hiddenFeature
      ? '<span class="chip hidden" title="Every feature PR here is behind a flag or not user-facing — built, but users can\'t see it">🙈 hidden</span>'
      : '',
    ...b.flags.map((f) => `<span class="chip flag" title="feature flag">🚩 ${escapeHtml(f)}</span>`),
  ].join('');

  return `
  <article class="bucket card">
    <div class="bucket-head">
      <h3 title="${escapeHtml(b.description)}">${escapeHtml(b.name)}</h3>
      <button class="icon-btn" title="Rename bucket" data-action="rename-bucket" data-id="${b.id}" data-name="${escapeHtml(b.name)}">✎</button>
      <div class="chips">${chips}</div>
    </div>
    ${b.description ? `<p class="bucket-desc">${escapeHtml(b.description)}</p>` : ''}
    ${typeBar(b.byType, b.prCount)}
    ${typeLegend(b.byType)}
    <ul class="pr-list">${visible.map((p) => prRow(p, d.buckets)).join('')}</ul>
    ${prs.length > 5
      ? `<button class="linklike" data-action="toggle-bucket" data-id="${b.id}">${expanded ? '▴ Show less' : `▾ Show all ${prs.length}`}</button>`
      : ''}
  </article>`;
}

function prRow(p, buckets) {
  const a = p.ann || {};
  const breaking = a.breaking || p.conventional?.breaking;
  const options = [
    `<option value="" ${!p.bucketId ? 'selected' : ''}>(no bucket)</option>`,
    ...buckets.map((b) => `<option value="${b.id}" ${b.id === p.bucketId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`),
  ].join('');

  // Classification tags, most important first. Plain runtime facts go on the
  // dim sub-line below; the verbose `detail` lives in the 🔍 inspector.
  const tags = [
    a.highlight ? `<span class="chip highlight" title="Notable / announce-worthy">★</span>` : '',
    breaking ? '<span class="chip breaking" title="Backward-incompatible change">⚠ breaking</span>' : '',
    a.security ? '<span class="chip security" title="Security fix / hardening">🔒 security</span>' : '',
    a.workType || p.conventional ? typeChip(a.workType || p.conventional.type) : '',
    a.changelogCategory && a.changelogCategory !== 'none'
      ? `<span class="chip cat" title="Keep a Changelog category">${escapeHtml(a.changelogCategory)}</span>` : '',
    a.behindFlag ? `<span class="chip flag" title="behind a feature flag">🚩${a.flagName ? ` ${escapeHtml(a.flagName)}` : ''}</span>` : '',
    a.risk ? `<span class="chip risk-${a.risk}" title="LLM risk read">${escapeHtml(a.risk)} risk</span>` : '',
    p.stale ? '<span class="chip stale" title="Summarized with an older prompt — re-run to refresh">↻ stale</span>' : '',
  ].filter(Boolean).join('');

  // The one scannable line of meaning: product user-impact, else the summary.
  const impact = a.userImpact || a.summary || '';

  const sub = [
    escapeHtml(p.author),
    `→ ${escapeHtml(p.base)}`,
    `<span title="open → merge">${formatHours(cycleHours(p))}</span>`,
    `<span class="muted">+${p.additions}/−${p.deletions}</span>`,
    p.comments?.length ? `<span title="comments + reviews">💬 ${p.comments.length}</span>` : '',
  ].filter(Boolean).join('<span class="dotsep">·</span>');

  return `
  <li class="pr-row">
    <a class="pr-num" href="${escapeHtml(p.url)}" target="_blank" rel="noreferrer">#${p.number}</a>
    <div class="pr-main">
      <div class="pr-title" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</div>
      ${tags ? `<div class="pr-tags">${tags}</div>` : ''}
      ${impact ? `<p class="pr-impact">${escapeHtml(impact)}</p>` : ''}
      <div class="pr-sub">${sub}</div>
    </div>
    <div class="pr-actions">
      <button class="icon-btn" title="Inspect PR: diff, discussion, the generated prompt, and re-run the summary" data-action="inspect-pr" data-pr="${p.number}">🔍</button>
      <select class="select pr-move" data-change="move-pr" data-pr="${p.number}" title="Move to another bucket">${options}</select>
    </div>
  </li>`;
}

/** Compact colour-keyed legend so the type bar isn't a mystery. */
function typeLegend(byType) {
  const items = Object.entries(byType)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<span class="tl-item"><span class="dot" style="background:${TYPE_COLORS[t] || '#555e6e'}"></span>${n} ${escapeHtml(t)}</span>`)
    .join('');
  return items ? `<div class="type-legend">${items}</div>` : '';
}

function unbucketedSection(state) {
  const d = state.data;
  const loose = d.prs.filter((p) => !p.bucketId);
  if (!loose.length || !d.buckets.length) return '';
  return `
  <section class="card">
    <h2 class="card-title">Unbucketed <span class="muted">${loose.length}</span></h2>
    <ul class="pr-list">${loose.map((p) => prRow(p, d.buckets)).join('')}</ul>
  </section>`;
}

function emptyCard(title, bodyHtml) {
  return `
  <section class="card empty-state">
    <h2>${escapeHtml(title)}</h2>
    <p>${bodyHtml}</p>
  </section>`;
}
