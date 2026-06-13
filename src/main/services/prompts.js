// Every prompt and JSON schema the analyzer uses. Buckets are *topics*
// (features/initiatives/subsystems), never work types — that's what makes
// "time chasing defects for feature X" computable later.

import { truncate, formatHours, isoDate } from './util.js';

export const WORK_TYPES = ['feature', 'defect', 'chore', 'infra', 'docs', 'test', 'refactor', 'release'];

// Bump when the summarizer's instructions change in a way that should
// invalidate prior summaries. Combined with a hash of the repo's release-cycle
// prompt, this is each summary's "fingerprint": a PR is re-summarized only when
// its fingerprint no longer matches the current one (we changed the template,
// or you edited the release-cycle prompt) — never just because a scan ran again.
export const PROMPT_VERSION = 2;

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function summaryFingerprint(repo) {
  return `${PROMPT_VERSION}:${djb2(repo?.contextPrompt || '')}`;
}

/** A PR needs (re)summarizing if it has no annotation or its prompt changed. */
export function isSummaryStale(pr, repo) {
  return !pr?.ann || pr.ann.summaryFingerprint !== summaryFingerprint(repo);
}

// One merged PR → one structured record. `detail` and `risk` are the
// sprint-planning payload: a few sentences a team lead can read, grounded in
// the description, the changed files and the PR discussion.
export const PR_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    bucket: { type: 'string' },
    bucket_description: { type: 'string' },
    work_type: { type: 'string', enum: WORK_TYPES },
    behind_flag: { type: 'boolean' },
    flag_name: { type: 'string' },
    user_facing: { type: 'boolean' },
    summary: { type: 'string' },
    detail: { type: 'string' },
    user_impact: { type: 'string' },
    highlight: { type: 'boolean' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['bucket', 'work_type', 'behind_flag', 'user_facing', 'summary', 'detail', 'user_impact'],
};

export const REORG_SCHEMA = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['merge', 'rename', 'update_description'] },
          from: { type: 'array', items: { type: 'string' } },
          into: { type: 'string' },
          bucket: { type: 'string' },
          to: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['op'],
      },
    },
  },
  required: ['operations'],
};

function repoContextBlock(repo) {
  const ctx = repo.contextPrompt?.trim();
  return [
    `Repository: ${repo.owner}/${repo.name}`,
    'RELEASE-CYCLE CONTEXT (written by the team — use it to interpret branches, freeze windows and release mechanics):',
    ctx || '(none provided — assume a single mainline branch)',
  ].join('\n');
}

function prBlock(pr) {
  const lines = [
    `#${pr.number} "${truncate(pr.title, 140)}"`,
    `  author ${pr.author} | base ${pr.base} ← ${truncate(pr.head, 60)} | merged ${pr.mergedAt ? isoDate(pr.mergedAt) : '?'} | +${pr.additions}/-${pr.deletions} in ${pr.changedFiles} files`,
  ];
  if (pr.labels?.length) lines.push(`  labels: ${pr.labels.join(', ')}`);
  if (pr.milestone) lines.push(`  milestone: ${pr.milestone}`);
  if (pr.files?.length) {
    const list = pr.files.slice(0, 12).map((f) => {
      const p = typeof f === 'string' ? f : f.path;
      const churn = f && typeof f === 'object' && (f.additions || f.deletions) ? ` (+${f.additions}/-${f.deletions})` : '';
      return `${p}${churn}`;
    });
    const more = pr.files.length > 12 ? ` … (+${pr.files.length - 12} more)` : '';
    lines.push(`  files: ${list.join(', ')}${more}`);
  } else if (pr.dirs?.length) {
    lines.push(`  dirs: ${pr.dirs.map((d) => `${d.dir} (${d.files})`).join(', ')}`);
  }
  if (pr.body) lines.push(`  body: ${truncate(pr.body.replace(/\s+/g, ' '), 700)}`);
  return lines.join('\n');
}

