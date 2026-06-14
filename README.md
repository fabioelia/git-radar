# 📡 Git Radar

A local-first Electron app that tracks **what your team actually shipped** each release
cycle. Merged PRs come in through the **GitHub CLI**, a **local Gemma LLM** (via Ollama)
organizes them into evolving **buckets of work**, and at sprint's end you get the story
with numbers:

- *How much time did we spend chasing defects for feature X?*
- *Which features were built but are entirely behind flags — invisible to users?*
- *How much of the cycle went to release mechanics (develop → stage → main) vs. real work?*
- *Did what we shipped match the sprint priorities?* — via **MCP** (e.g. Atlassian/Jira)

Everything runs on your machine. PR titles, bodies, and analysis never leave it.

> The full product thinking lives in [docs/DESIGN.md](docs/DESIGN.md).

## How it works

```
gh pr list ──► PR store ──► Gemma classifies into buckets ──► deterministic stats ──► sprint report
 (merged PRs    (JSON,        (structured JSON outputs,         (defect turnaround,     (LLM narrative;
  in the         local)        buckets = topics, reorganized     hidden features,        may call MCP tools
  sprint window)               as the cycle evolves)             timeline per branch)    for planned-vs-actual)
```

1. **Track a repo** and write its *release-cycle prompt* — free text the LLM reads on
   every pass, e.g.:

   > The newton monorepo releases every 3 weeks. General development merges into
   > `develop`; at code freeze we start merging into `stage`; we release by merging
   > `stage` into `main`. Feature work is usually gated behind LaunchDarkly flags.

2. **📡 Scan** — pulls PRs merged in the sprint window via `gh`, then summarizes each new
   one with Gemma in a single per-PR pass over its description, **changed-file list** and
   **discussion** (issue comments, review verdicts and inline review comments — all pulled
   deterministically): bucket, work type (feature/defect/chore/infra/…), behind-flag + flag
   name, user-facing, a one-line summary, a 2–4 sentence **detail** (what changed, why, risk,
   follow-ups), a release-notes-voice **user impact** line, a **Keep a Changelog category**
   (added/changed/deprecated/removed/fixed/security), an **audience** (end-user / developer /
   admin / internal), **breaking** / **security** flags, a **highlight** flag for
   announce-worthy changes, and a **risk** read. Breaking changes are *also* detected
   deterministically from **Conventional Commit** titles (`feat!:`, `BREAKING CHANGE:`), so
   they're flagged even before a PR is summarized. Buckets are *topics*, never types — a checkout bug fix
   lands in the **Checkout** bucket as a `defect`, so defect-chasing time aggregates per
   feature. Buckets get reorganized (merged/renamed) by a second LLM pass when they
   proliferate.

   Processing the queue: **Scan** syncs new merges and summarizes every *pending* PR in one
   run (progress names the PR being processed); **Summarize pending** (the ⋯ menu, or the
   banner on the radar) does the same over the synced backlog *without* re-syncing; and
   **auto-poll** does both automatically as merges land. The 🔍 inspector is for one PR at a
   time when you want to watch or tune it. "Pending" = never summarized **or** summarized
   with an older prompt: each summary is fingerprinted with the prompt version + your
   release-cycle prompt, so finished PRs are never redone on a re-scan — but edit the
   release-cycle prompt and the affected PRs are flagged `↻ stale` and re-summarized on the
   next run.

   - **🔍 Inspect a PR** — open any PR to see its diff, its discussion, the *exact* prompt
     Git Radar generates for it, and a button to re-fire the summarizer and watch how it
     behaves — handy for tuning the release-cycle prompt per merge.
   - **Auto-poll** (Settings) — since a local-first app can't receive GitHub webhooks, Git
     Radar can instead poll `gh` on an interval and summarize new merges into the live
     sprint automatically, so each PR is ready with detail before planning.

