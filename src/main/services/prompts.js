// Every prompt and JSON schema the analyzer uses. Buckets are *topics*
// (features/initiatives/subsystems), never work types — that's what makes
// "time chasing defects for feature X" computable later.

import { truncate, formatHours, isoDate } from './util.js';

export const WORK_TYPES = ['feature', 'defect', 'chore', 'infra', 'docs', 'test', 'refactor', 'release'];

export const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          bucket: { type: 'string' },
          bucket_description: { type: 'string' },
          work_type: { type: 'string', enum: WORK_TYPES },
          behind_flag: { type: 'boolean' },
          flag_name: { type: 'string' },
          user_facing: { type: 'boolean' },
          summary: { type: 'string' },
        },
        required: ['number', 'bucket', 'work_type', 'behind_flag', 'user_facing', 'summary'],
      },
    },
  },
  required: ['classifications'],
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
  if (pr.dirs?.length) lines.push(`  dirs: ${pr.dirs.map((d) => `${d.dir} (${d.files})`).join(', ')}`);
  if (pr.body) lines.push(`  body: ${truncate(pr.body.replace(/\s+/g, ' '), 700)}`);
  return lines.join('\n');
}

export function buildClassifyMessages({ repo, buckets, prs }) {
  const system = `You are Git Radar, an analyst tracking a software team's release cycle.

${repoContextBlock(repo)}

Your job: classify merged pull requests into named buckets of work.

Bucket rules:
- A bucket is what the work is ABOUT: a feature, initiative, subsystem or workstream (e.g. "Checkout Redesign", "Payments Service", "CI & Tooling").
- NEVER create buckets named after work types ("Bug Fixes", "Misc", "Improvements"). A defect fix for the checkout flow belongs in the checkout bucket with work_type "defect" — that is how defect-chasing time per feature gets measured.
- Reuse an existing bucket whenever the PR plausibly belongs to it. Create a new bucket only for a genuinely new stream of work, and give it a one-line bucket_description.
- Keep bucket names short Title Case (1–4 words).
- PRs that merge one long-lived branch into another (develop → stage, stage → main, release/* or hotfix back-merges) are release mechanics: bucket "Release Operations", work_type "release".

Per-PR fields:
- work_type: ${WORK_TYPES.join(' | ')}. "defect" = fixing broken behavior; "feature" = new/changed capability.
- behind_flag: true when the change is gated behind a feature flag/toggle (look for flag mentions in title, body, labels).
- flag_name: the flag identifier when stated, else "".
- user_facing: true only if end users can see or feel the change once released (false for internal tooling, refactors, flagged-off work).
- summary: one plain-language sentence on what the PR did.

Respond with JSON matching the provided schema, one classification per PR, in the same order.`;

  const bucketList = buckets.length
    ? buckets.map((b) => `- ${b.name}: ${b.description || '(no description)'} [${b.prCount} PRs]`).join('\n')
    : 'None yet — you are starting the radar for this cycle.';

  const user = `EXISTING BUCKETS:
${bucketList}

Classify these ${prs.length} merged PRs:

${prs.map(prBlock).join('\n\n')}`;

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
  const system = `You are Git Radar's sprint analyst. Write a sprint report in GitHub-flavored markdown for the team lead. Be concrete and skimmable, under ~700 words.

Rules:
- Use ONLY the numbers provided in the stats JSON — never invent counts, dates or hours.
- "Defect turnaround" figures are wall-clock time from a defect PR being opened to merged — describe them as time exposed to defect work, not engineer-hours.
- Sections, in order: "## TL;DR" (3–5 bullets), "## What shipped", "## Buckets of work" (markdown table: Bucket | PRs | Features/Defects | Defect turnaround | Notes), "## Defect chasing", "## Hidden work" (features fully behind flags or not user-facing), "## Release operations"${tools.length ? ', "## Planned vs actual" (only if tool data came back)' : ''}, "## Watch-outs".
- Skip a section gracefully ("Nothing notable.") rather than padding it.

${repoContextBlock(repo)}${buildToolInstructions(tools)}`;

  const bucketDetail = buckets
    .map((b) => {
      const titles = prs
        .filter((p) => p.bucketId === b.id)
        .slice(0, 12)
        .map((p) => `#${p.number} ${truncate(p.title, 80)} [${p.ann?.workType || '?'}]`);
      return `- ${b.name}: ${b.description || ''}\n  ${titles.join('\n  ')}`;
    })
    .join('\n');

  const user = `Sprint "${sprint.name}" — ${sprint.startDate} → ${sprint.endDate} (today: ${isoDate(new Date())})

STATS (computed deterministically — trust these):
${JSON.stringify(compactStats(stats))}

BUCKET CONTENTS:
${bucketDetail || '(no buckets yet)'}

Write the report now.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Trim the stats object so it fits comfortably in a local model's context. */
function compactStats(stats) {
  return {
    totals: stats.totals,
    perBucket: stats.perBucket.slice(0, 14).map((b) => ({
      bucket: b.name,
      prs: b.prCount,
      types: b.byType,
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
