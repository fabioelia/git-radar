export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function formatHours(h) {
  if (h == null || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.round(mins)}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 60 / 24)}d ago`;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Where are we inside the sprint window? */
export function sprintProgress(sprint) {
  const total = Math.max(1, Math.round(
    (new Date(`${sprint.endDate}T00:00:00Z`) - new Date(`${sprint.startDate}T00:00:00Z`)) / 864e5) + 1);
  const today = todayIso();
  if (today < sprint.startDate) return { label: 'not started', pct: 0, ended: false };
  if (today > sprint.endDate) return { label: 'ended', pct: 100, ended: true };
  const day = Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${sprint.startDate}T00:00:00Z`)) / 864e5) + 1;
  return { label: `day ${day}/${total}`, pct: Math.round((day / total) * 100), ended: false };
}

export function cycleHours(pr) {
  if (!pr.createdAt || !pr.mergedAt) return null;
  return (new Date(pr.mergedAt) - new Date(pr.createdAt)) / 36e5;
}