/** The PR discussion (comments + reviews) rendered for the summarizer. */
function commentsBlock(pr) {
  if (!pr.comments?.length) return 'PR DISCUSSION: (none captured)';
  const lines = pr.comments.map((c) => {
    const tag = c.kind === 'review'
      ? `review/${c.state || 'commented'}`
      : c.kind === 'review_comment'
        ? `inline${c.path ? ` ${truncate(c.path, 50)}` : ''}`
        : 'comment';
    const body = truncate(String(c.body || '').replace(/\s+/g, ' '), 300);
    return `- [${tag}] ${c.author}: ${body}`;
  });
  return `PR DISCUSSION (${pr.comments.length} item${pr.comments.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
}

export function buildSummarizeMessages({ repo, buckets, pr }) {
  const system = `You are Git Radar, an analyst tracking a software team's release cycle.

${repoContextBlock(repo)}

Your job: analyze ONE merged pull request and return a structured record the team can read at sprint planning.

Bucket rules:
- A bucket is what the work is ABOUT: a feature, initiative, subsystem or workstream (e.g. "Checkout Redesign", "Payments Service", "CI & Tooling").
- NEVER name a bucket after a work type ("Bug Fixes", "Misc", "Improvements"). A defect fix for the checkout flow belongs in the checkout bucket with work_type "defect" — that is how defect-chasing time per feature gets measured.
- Reuse an existing bucket whenever the PR plausibly belongs to it. Coin a new bucket only for a genuinely new stream of work, with a one-line bucket_description. Keep names short Title Case (1–4 words).
- A PR that merges one long-lived branch into another (develop → stage, stage → main, release/* or hotfix back-merges) is release mechanics: bucket "Release Operations", work_type "release".

Fields:
- work_type: ${WORK_TYPES.join(' | ')}. "defect" = fixing broken behavior; "feature" = new/changed capability.
- behind_flag / flag_name: is the change gated behind a feature flag/toggle? Look in the title, body, labels and discussion; name the flag if stated.
- user_facing: true only if end users can see or feel the change once released (false for internal tooling, refactors, flagged-off work).
- summary: ONE plain-language sentence on what the PR did.
- detail: 2–4 sentences for the team lead — what changed, why, and any risk or follow-up that is evident from the description, the changed files and the PR discussion. Ground every claim in the data provided; do not invent.
- user_impact: if user_facing, ONE sentence in release-notes / changelog voice describing what the END USER can now do or see ("Users can now select a sheet when importing a data dictionary."). Write it for a product audience, not in implementation terms. If the change is internal, infra, a refactor, or flagged off, return "" (empty string).
- highlight: true only for a genuinely notable, announce-worthy change — a new capability, a new integration/connector, or a fix to something users clearly felt. Most PRs are NOT highlights; be selective.
- risk: low | medium | high — your read of release risk given the size, area touched and discussion.

Respond with JSON matching the provided schema.`;

  const bucketList = buckets.length
    ? buckets.map((b) => `- ${b.name}: ${b.description || '(no description)'} [${b.prCount} PRs]`).join('\n')
    : 'None yet — you are starting the radar for this cycle.';

  const user = `EXISTING BUCKETS:
${bucketList}

ANALYZE THIS PR:

${prBlock(pr)}

${commentsBlock(pr)}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function buildReorgMessages({ repo, buckets }) {
  const system = `You are Git Radar, curating the buckets of work for a release cycle.

${repoContextBlock(repo)}

The buckets below accumulated as PRs were classified during the cycle. Propose cleanup operations:
- "merge": fold buckets in "from" into the bucket named "into" (existing or new); optionally set its "description".
- "rename": rename "bucket" to "to".
- "update_description": set "description" on "bucket".

Guidance:
- Aim for roughly 5–12 coherent buckets. Merge near-duplicates and fragments of the same initiative.
- Do NOT merge unrelated work just to reduce the count.
- Keep "Release Operations" separate from product work.
- Return an empty operations array if the buckets are already coherent.

Respond with JSON matching the provided schema.`;

  const user = `CURRENT BUCKETS:

${buckets
    .map((b) => `- ${b.name} (${b.prCount} PRs): ${b.description || '(no description)'}\n  sample PRs: ${b.samples.map((s) => truncate(s, 90)).join(' | ')}`)
    .join('\n')}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function buildToolInstructions(tools) {
  if (!tools.length) return '';
  const toolLines = tools
    .map((t) => `- ${t.name}: ${truncate(t.description.replace(/\s+/g, ' '), 220)}\n  input schema: ${truncate(JSON.stringify(t.inputSchema), 500)}`)
    .join('\n');
  return `

EXTERNAL PLANNING TOOLS
You may call these tools to fetch planning data (sprint goals, ticket priorities, board state) BEFORE writing the report, so you can compare planned vs. actual:
${toolLines}

To call a tool, reply with ONLY this JSON and nothing else:
{"tool_call": {"name": "<server.tool>", "arguments": { ... }}}
You will receive the result and may call another tool (at most 5 calls total). When you have what you need — or if the tools fail — reply with the final markdown report (no JSON wrapper). Only include a "Planned vs actual" section if tool data actually came back.`;
}

export function buildReportMessages({ repo, sprint, stats, buckets, prs, tools }) {
  const system = `You are Git Radar's sprint analyst. Write **product notes** for this release cycle in GitHub-flavored markdown — what shipped and why it matters — for a product owner to skim. Concrete and skimmable, under ~750 words.

Rules:
- Use ONLY the numbers in the stats JSON for aggregate counts, hours and percentages — never invent them.
- The MERGED PRS ledger below the stats is deterministic ground truth: titles, authors, work types, changed files, and — when a PR has been summarized — its per-PR "user impact" line and ★ highlight marker. Use it to say concretely what shipped, and cite PRs like #123.
- Lead with VALUE, not mechanics. Write user-facing changes in plain product/customer language ("Users can now…"), never implementation jargon. Keep what users can see separate from internal/under-the-hood work.
- Group related PRs into product areas/themes (e.g. Connectors, Blueprints, Integrations). Buckets in the stats are these themes when present; if PRs are unclassified, INFER the areas and the user impact from titles, descriptions and changed files. Never answer "unclassified" — that is a non-answer; do the grouping yourself.
- Sections, in order:
  - "## Headlines" — 3–6 bullets: the most notable things shipped, in product terms. Lead with new capabilities, new integrations, and any ★-highlighted PRs.
  - "## New for users" — user-facing features & improvements as a release-notes changelog, grouped by area; lead each line with the user-visible change.
  - "## New & expanded capabilities" — net-new product surface: integrations, connectors, new modes. Skip if none.
  - "## Fixes & reliability" — defects and stability work users will feel. If defect-turnaround numbers exist, describe them as wall-clock exposure to defect work, not engineer-hours.
  - "## Invisible this sprint" — real investment users can't see yet: work behind feature flags (name the flags) and internal/infra/refactor work. This is where release mechanics (develop→stage→main) belong, in one line.
  - "## Where the effort went" — which product areas/themes saw the most work, by PR count and churn. Momentum, not vanity metrics.${tools.length ? '\n  - "## Planned vs actual" — only if tool data came back.' : ''}
  - "## Watch-outs" — product risks: partially-shipped or flagged-off-but-incomplete work, high-risk changes, anything needing a product decision.
- Skip a section gracefully ("Nothing notable.") rather than padding it.

${repoContextBlock(repo)}${buildToolInstructions(tools)}`;

  const user = `Sprint "${sprint.name}" — ${sprint.startDate} → ${sprint.endDate} (today: ${isoDate(new Date())})

STATS (computed deterministically — trust these):
${JSON.stringify(compactStats(stats))}

MERGED PRS (deterministic — title, author, work type, churn, changed files, and per-PR user impact + ★ highlights when summarized; grouped by area, with unclassified PRs listed explicitly):
${prLedger({ buckets, prs })}

Write the report now.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * A deterministic, skimmable digest of every merged PR — titles, authors,
 * work type, churn and changed files — grouped by bucket with an explicit
 * "Unbucketed / unclassified" group. This is what makes the report useful
 * even before (or when) the LLM classification step has run: the analyst
 * always has the raw "what shipped, by whom, touching what" material to work
 * from, never just aggregate counts.
 */
export function prLedger({ buckets, prs, cap = 150 }) {
  const merged = prs.filter((p) => p.mergedAt);
  const shown = merged.slice(0, cap);

  const byBucket = new Map();
  const unbucketed = [];
  for (const pr of shown) {
    if (pr.bucketId) {
      if (!byBucket.has(pr.bucketId)) byBucket.set(pr.bucketId, []);
      byBucket.get(pr.bucketId).push(pr);
    } else {
      unbucketed.push(pr);
    }
  }

  const sections = [];
  for (const b of buckets) {
    const list = byBucket.get(b.id);
    if (!list?.length) continue;
    const head = `### ${b.name}${b.description ? ` — ${truncate(b.description, 100)}` : ''} (${list.length} PRs)`;
    sections.push(`${head}\n${list.map(prLedgerLine).join('\n')}`);
  }
  if (unbucketed.length) {
    sections.push(`### Unbucketed / unclassified (${unbucketed.length} PRs)\n${unbucketed.map(prLedgerLine).join('\n')}`);
  }

  let out = sections.join('\n\n') || '(no merged PRs in this window)';
  if (merged.length > shown.length) {
    out += `\n\n…and ${merged.length - shown.length} more merged PRs not listed individually (all counted in the stats totals above).`;
  }
  return out;
}

function prLedgerLine(pr) {
  const ann = pr.ann || {};
  const type = ann.workType || 'unclassified';
  const flag = ann.behindFlag ? ` [flag${ann.flagName ? `:${ann.flagName}` : ''}]` : '';
  const comments = pr.comments?.length ? ` · ${pr.comments.length} comments` : '';
  const risk = ann.risk ? ` · ${ann.risk} risk` : '';
  const facing = ann.workType ? (ann.userFacing ? ' · user-facing' : ' · internal') : '';
  const star = ann.highlight ? '★ ' : '';
  const lines = [
    `${star}#${pr.number} "${truncate(pr.title, 120)}" — ${pr.author} · ${type}${flag}${facing}${risk}`,
    `   ${pr.base || '?'} ← ${truncate(pr.head || '?', 50)} · merged ${pr.mergedAt ? isoDate(pr.mergedAt) : '?'} · +${pr.additions}/-${pr.deletions} in ${pr.changedFiles} files${comments}`,
  ];
  if (ann.userImpact) lines.push(`   user impact: ${truncate(String(ann.userImpact).replace(/\s+/g, ' '), 200)}`);

  const paths = pr.files?.length
    ? pr.files.slice(0, 6).map((f) => (typeof f === 'string' ? f : f.path))
    : (pr.dirs || []).map((d) => `${d.dir} (${d.files})`);
  if (paths.length) {
    const more = pr.files?.length > 6 ? ` … (+${pr.files.length - 6} files)` : '';
    lines.push(`   files: ${truncate(paths.join(', '), 240)}${more}`);
  }

  // Prefer the LLM's multi-sentence detail; fall back to the one-liner, then body.
  const desc = ann.detail || ann.summary || pr.body;
  if (desc) {
    const label = ann.detail ? 'detail' : ann.summary ? 'summary' : 'body';
    lines.push(`   ${label}: ${truncate(String(desc).replace(/\s+/g, ' '), 280)}`);
  }
  return lines.join('\n');
}

/** Trim the stats object so it fits comfortably in a local model's context. */
function compactStats(stats) {
  return {
    totals: stats.totals,
    highlights: (stats.highlights || []).slice(0, 12).map((h) => ({
      pr: h.number, title: truncate(h.title, 90), area: h.bucket, impact: truncate(h.userImpact, 140),
    })),
    perBucket: stats.perBucket.slice(0, 14).map((b) => ({
      area: b.name,
      prs: b.prCount,
      types: b.byType,
      userFacing: b.userFacingCount,
      additions: b.additions,
      deletions: b.deletions,
      avgCycle: formatHours(b.avgCycleHours),
      defects: b.defectCount,
      defectTurnaround: formatHours(b.defectHours),
      defectSharePct: b.defectSharePct,
      flags: b.flags,
      hiddenFeature: b.hiddenFeature,
    })),
    defectChasing: stats.defectChasing.map((d) => ({
      bucket: d.name,
      defects: d.defectCount,
      turnaround: formatHours(d.defectHours),
      sharePct: d.defectSharePct,
    })),
    hiddenWork: stats.hiddenWork.map((h) => ({ bucket: h.name, flags: h.flags, featurePrs: h.featureCount })),
    unbucketed: stats.unbucketed,
  };
}
