// The Radar view: KPIs, merge timeline, and the buckets-of-work grid.

import { escapeHtml, formatHours, fmtInt, cycleHours } from '../util.js';
import { timelineChart, typeBar, typeChip } from '../components/charts.js';

export function renderDashboard(state) {
  const d = state.data;
  const { stats } = d;
  return `
    ${kpis(stats)}
    <section class="card">
      <h2 class="card-title">Merge timeline <span class="muted">per base branch</span></h2>
      ${timelineChart(stats.timeline)}
    </section>
    ${bucketsSection(state)}
    ${unbucketedSection(state)}
  `;
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
    return emptyCard(`${d.prs.length} merged PRs, not classified yet`,
      'Hit <strong>📡 Scan</strong> (or “Re-classify everything”) to organize them into buckets with the local LLM.');
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
    <ul class="pr-list">${visible.map((p) => prRow(p, d.buckets)).join('')}</ul>
    ${prs.length > 5
      ? `<button class="linklike" data-action="toggle-bucket" data-id="${b.id}">${expanded ? '▴ Show less' : `▾ Show all ${prs.length}`}</button>`
      : ''}
  </article>`;
}

function prRow(p, buckets) {
  const cycle = cycleHours(p);
  const options = [
    `<option value="" ${!p.bucketId ? 'selected' : ''}>(no bucket)</option>`,
    ...buckets.map((b) => `<option value="${b.id}" ${b.id === p.bucketId ? 'selected' : ''}>${escapeHtml(b.name)}</option>`),
  ].join('');
  return `
  <li class="pr-row">
    <a class="pr-num" href="${escapeHtml(p.url)}" target="_blank" rel="noreferrer">#${p.number}</a>
    <div class="pr-main">
      <div class="pr-title" title="${escapeHtml(p.ann?.summary || p.title)}">${escapeHtml(p.title)}</div>
      <div class="pr-meta">
        ${typeChip(p.ann?.workType)}
        ${p.ann?.behindFlag ? `<span class="chip flag">🚩${p.ann.flagName ? ` ${escapeHtml(p.ann.flagName)}` : ''}</span>` : ''}
        <span>${escapeHtml(p.author)}</span>
        <span>→ ${escapeHtml(p.base)}</span>
        <span title="open → merge">${formatHours(cycle)}</span>
        <span class="muted">+${p.additions}/−${p.deletions}</span>
      </div>
    </div>
    <select class="select pr-move" data-change="move-pr" data-pr="${p.number}" title="Move to another bucket">${options}</select>
  </li>`;
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
