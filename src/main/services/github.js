// Wrapper around the GitHub CLI. All GitHub access goes through `gh` so the
// app inherits the user's existing auth (incl. SSO / GH Enterprise) and never
// touches tokens. execFile (no shell) keeps arguments injection-safe.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { truncate } from './util.js';

const pExecFile = promisify(execFile);

const LIST_FIELDS = [
  'number', 'title', 'body', 'author', 'labels', 'baseRefName', 'headRefName',
  'createdAt', 'mergedAt', 'additions', 'deletions', 'changedFiles', 'url',
  'milestone',
];

async function gh(args, { timeout = 180000 } = {}) {
  try {
    const { stdout } = await pExecFile('gh', args, {
      timeout,
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: 'cat', NO_COLOR: '1', CLICOLOR: '0' },
    });
    return stdout;
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('GitHub CLI (gh) not found on PATH. Install it from https://cli.github.com and run `gh auth login`.');
    }
    const stderr = (e.stderr || '').toString().trim();
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr || e.message}`);
  }
}

export async function checkGh() {
  let version;
  try {
    const out = await gh(['--version'], { timeout: 10000 });
    version = out.split('\n')[0].trim();
  } catch (e) {
    return { ok: false, authed: false, error: e.message };
  }
  try {
    await gh(['auth', 'status'], { timeout: 20000 });
    return { ok: true, authed: true, version };
  } catch (e) {
    return { ok: true, authed: false, version, error: e.message };
  }
}

/**
 * Fetch PRs merged inside [since..until] (inclusive, YYYY-MM-DD). When
 * `branches` is non-empty, one query per base branch; otherwise all merged
 * PRs regardless of base. Tries to include per-file paths (great signal for
 * monorepo bucketing) and falls back to the lighter query if that fails.
 */
export async function fetchMergedPRs(repo, { since, until, branches = [], limit = 400 } = {}) {
  const slug = `${repo.owner}/${repo.name}`;
  const queries = branches.length
    ? branches.map((b) => `merged:${since}..${until} base:${b}`)
    : [`merged:${since}..${until}`];

  const byNumber = new Map();
  for (const search of queries) {
    const prs = await listPRs(slug, search, limit, true)
      .catch(() => listPRs(slug, search, limit, false));
    for (const pr of prs) byNumber.set(pr.number, pr);
  }
  return [...byNumber.values()].sort((a, b) =>
    String(a.mergedAt).localeCompare(String(b.mergedAt)));
}

async function listPRs(slug, search, limit, withFiles) {
  const fields = withFiles ? [...LIST_FIELDS, 'files'] : LIST_FIELDS;
  const out = await gh([
    'pr', 'list',
    '--repo', slug,
    '--state', 'merged',
    '--search', search,
    '--limit', String(limit),
    '--json', fields.join(','),
  ]);
  const rows = JSON.parse(out || '[]');
  return rows.map(normalizePR);
}

function normalizePR(raw) {
  return {
    number: raw.number,
    title: raw.title || '',
    body: truncate(raw.body || '', 4000),
    author: raw.author?.login || 'unknown',
    labels: (raw.labels || []).map((l) => l.name).filter(Boolean),
    base: raw.baseRefName || '',
    head: raw.headRefName || '',
    createdAt: raw.createdAt || null,
    mergedAt: raw.mergedAt || null,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    url: raw.url || '',
    milestone: raw.milestone?.title || null,
    dirs: summarizeDirs(raw.files),
    files: topFiles(raw.files),
  };
}

/**
 * Keep the actual changed-file paths (with per-file churn) so the report
 * generator has concrete signal — not just the directory rollup. Sorted by
 * churn so the most significant files survive the cap on noisy PRs.
 */
export function topFiles(files, top = 50) {
  if (!Array.isArray(files) || !files.length) return [];
  return files
    .map((f) => (typeof f === 'string'
      ? { path: f, additions: 0, deletions: 0 }
      : { path: f?.path || '', additions: f?.additions ?? 0, deletions: f?.deletions ?? 0 }))
    .filter((f) => f.path)
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, top);
}

/**
 * Fetch the discussion on a single PR deterministically: issue comments,
 * review verdicts (+ their bodies), and inline review comments. None of this
 * is in `gh pr list`, so it's a per-PR call — cheap when done incrementally
 * (new merges only). Every leg is best-effort: a PR with no comments, or a
 * transient gh hiccup, just yields an empty list rather than failing the run.
 */
export async function fetchPRDetails(repo, number) {
  const slug = `${repo.owner}/${repo.name}`;
  let view = {};
  try {
    const out = await gh(
      ['pr', 'view', String(number), '--repo', slug, '--json', 'comments,reviews'],
      { timeout: 60000 },
    );
    view = JSON.parse(out || '{}');
  } catch {
    view = {};
  }

  let reviewComments = [];
  try {
    // Inline (line-level) review comments aren't exposed by `gh pr view`.
    const out = await gh(['api', `repos/${slug}/pulls/${number}/comments`], { timeout: 60000 });
    reviewComments = JSON.parse(out || '[]');
  } catch {
    reviewComments = [];
  }

  return { comments: normalizeComments({ view, reviewComments }) };
}

/**
 * The unified diff for one PR, for the inspector UI. Capped so a giant PR
 * can't lock up the renderer; the cap is reported so the UI can say so.
 */
export async function fetchPRDiff(repo, number, { maxChars = 200000 } = {}) {
  const slug = `${repo.owner}/${repo.name}`;
  const out = await gh(['pr', 'diff', String(number), '--repo', slug], { timeout: 60000 });
  const text = out || '';
  return text.length > maxChars
    ? { diff: text.slice(0, maxChars), truncated: true, totalChars: text.length }
    : { diff: text, truncated: false, totalChars: text.length };
}

/**
 * Flatten the three comment sources into one chronological list of
 * `{ kind, author, body, ... }`, trimmed and capped so a noisy thread can't
 * blow up the summarizer's context.
 */
export function normalizeComments({ view = {}, reviewComments = [] } = {}, max = 40) {
  const out = [];
  for (const c of view.comments || []) {
    const body = (c?.body || '').trim();
    if (!body) continue;
    out.push({ kind: 'comment', author: c.author?.login || 'unknown', body: truncate(body, 600), createdAt: c.createdAt || null });
  }
  for (const r of view.reviews || []) {
    const body = (r?.body || '').trim();
    const state = r?.state ? String(r.state).toLowerCase() : '';
    if (!body && !state) continue;
    out.push({ kind: 'review', author: r.author?.login || 'unknown', state, body: truncate(body, 600), createdAt: r.submittedAt || null });
  }
  for (const rc of reviewComments) {
    const body = (rc?.body || '').trim();
    if (!body) continue;
    out.push({ kind: 'review_comment', author: rc.user?.login || 'unknown', body: truncate(body, 400), path: rc.path || '', createdAt: rc.created_at || null });
  }
  return out
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, max);
}

/**
 * Condense changed file paths into the top directories touched — in a
 * monorepo, `packages/checkout (14)` tells the classifier more than any
 * individual path. Uses up to two leading path segments.
 */
export function summarizeDirs(files, top = 12) {
  if (!Array.isArray(files) || !files.length) return [];
  const counts = new Map();
  for (const f of files) {
    const p = typeof f === 'string' ? f : f?.path;
    if (!p) continue;
    const segs = p.split('/');
    const key = segs.length <= 1 ? '(root)' : segs.slice(0, Math.min(2, segs.length - 1)).join('/');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([dir, files]) => ({ dir, files }));
}
