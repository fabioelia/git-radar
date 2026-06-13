// The pipeline: sync (gh) → categorize (LLM, batched) → reorganize (LLM)
// → report (LLM + optional MCP tool loop). Dependencies are injected so the
// whole thing runs under tests with stubs.

import {
  buildSummarizeMessages,
  buildReorgMessages,
  buildReportMessages,
  summaryFingerprint,
  PR_SUMMARY_SCHEMA,
  REORG_SCHEMA,
  WORK_TYPES,
} from './prompts.js';
import { computeStats } from './stats.js';
import { extractJson, extractToolCall, uid, truncate } from './util.js';

const MAX_TOOL_CALLS = 5;
const AUTO_REORG_THRESHOLD = 13;
const LLM_LOG_LIMIT = 30;

export function createAnalyzer({ store, ollama, github, mcp, emit = () => {} }) {
  function load(sprintId) {
    const sprint = store.getSprint(sprintId);
    if (!sprint) throw new Error('Sprint not found');
    const repo = store.getRepo(sprint.repoId);
    if (!repo) throw new Error('Repo not found');
    return { sprint, repo, data: store.getSprintData(sprintId) };
  }

  /**
   * Every Gemma call goes through here so the UI can show exactly what was
   * sent and what came back (the Prompts tab). Failed calls are logged and
   * persisted immediately — that's when transparency matters most.
   */
  async function loggedChat(sprintId, data, task, meta, chatArgs) {
    const model = store.getSettings().ollamaModel;
    const entry = {
      id: uid(),
      createdAt: new Date().toISOString(),
      task,
      meta,
      model,
      messages: chatArgs.messages.map((m) => ({ ...m })), // snapshot: the report loop mutates its array
    };
    const started = Date.now();
    try {
      entry.response = await ollama.chat(chatArgs);
      entry.durationMs = Date.now() - started;
      pushLog(data, entry);
      return entry.response;
    } catch (e) {
      entry.error = e.message;
      entry.durationMs = Date.now() - started;
      pushLog(data, entry);
      store.saveSprintData(sprintId, data);
      throw e;
    }
  }

  /** Fetch merged PRs for the sprint window; merge by number, keep annotations. */
  async function sync(sprintId) {
    const { sprint, repo, data } = load(sprintId);
    emit({ task: 'sync', message: `Fetching PRs merged ${sprint.startDate} → ${sprint.endDate} in ${repo.owner}/${repo.name}…` });

    const fetched = await github.fetchMergedPRs(repo, {
      since: sprint.startDate,
      until: sprint.endDate,
      branches: repo.trackedBranches,
    });

    const byNumber = new Map(data.prs.map((p) => [p.number, p]));
    let added = 0;
    for (const pr of fetched) {
      const existing = byNumber.get(pr.number);
      if (existing) {
        byNumber.set(pr.number, { ...pr, bucketId: existing.bucketId, ann: existing.ann });
      } else {
        byNumber.set(pr.number, pr);
        added += 1;
      }
    }
    data.prs = [...byNumber.values()].sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
    data.lastSyncAt = new Date().toISOString();
    store.saveSprintData(sprintId, data);
    emit({ task: 'sync', message: `Sync done: ${added} new, ${data.prs.length} total merged PRs.`, done: true });
    return { added, total: data.prs.length };
  }

  /**
   * Deterministic enrichment: pull the PR's discussion (comments + reviews)
   * once and cache it on the PR. Best-effort — a stub github, no comments, or
   * a transient gh failure all resolve to an empty list rather than blocking
   * the summary. The cache (`pr.comments !== undefined`) keeps it to one call.
   */
  async function ensureDetails(repo, pr) {
    if (pr.comments !== undefined) return;
    if (!github || typeof github.fetchPRDetails !== 'function') {
      pr.comments = [];
      return;
    }
    try {
      const details = await github.fetchPRDetails(repo, pr.number);
      pr.comments = Array.isArray(details?.comments) ? details.comments : [];
    } catch {
      pr.comments = [];
    }
  }

  /**
   * Summarize unannotated PRs (or all, with force) one at a time: each PR gets
   * its discussion pulled deterministically, then a single structured LLM pass
   * producing bucket + work type + a multi-sentence detail for sprint planning.
   * Per-PR (not batched) so each summary is deep and the exchange is inspectable
   * on its own; cheap in steady state since auto-poll only feeds new merges.
   */
  async function categorize(sprintId, { force = false } = {}) {
    const { repo, data } = load(sprintId);
    if (force) {
      for (const pr of data.prs) {
        pr.ann = undefined;
        pr.bucketId = undefined;
      }
      data.buckets = [];
    }
    // A PR is a target if it was never summarized OR its summary was produced
    // with a different prompt (template version or the repo's release-cycle
    // prompt changed). Already-summarized PRs whose prompt is unchanged are
    // skipped — a re-scan never redoes finished work.
    const fp = summaryFingerprint(repo);
    const targets = data.prs.filter((p) => !p.ann || p.ann.summaryFingerprint !== fp);
    if (!targets.length) {
      emit({ task: 'categorize', message: 'Nothing to summarize — all PRs are current.', done: true });
      return { classified: 0, buckets: data.buckets.length, autoReorganized: false };
    }

    let classified = 0;
    // One PR per LLM call. Concurrency defaults to 1 — strictly one at a time —
    // and the "Summaries in parallel" setting raises it for users whose Ollama
    // is configured to serve parallel requests (OLLAMA_NUM_PARALLEL). Buckets
    // dedupe by name at apply time, so parallel workers never create dupes.
    const limit = Math.max(1, Math.min(8, Number(store.getSettings().summaryConcurrency) || 1));
    let next = 0;
    let done = 0;
    let failure = null;

    const worker = async () => {
      while (next < targets.length && !failure) {
        const pr = targets[next];
        next += 1;
        emit({
          task: 'categorize',
          message: `Summarizing #${pr.number} ${truncate(pr.title, 60)} (${done + 1}/${targets.length})…`,
          current: done + 1,
          total: targets.length,
        });
        try {
          await ensureDetails(repo, pr);
          const messages = buildSummarizeMessages({ repo, buckets: bucketSummaries(data), pr });
          const content = await loggedChat(sprintId, data, 'summarize', `#${pr.number} ${truncate(pr.title, 60)}`,
            { messages, schema: PR_SUMMARY_SCHEMA });
          classified += applyClassifications(data, [{ number: pr.number, ...extractJson(content), summaryFingerprint: fp }]);
          done += 1;
          store.saveSprintData(sprintId, data); // persist as we go — long runs survive interruption
        } catch (e) {
          if (!failure) failure = e; // stop picking up new work; let in-flight workers settle
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
    if (failure) throw failure;

    pruneEmptyBuckets(data); // re-summarization can empty an old bucket
    store.saveSprintData(sprintId, data);

    let autoReorganized = false;
    if (data.buckets.length >= AUTO_REORG_THRESHOLD) {
      emit({ task: 'categorize', message: `${data.buckets.length} buckets — asking Gemma to reorganize…` });
      await reorganize(sprintId);
      autoReorganized = true;
    }
    emit({ task: 'categorize', message: `Summarized ${classified} PRs.`, done: true });
    return { classified, buckets: store.getSprintData(sprintId).buckets.length, autoReorganized };
  }

  /**
   * Build the exact summarize prompt for one PR WITHOUT firing it — for the
   * inspector UI. Pulls the discussion and the diff so the panel can show the
   * raw material next to the generated prompt.
   */
  async function inspectPR(sprintId, prNumber) {
    const { repo, data } = load(sprintId);
    const pr = data.prs.find((p) => p.number === prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not in this sprint`);
    // Pull the discussion for the prompt preview, but don't persist here:
    // inspect runs unlocked, so writing could race a concurrent scan. The
    // durable cache happens in summarizePR / categorize, which hold the lock.
    await ensureDetails(repo, pr);

    let diff = null;
    if (github && typeof github.fetchPRDiff === 'function') {
      diff = await github.fetchPRDiff(repo, prNumber).catch((e) => ({ diff: '', error: e.message }));
    }
    return {
      pr,
      bucket: data.buckets.find((b) => b.id === pr.bucketId) || null,
      messages: buildSummarizeMessages({ repo, buckets: bucketSummaries(data), pr }),
      diff,
    };
  }

  /**
   * Re-run the summarizer for a single PR and apply the result — the "fire it
   * and see how it behaves per PR" control. The exchange is logged like any
   * other, so it shows up in the Prompts tab.
   */
  async function summarizePR(sprintId, prNumber) {
    const { repo, data } = load(sprintId);
    const pr = data.prs.find((p) => p.number === prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not in this sprint`);
    await ensureDetails(repo, pr);
    const messages = buildSummarizeMessages({ repo, buckets: bucketSummaries(data), pr });
    emit({ task: 'summarize', message: `Summarizing PR #${pr.number}…` });
    const content = await loggedChat(sprintId, data, 'summarize', `#${pr.number} ${truncate(pr.title, 60)} (manual)`,
      { messages, schema: PR_SUMMARY_SCHEMA });
    const parsed = extractJson(content);
    applyClassifications(data, [{ number: pr.number, ...parsed, summaryFingerprint: summaryFingerprint(repo) }]);
    store.saveSprintData(sprintId, data);
    emit({ task: 'summarize', message: `PR #${pr.number} summarized.`, done: true });
    return { pr: data.prs.find((p) => p.number === prNumber), parsed, content, messages };
  }

  /** LLM pass that merges/renames buckets to keep the radar coherent. */
  async function reorganize(sprintId) {
    const { repo, data } = load(sprintId);
    if (data.buckets.length < 2) return { operations: 0 };

    emit({ task: 'reorganize', message: 'Asking Gemma to curate the buckets…' });
    const messages = buildReorgMessages({
      repo,
      buckets: data.buckets.map((b) => ({
        name: b.name,
        description: b.description,
        prCount: prsIn(data, b.id).length,
        samples: prsIn(data, b.id).slice(0, 6).map((p) => `#${p.number} ${p.title}`),
      })),
    });
    const content = await loggedChat(sprintId, data, 'reorganize',
      `${data.buckets.length} buckets`, { messages, schema: REORG_SCHEMA });
    const parsed = extractJson(content);
    const applied = applyReorgOps(data, parsed.operations || []);
    pruneEmptyBuckets(data);
    store.saveSprintData(sprintId, data);
    emit({ task: 'reorganize', message: `Applied ${applied} bucket operations.`, done: true });
    return { operations: applied };
  }

  /** Generate the sprint report; lets the model call MCP tools first if configured. */
  async function generateReport(sprintId) {
    const { sprint, repo, data } = load(sprintId);
    const settings = store.getSettings();
    const stats = computeStats({ sprint, prs: data.prs, buckets: data.buckets });

    let tools = [];
    const toolCalls = [];
    if (settings.mcpServers?.length) {
      emit({ task: 'report', message: 'Connecting MCP servers…' });
      const statuses = await mcp.connectServers(settings.mcpServers);
      tools = mcp.listAllTools();
      for (const s of statuses.filter((s) => !s.ok)) {
        toolCalls.push({ name: `connect:${s.name}`, ok: false, error: s.error });
      }
    }

    const messages = buildReportMessages({ repo, sprint, stats, buckets: data.buckets, prs: data.prs, tools });
    emit({ task: 'report', message: 'Asking Gemma to write the sprint report…' });

    let markdown = null;
    for (let turn = 0; turn <= MAX_TOOL_CALLS; turn += 1) {
      const content = await loggedChat(sprintId, data, 'report',
        turn === 0 ? 'initial prompt' : `after tool turn ${turn}`,
        { messages, temperature: 0.4 });
      const call = tools.length ? extractToolCall(content) : null;
      if (!call || turn === MAX_TOOL_CALLS) {
        markdown = content;
        break;
      }
      emit({ task: 'report', message: `Gemma is calling ${call.name}…` });
      let resultText;
      let ok = true;
      try {
        resultText = await mcp.callTool(call.name, call.arguments);
      } catch (e) {
        ok = false;
        resultText = `ERROR: ${e.message}`;
      }
      toolCalls.push({ name: call.name, ok, error: ok ? undefined : truncate(resultText, 300) });
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `TOOL RESULT for ${call.name}:\n${resultText}\n\nCall another tool (JSON only) or write the final markdown report now.`,
      });
    }

    const report = {
      id: uid(),
      createdAt: new Date().toISOString(),
      markdown,
      toolCalls,
    };
    data.reports = [report, ...(data.reports || [])].slice(0, 20);
    store.saveSprintData(sprintId, data);
    emit({ task: 'report', message: 'Report ready.', done: true });
    return report;
  }

  return { sync, categorize, reorganize, generateReport, inspectPR, summarizePR };
}

// ---- pure helpers (exported for tests) ----

export function pushLog(data, entry) {
  data.llmLog = [entry, ...(data.llmLog || [])].slice(0, LLM_LOG_LIMIT);
}

export function bucketSummaries(data) {
  return data.buckets.map((b) => ({
    name: b.name,
    description: b.description,
    prCount: prsIn(data, b.id).length,
  }));
}

function prsIn(data, bucketId) {
  return data.prs.filter((p) => p.bucketId === bucketId);
}

export function findOrCreateBucket(data, name, description = '') {
  const wanted = String(name || '').trim() || 'Uncategorized Work';
  const existing = data.buckets.find((b) => b.name.toLowerCase() === wanted.toLowerCase());
  if (existing) {
    if (description && !existing.description) existing.description = description;
    return existing;
  }
  const bucket = { id: uid(), name: wanted, description, createdAt: new Date().toISOString() };
  data.buckets.push(bucket);
  return bucket;
}

export function applyClassifications(data, classifications) {
  let applied = 0;
  for (const c of classifications) {
    const pr = data.prs.find((p) => p.number === c.number);
    if (!pr) continue;
    const bucket = findOrCreateBucket(data, c.bucket, c.bucket_description || '');
    pr.bucketId = bucket.id;
    pr.ann = {
      workType: WORK_TYPES.includes(c.work_type) ? c.work_type : 'chore',
      behindFlag: Boolean(c.behind_flag),
      flagName: String(c.flag_name || ''),
      userFacing: Boolean(c.user_facing),
      summary: String(c.summary || ''),
      detail: String(c.detail || ''),
      userImpact: String(c.user_impact || ''),
      changelogCategory: ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security', 'none'].includes(c.changelog_category) ? c.changelog_category : undefined,
      audience: ['end_user', 'developer', 'admin', 'internal'].includes(c.audience) ? c.audience : undefined,
      breaking: Boolean(c.breaking),
      security: Boolean(c.security),
      highlight: Boolean(c.highlight),
      risk: ['low', 'medium', 'high'].includes(c.risk) ? c.risk : undefined,
      summaryFingerprint: c.summaryFingerprint,
      classifiedAt: new Date().toISOString(),
    };
    applied += 1;
  }
  return applied;
}

export function applyReorgOps(data, operations) {
  const byName = (name) =>
    data.buckets.find((b) => b.name.toLowerCase() === String(name || '').trim().toLowerCase());
  let applied = 0;
  for (const op of operations) {
    if (op.op === 'merge' && Array.isArray(op.from) && op.into) {
      const target = findOrCreateBucket(data, op.into, op.description || '');
      for (const fromName of op.from) {
        const src = byName(fromName);
        if (!src || src.id === target.id) continue;
        for (const pr of data.prs) if (pr.bucketId === src.id) pr.bucketId = target.id;
        data.buckets = data.buckets.filter((b) => b.id !== src.id);
        applied += 1;
      }
      if (op.description) target.description = op.description;
    } else if (op.op === 'rename' && op.bucket && op.to) {
      const b = byName(op.bucket);
      const clash = byName(op.to);
      if (b && !clash) {
        b.name = String(op.to).trim();
        if (op.description) b.description = op.description;
        applied += 1;
      } else if (b && clash && clash.id !== b.id) {
        // rename onto an existing name → treat as merge
        for (const pr of data.prs) if (pr.bucketId === b.id) pr.bucketId = clash.id;
        data.buckets = data.buckets.filter((x) => x.id !== b.id);
        applied += 1;
      }
    } else if (op.op === 'update_description' && op.bucket && op.description) {
      const b = byName(op.bucket);
      if (b) {
        b.description = op.description;
        applied += 1;
      }
    }
  }
  return applied;
}

export function pruneEmptyBuckets(data) {
  const used = new Set(data.prs.map((p) => p.bucketId).filter(Boolean));
  data.buckets = data.buckets.filter((b) => used.has(b.id));
}
