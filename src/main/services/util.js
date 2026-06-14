// Small pure helpers shared by services. No electron imports — unit-testable.

export function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…';
}

/**
 * Extract a JSON object from LLM output. Tolerates code fences and
 * leading/trailing prose; throws if nothing parseable is found.
 */
export function extractJson(text) {
  if (!text) throw new Error('Empty LLM response');
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('No JSON object found in LLM response');
  }
  return JSON.parse(t.slice(start, end + 1));
}

/** Try to interpret LLM output as a {"tool_call": {name, arguments}} request. */
export function extractToolCall(text) {
  try {
    const obj = extractJson(text);
    const tc = obj && obj.tool_call;
    if (tc && typeof tc.name === 'string') {
      return { name: tc.name, arguments: tc.arguments ?? {} };
    }
  } catch {
    // not JSON → it's a normal answer
  }
  return null;
}

export function hoursBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return ms / 36e5;
}

export function formatHours(h) {
  if (h == null || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

export function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function uid() {
  return globalThis.crypto.randomUUID();
}

export function uniq(arr) {
  return [...new Set(arr)];
}

/** Small, stable, non-cryptographic string hash (djb2) for cache fingerprints. */
export function hashString(s) {
  let h = 5381;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i += 1) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
