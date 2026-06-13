# Git Radar — Design

## The goal, restated

Teams that ship on a release train (e.g. "the Newton monorepo releases every 3 weeks:
develop → stage at code freeze → main at release") have a recurring blind spot: **what
actually happened this cycle?** Planning tools show what was *intended*. The merge
history shows what was *done* — but as hundreds of disconnected PRs.

Git Radar closes that gap. It watches the repos you care about, pulls every PR merged
during the cycle, and uses a **local LLM (Gemma via Ollama)** to organize raw merges
into evolving **buckets of work** — features, initiatives, subsystems. At the end of
the sprint it answers questions like:

- *How much time did we spend chasing defects for feature X?*
- *Which features were built but are entirely behind flags, invisible to users?*
- *How much of the cycle went to release mechanics vs. real work?*
- *Did what we shipped match what we planned?* (via MCP → Jira/Atlassian)

It is a **retrospective instrument**, not a dashboard of vanity metrics. The output is
a narrative + numbers a team lead can read in two minutes at sprint review.

## Why these particular ingredients

- **GitHub CLI (`gh`)** — zero credential management. The user is already logged in;
  `gh` handles auth, SSO, and GitHub Enterprise hosts. We shell out to
  `gh pr list --json …` and never store tokens.
- **Local Gemma LLM** — PR titles and bodies are often confidential. Everything is
  analyzed on-device through Ollama's API; nothing leaves the machine. Gemma 3 12B
  handles classification well; structured outputs (JSON-schema-constrained sampling)
  make it reliable regardless of model size.
- **MCP client** — planning context lives elsewhere (Jira, Linear, Confluence…).
  Rather than building N integrations, Git Radar is an MCP *client*: configure any
  stdio MCP server (e.g. Atlassian via `mcp-remote`) and the LLM can call its tools
  while writing the sprint report — fetching sprint priorities to produce the
  "planned vs. actual" section.

## Core loop

```
        ┌────────────┐   gh pr list    ┌───────────┐   classify (batches)   ┌─────────┐
 repo + │   SYNC     │ ──────────────► │  PR store │ ─────────────────────► │ BUCKETS │
 prompt │ (gh CLI)   │   merged PRs    │  (JSON)   │   local Gemma, JSON    │ of work │
        └────────────┘                 └───────────┘   schema outputs       └────┬────┘
                                                                                 │ reorganize
                                                                                 ▼ (LLM merges/renames)
        ┌───────────────┐  stats engine (pure JS)  ┌──────────────┐   LLM + MCP tools
        │ SPRINT REPORT │ ◄─────────────────────── │  STATISTICS  │ ◄── planned-vs-actual
        └───────────────┘                          └──────────────┘
```

1. **Sync** — fetch PRs merged inside the sprint window (optionally filtered to the
   tracked base branches: develop/stage/main). Re-sync merges by PR number and never
   loses prior classification.
2. **Categorize** — one PR at a time, Gemma gets the repo's context prompt, the *current*
   bucket list, and the PR's full material: title/body, the **changed-file list**, and the
   **discussion** (issue comments + review verdicts + inline review comments, pulled
   deterministically via `gh` and cached on the PR). The model assigns each PR to an
   existing bucket or coins a new one, plus annotations: `work_type` (feature/defect/chore/
   infra/docs/test/refactor/release), `behind_flag` + flag name, `user_facing`, a one-line
   `summary`, a 2–4 sentence `detail` for sprint planning, and a `risk` read. Per-PR (not
   batched) keeps each summary deep and individually inspectable/re-runnable; it stays cheap
   in steady state because the auto-poll only feeds newly-merged PRs.
3. **Reorganize** — buckets drift as the sprint progresses. A second LLM pass proposes
   `merge` / `rename` / `update_description` operations to keep 5–12 coherent buckets.
   Runs automatically when buckets proliferate, or on demand.
4. **Stats** — pure, deterministic JS over the annotated PRs (the LLM never does
   arithmetic): per-bucket type breakdown, churn, defect turnaround time, hidden
   (fully-flagged) features, merges-per-day timeline per base branch, contributors.
5. **Report** — Gemma writes a markdown sprint report from the stats + buckets, plus a
   deterministic per-PR ledger (title, author, work type, churn, changed files; grouped
   by bucket, with unclassified PRs listed explicitly) so the narrative is grounded in
   what actually merged even before — or when — classification has run. If MCP servers
   are configured, the model may call their tools first (prompt-driven tool loop, max 5
   calls) to pull sprint priorities and compare plan vs. reality.

## Key design decisions

### Buckets are *topics*, not *types*
A bug fix for checkout belongs in the **Checkout** bucket with `work_type: defect` —
not in a "Bug Fixes" bucket. This is what makes "time spent chasing defects for X"
answerable: defect time is aggregated *within* each feature bucket. The classifier
prompt enforces this, and "Release Operations" is the one mandated structural bucket
(develop→stage→main merges, back-merges) so release mechanics don't pollute features.

### The release-cycle prompt is first-class data
The user's free-text description of how the repo releases ("develop is mainline, we
freeze into stage, release from main…") is stored per repo and injected into **every**
LLM call. The model uses it to interpret branch names, what counts as release ops,
what "code freeze" means for late merges, etc. We deliberately do *not* try to parse
this into config — it's context, and LLMs are good at context.

### Deterministic numbers, narrative prose
Anything numeric (counts, hours, percentages) is computed in `stats.js` and handed to
the model, which is instructed to use the numbers given and never invent data. The LLM
adds judgment (what mattered, what's risky), not arithmetic.

**"Time chasing defects"** is approximated as **defect turnaround time**: the sum of
(merge time − open time) over defect PRs in a bucket. It's wall-clock exposure to
defect work, not engineer-hours — the report is told to present it as such.

**"Hidden feature"** = a bucket with ≥1 feature PR where *every* feature PR is either
behind a flag or not user-facing. That's the "we built it but users can't see it" case.

### Prompt-driven MCP tool loop (no native tool-calling required)
Gemma's native function-calling support in Ollama is inconsistent across sizes. The
report generator instead describes available MCP tools in the prompt and asks the
model to reply with `{"tool_call": {name, arguments}}` JSON when it wants data. We
parse, call the MCP server, feed the result back, loop (≤5 calls). This works with
*any* model and degrades gracefully: no MCP servers → the section is skipped.

### Polling, not webhooks (local-first has no endpoint)
Real GitHub push webhooks need a public HTTP endpoint to receive events — a local
desktop app has none, and hosting one would break the "nothing leaves your machine"
promise. So "check for updates" is an opt-in background **poller** (`services/poller.js`)
that runs the normal scan (`gh` sync + per-PR summarize) on the sprint whose window
contains today. It shares the same single-task lock as the manual buttons (so a poll and
a click never collide), is reentrancy-guarded, and `unref()`s its timer so it never keeps
the process alive. When a poll picks up changes it nudges the renderer to refresh.

### Per-PR summaries are inspectable and re-runnable
Because each PR is summarized in its own LLM call, the exact prompt for any one PR can be
shown, copied, and re-fired on demand from the inspector (`pr:inspect` builds the prompt +
diff + discussion with no model call; `pr:summarize` fires it and applies the result, and
the exchange lands in the Prompts tab like any other). This makes tuning the release-cycle
prompt a tight per-merge feedback loop instead of a whole-sprint re-classify.

### Report & summary conventions are research-backed
The product-notes report and per-PR summaries encode established release-notes and
changelog practice rather than ad-hoc prompt wording:

- **Write for humans, in the reader's terms.** Entries describe user-visible value, not
  implementation. Internal jargon, ticket IDs, codenames and file/symbol names are kept out
  of user-facing lines. (Keep a Changelog — "changelogs are for humans, not machines";
  Common Changelog; release-notes guidance.)
- **Be specific; never vague.** No "various bug fixes", "misc" or "improved performance"
  without the concrete what/scenario — these are the canonical anti-patterns. Raw PR/commit
  titles are never pasted verbatim; they are rephrased into value. (Keep a Changelog bad
  practices; Common Changelog rule "don't use `git log` output".)
- **Never bury breaking changes, deprecations or security fixes.** Each PR carries
  `breaking`/`security` flags and a Keep a Changelog `changelog_category`
  (added/changed/deprecated/removed/fixed/security); the report surfaces breaking changes,
  removals, deprecations and security fixes in a dedicated section up top, with the action a
  reader must take. **Breaking is also detected deterministically** by parsing Conventional
  Commit titles (`feat!:`, `fix(x)!:`) and `BREAKING CHANGE:` footers, so a breaking change
  is flagged even before — or if — a PR is summarized. (Semantic Versioning / Conventional
  Commits treat breaking changes as first-class; Keep a Changelog makes Security a category.)
- **Segment by audience.** Each PR is tagged `audience` (end-user / developer / admin /
  internal) so end-user release notes stay separate from developer/admin/API-facing changes.
- **Result-oriented user-impact voice.** The per-PR `user_impact` line is one concrete,
  result-oriented sentence ("Users can now…", "Long messages are no longer truncated");
  performance/reliability gains users feel count as user-facing. (Quiet release-notes guide.)
- **Highlight against feature-blindness.** A selective `highlight` flag + a Headlines
  section combat the well-documented tendency of readers to skip undifferentiated lists.
- **Group for the audience.** Changelogs group by *type* (Added/Changed/Fixed/…); these are
  *product notes*, so we group by product **area/theme** and separate user-facing from
  internal/under-the-hood and developer/admin/API-facing work. This area-grouping is a
  deliberate, context-dependent departure from the type-grouping convention.

Sources: Keep a Changelog (keepachangelog.com), Common Changelog (common-changelog.org),
Conventional Commits (conventionalcommits.org), Semantic Versioning (semver.org), GitHub PR
best practices, and practitioner release-notes guides.

### Sprints are explicit windows
Each repo has a cycle length (default 3 weeks). A sprint is a stored {start, end}
window; "New sprint" rolls over from the previous end date. Buckets live per sprint —
each cycle starts a fresh radar, which matches the retrospective framing.

### Local-first storage
A JSON document store in Electron's `userData` dir (`git-radar.json` for settings/
repos/sprints, one file per sprint for PRs/buckets/reports). Atomic writes
(tmp + rename). No server, no DB to install, trivially inspectable and portable.

## Architecture

```
src/main/                 Electron main process (ESM)
  main.js                 window + lifecycle
  preload.cjs             contextBridge API (sandboxed)
  ipc.js                  IPC surface; wires services; progress events
  services/
    store.js              JSON persistence (no electron imports → unit-testable)
    github.js             gh CLI wrapper (execFile, never a shell)
    ollama.js             Ollama /api/chat client, JSON-schema structured outputs
    mcp.js                MCP client manager (@modelcontextprotocol/sdk, stdio)
    prompts.js            all prompt builders + JSON schemas
    analyzer.js           sync / categorize / reorganize / report pipeline (DI'd)
    stats.js              pure statistics engine
    util.js               json extraction, truncation, time helpers
src/renderer/             no-build vanilla ES modules
  index.html, styles.css
  js/app.js               state + actions + routing
  js/api.js               typed wrapper over window.gitRadar
  js/views/{dashboard,report,settings}.js
  js/components/{charts,markdown}.js   hand-rolled SVG charts + md renderer
tests/                    node --test against the pure services
```

Services take dependencies by injection (`createAnalyzer({store, ollama, github,
mcp, emit})`) so the whole pipeline is testable with stubs — no Electron, no network.

## Cut from v1 (deliberately)

- Engineer-hour estimation beyond PR turnaround time (would be fiction)
- Review-latency / review-throughput stats (we now ingest PR comments + reviews as
  summarizer context, but don't yet compute review-cycle metrics from them)
- Cross-repo rollups (per-repo radar first; the store supports it later)
- Git Radar acting as an MCP *server* (exposing sprint stats to other agents) — the
  natural next step once the data model settles.
