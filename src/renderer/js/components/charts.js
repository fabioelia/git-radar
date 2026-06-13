// Dependency-free SVG/DIV charts.

import { escapeHtml } from '../util.js';

export const TYPE_COLORS = {
  feature: '#3ddc97',
  defect: '#ff6b6b',
  chore: '#8a93a6',
  infra: '#4da3ff',
  docs: '#c792ea',
  test: '#ffd166',
  refactor: '#f4a261',
  release: '#9aa5ce',
  unclassified: '#555e6e',
};

const BRANCH_PALETTE = ['#4da3ff', '#3ddc97', '#ffd166', '#ff6b6b', '#c792ea', '#f4a261', '#9aa5ce', '#7ee8fa'];

export function branchColor(branches, branch) {
  return BRANCH_PALETTE[Math.max(0, branches.indexOf(branch)) % BRANCH_PALETTE.length];
}

/** Stacked merges-per-day columns, one color per base branch. */
export function timelineChart(timeline) {
  const { branches, days } = timeline;
  const total = days.reduce((acc, d) => acc + Object.values(d.byBase).reduce((a, n) => a + n, 0), 0);
  if (!days.length || !total) {
    return '<div class="empty-mini">No merges recorded in this window yet.</div>';
  }

  const bw = 14;
  const gap = 5;
  const chartH = 110;
  const labelH = 22;
  const W = days.length * (bw + gap) + gap;
  const H = chartH + labelH;
  const max = Math.max(1, ...days.map((d) => Object.values(d.byBase).reduce((a, n) => a + n, 0)));

  const rects = [];
  days.forEach((d, i) => {
    const x = gap + i * (bw + gap);
    let y = chartH;
    const dayTotal = Object.values(d.byBase).reduce((a, n) => a + n, 0);
    for (const b of branches) {
      const n = d.byBase[b] || 0;
      if (!n) continue;
      const h = Math.max(2, (n / max) * (chartH - 8));
      y -= h;
      rects.push(
        `<rect x="${x}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="2" fill="${branchColor(branches, b)}">` +
        `<title>${escapeHtml(d.date)} — ${n} into ${escapeHtml(b)} (${dayTotal} total)</title></rect>`,
      );
    }
    if (!dayTotal) {
      rects.push(`<rect x="${x}" y="${chartH - 2}" width="${bw}" height="2" rx="1" fill="#262d37"/>`);
    }
  });

  const every = Math.max(1, Math.ceil(days.length / 12));
  const labels = days
    .map((d, i) => {
      if (i % every !== 0) return '';
      const x = gap + i * (bw + gap) + bw / 2;
      return `<text x="${x}" y="${chartH + 15}" text-anchor="middle" class="axis-label">${escapeHtml(d.date.slice(5))}</text>`;
    })
    .join('');

  const legend = branches
    .map((b) => `<span class="legend-item"><span class="dot" style="background:${branchColor(branches, b)}"></span>${escapeHtml(b)}</span>`)
    .join('');

  return `
    <div class="timeline-scroll"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">${rects.join('')}${labels}</svg></div>
    <div class="legend">${legend}<span class="legend-item muted">peak ${max}/day</span></div>`;
}

/** Tiny stacked bar of work types inside a bucket card. */
export function typeBar(byType, total) {
  if (!total) return '';
  const segs = Object.entries(byType)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) =>
      `<span class="typebar-seg" style="width:${((n / total) * 100).toFixed(1)}%;background:${TYPE_COLORS[type] || '#555e6e'}" title="${escapeHtml(type)}: ${n}"></span>`)
    .join('');
  return `<div class="typebar">${segs}</div>`;
}

export function typeChip(type) {
  const t = type || 'unclassified';
  return `<span class="type-chip" style="--c:${TYPE_COLORS[t] || '#555e6e'}">${escapeHtml(t)}</span>`;
}