3. **📝 Report** — Gemma writes **product notes** for the cycle — *what shipped and why it
   matters* — from deterministically computed stats (the LLM never does arithmetic) plus a
   deterministic ledger of every merged PR (title, author, work type, churn, changed files,
   and each PR's release-notes-voice **user impact** + ★ highlights when summarized). The
   report is framed for a product owner: **Headlines**, **Breaking changes & security**
   (surfaced up top, never buried), **New for users** (release-notes changelog), **New &
   expanded capabilities**, **Fixes & reliability**, **Invisible this sprint** (flagged /
   internal work), **Where the effort went**, and **Watch-outs** — written in user language,
   specific (no "various fixes"), and told to infer product areas and user impact from
   titles/files rather than ever answering "unclassified" or pasting raw PR titles. These
   conventions follow Keep a Changelog, Conventional Commits and release-notes guidance
   (see [docs/DESIGN.md](docs/DESIGN.md)). Small sprints are written in one compact pass;
   large ones (≥2 buckets, >~60 PRs) switch automatically to **map-reduce** — each area is
   summarized in its own small call, the fragments are cached/persisted, and a final pass
   synthesizes them — so the prompt never overflows a local model's context. With MCP servers configured, it can call their tools first —
   e.g. fetch Jira sprint priorities — and add a *planned vs. actual* section.

4. **Prompts tab** — full transparency into the local LLM: every exchange is logged
   verbatim (system + user messages sent, raw response, duration, failures included)
   so you can always see exactly what Gemma was asked and how it answered.

## Requirements

| Tool | Why | Setup |
|---|---|---|
| Node.js ≥ 20.11 | run the app | nodejs.org |
| pnpm | package manager | `corepack enable` (bundled with Node) |
| GitHub CLI | fetch merged PRs (your existing auth, incl. SSO/Enterprise) | `brew install gh && gh auth login` |
| Ollama + Gemma | local analysis | [ollama.com](https://ollama.com), then `ollama pull gemma3:12b` (or `gemma3:4b` on lighter machines) |

## Run it

```bash
pnpm install
pnpm start
```

(`pnpm-workspace.yaml` pre-approves electron's postinstall — pnpm skips dependency
build scripts by default, and electron needs its script to download the platform binary.)

Then: **＋ Add repository** → enter `owner/repo`, the release-cycle prompt, cycle length,
and (optionally) tracked base branches like `develop, stage, main` → **📡 Scan**.

Health dots in the sidebar show `gh` auth and Ollama/model status at a glance.

## MCP: wiring in planning tools

Git Radar is an MCP *client*. In **Settings → MCP servers**, add stdio servers as a JSON
array; the report generator exposes their tools to the LLM:

```json
[
  {
    "name": "atlassian",
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]
  }
]
```

Any stdio MCP server works (`{name, command, args, env?}`). Tool calls are capped at 5
per report and run through a prompt-driven loop, so it works even with models that lack
native function-calling. If a server is down, the report still generates — just without
the planned-vs-actual section.

## What the numbers mean

- **Defect turnaround** — Σ (merge time − open time) over defect PRs in a bucket:
  wall-clock exposure to defect work, not engineer-hours.
- **Hidden feature (🙈)** — a bucket whose feature PRs are *all* behind flags or not
  user-facing: built, but users can't see it.
- **Avg PR cycle** — mean open→merge time across the sprint's merged PRs.
- **Merge timeline** — merges per day, stacked by base branch, which makes the
  develop→stage→main release phases visible across the cycle.

## Development

```bash
pnpm test         # node --test: stats engine, store, analyzer pipeline (stubbed LLM/gh/MCP), parsers
```

- `src/main/services/` — testable, dependency-injected services (no electron imports)
- `src/renderer/` — no-build vanilla ES modules; views are pure HTML-string renderers
- Data lives in Electron's `userData` dir as plain JSON (override with `GIT_RADAR_DATA_DIR`)

## Troubleshooting

- **`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` when running `pnpm`** — your corepack is
  outdated (common with homebrew-installed Node) and can't load modern pnpm. Fix:
  `npm install -g corepack@latest && corepack enable pnpm` — or skip corepack entirely
  with `npm i -g pnpm` (pnpm reads the `packageManager` pin itself).
- **"Cannot reach Ollama"** — start it: `ollama serve`, and check the URL in Settings.
- **Yellow `llm` dot** — Ollama is up but the configured model isn't pulled: `ollama pull gemma3:12b`.
- **Classification feels shallow** — try a bigger Gemma variant, or raise `num_ctx`
  (Settings) if your PRs have long bodies. Smaller models stay parseable thanks to
  JSON-schema-constrained outputs; they're just less nuanced.
- **`gh` errors** — `gh auth status` must succeed in a terminal first; for GitHub
  Enterprise, `gh auth login --hostname your.host`.
