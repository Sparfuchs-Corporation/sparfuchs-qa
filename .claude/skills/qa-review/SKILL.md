---
name: qa-review
description: Full QA review — intake interview, project discovery, risk triage, specialist agent delegation, and dual-file output (session log + report).
argument-hint: "[--full | --tier1 | --tier2] [--model-override opus|sonnet|haiku] [output directory — default: qa-reports/]"
disable-model-invocation: true
---

Comprehensive QA review that discovers a project, assesses risk, delegates to specialist agents via a tiered execution pipeline, and produces structured output files.

**KNOWN BOUNDARIES (inherent to static analysis — do NOT report these as fixable gaps)**:
- Runtime behavior (API responses, auth flow execution, focus management) cannot be tested without Stage 3 agents + auth credentials
- Vendor agreement verification (DPAs, ToS compliance) requires manual legal review
- Cloud Function performance (cold start, concurrency, cost) requires production monitoring tools
- Screen reader / assistive technology behavior requires manual testing or Playwright + axe-core
- Document these as inherent scope boundaries in the gap analysis, not as pipeline defects

**CRITICAL RULES**:
- Do NOT create files in `qa-reports/` beyond the ones specified below. The session log directory and its per-agent files are part of the specified output.
- File names MUST use today's calendar date (the date the review is run), NOT commit dates, analysis timestamps, or git log dates.
- **Session log = directory of per-agent files.** Instead of one monolithic file, create `{output-dir}/{YYYY-MM-DD}_{project-name}_session-log/`. Each agent writes its own file with its complete unedited output using the Write tool. **The orchestrator NEVER transcribes or summarizes agent output** — agents write their own files directly. Reviewers browse the directory offline. Aggregation data (agent status, validation, coverage) lives in `meta.json`, not in a separate index file. If `--summary` flag is passed, fall back to the old single-file session log with agent summaries.
- **Report = full findings, generated from findings.jsonl.** Every individual finding listed with file:line, description, and fix. The Findings sections are GENERATED from the findings.jsonl file, not written from memory. One finding per file:line pair — if a pattern repeats in 11 files, the report shows 11 numbered findings. Never batch or summarize (e.g., "11-15. Minor issues" is forbidden; "useSetup.ts + 10 more hooks" is forbidden — list each one).
- You produce 5 core output files (always), plus optional files when `--training` or `--docs` flags are present:
  1. `{YYYY-MM-DD}_{project-name}_session-log/` — session log **directory** containing:
     - `{HH-MM-SS}_{agent-name}.md` — one file per agent with complete output, named by local launch time (e.g., `04-21-33_build-verifier.md`, `04-33-12_security-reviewer.md`). Filesystem sort = execution order.
  2. `{YYYY-MM-DD}_{project-name}_qa-report.md` — all findings
  3. `{YYYY-MM-DD}_{project-name}_spec-report.md` — functional spec verification (from @spec-verifier)
  4. `{YYYY-MM-DD}_{project-name}_qa-gaps.md` — QA coverage gap analysis (from @qa-gap-analyzer)
  5. `{YYYY-MM-DD}_{project-name}_remediation-plan.md` — prioritized, phased action plan for fixing findings
  6. `{YYYY-MM-DD}_{project-name}_observability-gaps.md` — observability gap report (from @observability-auditor + @workflow-extractor)
  7. `{YYYY-MM-DD}_{project-name}_training-spec.md` — training content (when `--training`, OVERVIEW mode)
  6a. `{YYYY-MM-DD}_{project-name}_training-deep-{module}.md` — training deep-dive (when `--training` + `Module: X`)
  6b. `{YYYY-MM-DD}_{project-name}_training-journey-{slug}.md` — training journey (when `--training` + `Journey: X`)
  7. `{YYYY-MM-DD}_{project-name}_architecture.md` — architecture documentation (when `--docs`)

## Step 0: Intake Interview

Before any analysis, gather project metadata. Check if the user's prompt already contains pre-filled values (the `qa-review-remote.sh` wrapper provides these). If a value is present in the prompt (e.g., "Project name: X", "Initiated by: Y", "Write reports to: Z"), use it as the default. Only use AskUserQuestion for values that are NOT pre-filled. If all four values are provided, skip the interview entirely.

Gather these four values:

- **Project Name** — display name for reports (e.g., "Acme Web App"). If not pre-filled, default to the repo directory name.
- **Repo Location** — absolute path to the target repository root (default: current working directory)
- **Web URL** — GitHub/GitLab URL for the project (or "none")
- **Person Name** — who is initiating this QA review

Also check for a pre-filled credential path:

- **Credentials File** — If the prompt contains "Credentials file: /path", note the path. This means a temporary credentials JSON file was created by the setup wizard (`--auth` flag). Pass this path to generator agents (e2e-tester, crud-tester, contract-reviewer) during Step 5 delegation. **SECURITY: Never log the contents of the credential file to the session log.** Only log that credentials are available and the strategy type (read the `strategy` field from the file via `Bash(cat {path} | grep strategy)`).

Parse `$ARGUMENTS` for the output directory. If the prompt contains "Write reports to: /path/", use that path. Otherwise default to `qa-reports/` at the sparfuchs-qa repo root.

Generate using **today's date** (run `date '+%Y-%m-%d'` via Bash to get it — do NOT use commit dates or git log dates):
- **Run ID**: `qa-{YYYYMMDD}-{HHmm}-{random 4 hex chars}`
- **Timestamp**: today's date and current time in ISO 8601
- **File names** (use today's date, NOT any date from git history):
  - `{output-dir}/{YYYY-MM-DD}_{project-name-slug}_session-log.md`
  - `{output-dir}/{YYYY-MM-DD}_{project-name-slug}_qa-report.md`

Create the output directory if it doesn't exist (use Bash `mkdir -p`).

Also derive a `project-slug` (lowercase, hyphens, no spaces) from the project name. Create the qa-data directory for this project:
```bash
mkdir -p qa-data/{project-slug}/runs/{run-id}
mkdir -p qa-data/{project-slug}/findings
mkdir -p qa-data/{project-slug}/evolution
```

Create an empty streaming findings file:
```bash
touch qa-data/{project-slug}/runs/{run-id}/findings.jsonl
```

### Tier Coverage Warning

After determining the execution mode, log a tier coverage note to the session log:

- **`--tier1`**: `"Note: --tier1 runs static analysis only (Stages 0-1, ~21 of 37 agents). Excludes: dependency scanning, IaC review, test execution, live probing. For complete coverage, use --full."`
- **`--tier2`**: `"Note: --tier2 runs static analysis + integrity checks (Stages 0-2, ~31 of 37 agents). Excludes: test execution, live probing. For test execution, use --full."`
- **`--full`**: `"Running complete audit (all 4 stages, all 37 agents). Stage 3 live probing requires --auth flag for authenticated testing."`

## Step 0.5: Load Previous Baseline

Check if a previous baseline exists:
```bash
test -f qa-data/{project-slug}/current-baseline.json && echo "exists" || echo "none"
```

**If baseline exists**:
1. Read `qa-data/{project-slug}/current-baseline.json` — this contains the findings from the last run
2. Count findings and note the previous run ID (from the file)
3. Log to session log: `"Previous baseline loaded: {n} findings from run {previous-run-id}"`
4. Store in memory for delta computation in Step 6.25

**If no baseline exists**:
- Log: `"No previous baseline found — this is the first tracked run for {project-slug}"`

## Step 1: Initialize Output Files

Create the session log directory and write the index file and report header immediately after intake.

**Session Log Directory**: Create using Bash `mkdir -p`:
```bash
mkdir -p {output-dir}/{YYYY-MM-DD}_{project-name}_session-log
```

Note: If `--summary` flag was passed, create a single session log file instead of a directory (old behavior).

**File 1 — QA Report**: Write the header block using the Write tool:

```markdown
# QA Report — {Project Name}

| Field | Value |
|---|---|
| Project | {project name} |
| Repo | {repo path} |
| URL | {web url} |
| Reviewed by | {person name} |
| Date | {YYYY-MM-DD HH:MM} |
| Run ID | {run-id} |

---
```

The report body is written in Step 6 after all agents complete.

## Step 2: Project Discovery

Navigate to the target repo (`cd {repo path}` or read files at that path). Explore to build a project profile:

- **Tech stack**: read `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, or equivalent. Note language, framework, runtime version.
- **Architecture**: use Glob to find source directories, identify patterns (monorepo, layered, feature-based).
- **Test infrastructure**: check for `vitest.config.*`, `jest.config.*`, `playwright.config.*`, `.github/workflows/`, `cloudbuild.yaml`. Note test framework and CI system.
- **Dependencies**: count direct and dev dependencies from manifest. Note if lockfile exists.
- **Git state**: run `git branch --show-current`, `git log --oneline -5`, `git status --short` via Bash.
- **Size estimate**: run `find . -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.py' | grep -v node_modules | wc -l` via Bash for file count.

Append a `## Discovery` section to the session log using Edit with the full profile.

## Step 2.5: Detect Deployment Scope

For monorepos with multiple apps (detected if `workspaces` exists in root `package.json`, or if multiple directories under `apps/` contain `package.json` or `vite.config.*`), determine which parts are deployed to users vs pre-migration/future code.

**Detection method** (check in order, use all that match):

1. **Firebase hosting config** — read `firebase.json` → `hosting[].source` or `hosting[].public` → identifies which app(s) are deployed to hosting
2. **Cloud Build targets** — read `cloudbuild.*.yaml` → find build/deploy steps that reference specific app directories
3. **Module Federation config** — read the shell's `vite.config.ts` → find `remotes` entries in federation config → identifies which MFE apps are currently loaded at runtime
4. **Fallback** — if none of the above yields a clear answer, ask the user via AskUserQuestion

**User verification** (required — do NOT silently recategorize findings):

Present the detection results to the user via AskUserQuestion:
```
Auto-detected deployment scope:
  Deployed: apps/shell, libs/*, functions/, firestore/
  MFE pending: apps/crm, apps/tools, apps/marketing, apps/hr, apps/service, apps/admin

Findings in MFE-pending directories will be grouped separately (not demoted — severity preserved).
Stubs in deployed directories (apps/shell) remain at full severity.

Is this correct? If any MFE app is actually deployed or has real stubs that need fixing, let me know.
```

The user must confirm before any finding is recategorized. This prevents accidentally hiding real stubs as "future MFE code."

**Output**: Store `deployedPaths` and `mfePendingPaths` lists for use in Step 5 (finding tagging) and Step 6 (report grouping). Shared infrastructure paths (`libs/`, `functions/`, `firestore/`) are always classified as `deployed`.

Log to session log under `## Deployment Scope`:
```
Deployed (affecting users): {user-confirmed list}
MFE pending (not yet federated): {user-confirmed list}
Detection method: {method} + user confirmation
```

For single-app repos (no workspaces, no `apps/` directory), skip this step entirely — all findings are deployed.

## Step 3: Determine Review Scope

Parse `$ARGUMENTS` for execution mode flags. Only one mode flag is allowed:

| Flag | Mode | Description |
|---|---|---|
| `--full` | Complete Audit | All 4 stages including test execution, smoke testing, API probing, and live validation. Requires `--auth` for Stage 3 live probing. |
| `--tier1` | Static Analysis | Stage 0-1: build check + 17+ analysis agents (code, security, RBAC, RLAC, perf, a11y, compliance, deploy, spec, intent). **Excludes**: dependency scanning, test execution, live probing, IaC review. |
| `--tier2` | Static + Integrity | Stage 0-2: Tier 1 + dependency audit, SCA, IaC review, schema-migration, mock-integrity, env-parity, boundary fuzzing, test generation. **Excludes**: test execution, live probing. |
| (none) | Diff review | Risk triage picks agents based on what changed |

Also parse these **additive flags** (can combine with any tier):

| Flag | Effect |
|---|---|
| `--training` | After QA stages complete, run training content generation via `@training-system-builder` |
| `--docs` | After QA stages complete, run architecture documentation via `@architecture-doc-builder` |

These are NOT mutually exclusive with tier flags. `--full --training --docs` runs a complete audit plus generates training content and architecture docs.

Also check for training sub-mode keywords in the prompt:
- `Module: {name}` → training deep-dive on that module
- `Journey: {description}` → training cross-module journey

Also parse `--model-override {opus|sonnet|haiku}` — if present, ALL agents use this model regardless of their frontmatter `model` field. Log the override to the session log.

### Full Repo Audit (`--full`, `--tier1`, or `--tier2` flag present)

When any tier flag is passed, review ALL source files in the repo — not just a diff. This is a complete project audit.

1. Use Glob to find all source files in the target repo:
   - `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx` (excluding `node_modules/`, `dist/`, `.next/`, `build/`)
   - `**/*.py` (excluding `__pycache__/`, `.venv/`, `venv/`)
   - `**/*.go`, `**/*.rs`, `**/*.rb`, `**/*.java` as applicable
   - `**/*.css`, `**/*.scss`, `**/*.html`, `**/*.vue`, `**/*.svelte`
   - `Dockerfile*`, `docker-compose*`, `*.yaml`, `*.yml` (CI/IaC files)
2. Log scope as: `{mode} — {N} source files`
3. Agents are selected by tier (see Step 4), not by risk level
4. Agents analyze the full file list, not a diff — they read and review every file

### Diff Review (default — no tier flags)

Review only what changed:

- **If `git diff --cached` has content**: review staged changes
- **If `git diff` has content**: review unstaged changes
- **If neither**: review the last commit via `git diff HEAD~1`
- **If the user provides a PR number via the intake or arguments**: fetch with `gh pr diff {number}`

If there are no changes to review, write that to both files and stop.

### Log Scope

Log the scope decision to the session log under `## Scope`, including:
- Mode: `Full repo audit` or `Diff review`
- File count or diff stats
- What triggered this scope (flag, staged, unstaged, last commit, PR number)

## Step 4: Risk Triage & Tier Selection

### Tiered Execution (for `--full`, `--tier1`, `--tier2` modes)

When any tier flag is set, agents are grouped into tiers. Each tier runs sequentially — Tier 0 output informs Tier 1, Tier 1 output informs Tier 2, Tier 2 output informs Tier 3.

#### Stage 0: Build & Semantic Safety (always first, < 90s)

Purpose: catch build failures and semantic-breaking transformations before anything else runs.

| Agent | Purpose |
|---|---|
| `@build-verifier` | Run format, lint, typecheck, build — all errors grouped by root cause |
| `@semantic-diff-reviewer` | Detect automated transformations that change runtime behavior (function→arrow, removed assertions, async changes) |

**Run style**: Sequential (build-verifier first, then semantic-diff-reviewer).
**Gate**: Must have zero hard blockers to proceed. If the build is broken or a critical semantic issue exists (e.g., arrow function used as constructor), log: `"Stage 0 BLOCKED: {n} hard blockers. Fix before proceeding."` In interactive mode, pause for human remediation. In automated mode, continue with warnings.

#### Stage 1: Risk & Static Quality (parallel, 2-4 min)

Purpose: comprehensive static analysis — risk scoring, code quality, security, and structural review.

| Agent | Purpose |
|---|---|
| `@risk-analyzer` | Score overall project risk |
| `@regression-risk-scorer` | Git history analysis — churn rates, revert frequency, co-change coupling |
| `@code-reviewer` | Correctness, logic errors, null safety |
| `@security-reviewer` | Vulnerabilities, auth, injection |
| `@performance-reviewer` | Query efficiency, memory, bundle size |
| `@deploy-readiness-reviewer` | Env vars, missing indexes, config drift, fake data |
| `@contract-reviewer` | API contract alignment frontend/backend |
| `@rbac-reviewer` | Auth/role/permission consistency |
| `@access-query-validator` | Access query filtering — admin/manager bypass paths |
| `@permission-chain-checker` | Access permission lifecycle — reader arrays, role assignment, claims propagation |
| `@collection-reference-validator` | Collection/table name consistency across rules, services, functions |
| `@role-visibility-matrix` | Role x module visibility matrix — which roles can see which data |
| `@a11y-reviewer` | Accessibility |
| `@compliance-reviewer` | Data privacy, PII handling |
| `@dead-code-reviewer` | Orphaned code, unused exports |
| `@spec-verifier` | Features vs PRD/spec — Complete / Stubbed / Shell / Broken |
| `@ui-intent-verifier` | UI labels vs actual behavior |
| `@stub-detector` | Non-functional code — fake saves, hardcoded data, dead integrations, vibe-coded features |

**Run style**: All parallel.
**Gate**: Optional — warnings allowed, critical/high findings logged. If >50% features are Stubbed/Broken, log warning and tell Stage 2 agents to skip those files.
**If `--tier1`**: Stop here. Write report with Stage 0 + Stage 1 findings.

#### Stage 2: Integrity & Prep (parallel, 2-3 min)

Purpose: verify mock/env integrity, review infrastructure, generate test scripts for Stage 3.

| Agent | Purpose |
|---|---|
| `@schema-migration-reviewer` | Compare schema definitions against migrations — catch unmigrated tables |
| `@mock-integrity-checker` | Validate mocks match real implementation signatures |
| `@environment-parity-checker` | Env var/config consistency across environments |
| `@iac-reviewer` | Terraform, Docker, CI/CD configs |
| `@dependency-auditor` | Dependency health |
| `@sca-reviewer` | Supply chain vulnerabilities |
| `@api-spec-reviewer` | OpenAPI spec accuracy |
| `@doc-reviewer` | Documentation quality |
| `@crud-tester` | Generate CRUD test scripts |
| `@e2e-tester` | Generate E2E test specs |
| `@fixture-generator` | Generate test fixtures |
| `@boundary-fuzzer` | Generate edge-case fuzz test files (generate only, don't execute yet) |

**Run style**: All parallel.
**Input from Stage 1**: Generator agents use the feature map to only generate tests for functional features.
**Gate**: Optional — mock/env drift should be fixed before Stage 3 execution.
**If `--tier2`**: Stop here. Write report with Stages 0-2 findings.

#### Stage 3: Execution & Live Validation (sequential, 3-5 min)

Purpose: actually RUN tests and probe live APIs. Only valuable after Stages 0-2 pass.

| Agent | Purpose |
|---|---|
| `@test-runner` | Execute the project's existing test suite |
| `@smoke-test-runner` | Critical-path health checks against running environment (requires AUTH) |
| `@boundary-fuzzer` | Execute the fuzz tests generated in Stage 2 |
| `@api-contract-prober` | Real HTTP calls to verify API responses match types/specs (requires AUTH) |
| `@failure-analyzer` | Classify any test failures from the above agents |

**Run style**: Sequential — test-runner first, then smoke, then fuzz execution, then API probing, then failure-analyzer synthesizes all failures.
**Credential pass-through**: If credentials file was noted during intake, pass the path to `@smoke-test-runner` and `@api-contract-prober`.
**Gate**: Must have zero critical failures to get "SHIP" verdict from the release gate.

#### Stage 4: Synthesis & Gate (last, < 30s)

Purpose: aggregate all findings into one Go/No-Go decision.

| Agent | Purpose |
|---|---|
| `@qa-gap-analyzer` | Coverage gaps across the review — writes `_qa-gaps.md` |
| `@release-gate-synthesizer` | Aggregates all findings → risk score, confidence, verdict, top 3 actions |

**Run style**: Sequential — gap analyzer first, then release gate synthesizer.

### Diff Mode (default — no tier flags)

Delegate to `@risk-analyzer` with the target repo path and the diff from Step 3. Append the full risk-analyzer output to the session log under `## Risk Triage`.

Use the overall risk score to determine which agents to invoke:

| Risk Level | Agents to Invoke |
|---|---|
| **Low** | `@code-reviewer`, `@doc-reviewer` (if docs changed) |
| **Medium** | Above + `@security-reviewer` (if security-sensitive), `@performance-reviewer` (if perf-sensitive) |
| **High** | Above + `@sca-reviewer` (if deps changed), `@crud-tester` (if API/DB changed) |
| **Critical** | All available agents regardless of file type |

Always invoke `@code-reviewer` regardless of risk level.

In diff mode, the routing table conditions (next section) still apply — agents are only invoked when their trigger condition matches the changed files.

## Step 4.5: Large Codebase Chunking

If the target repo has **>50 source files** (determined during Discovery in Step 2), split work for general-purpose analysis agents to ensure full file coverage:

1. **Collect all source file paths** from the Glob in Step 3
2. **Split into chunks of ~25 files each**, grouping by directory to keep related files together:
   - Sort files by directory path
   - Create chunks where each chunk contains files from adjacent directories
   - Each chunk should be 20-30 files (never exceed 35)
3. **Chunked agents** — launch N parallel instances where N = ceil(total_files / 25):
   - `@code-reviewer` — general code quality needs to read every file
   - `@security-reviewer` — security patterns can exist in any file
   - `@performance-reviewer` — performance issues can exist in any file
   - `@a11y-reviewer` — only frontend files, so chunk count may be lower
   - Each instance receives its chunk as an explicit file list in the prompt: `"Review ONLY these files: {file1}, {file2}, ..."`
   - Name each instance with a suffix: `code-reviewer-chunk-1`, `code-reviewer-chunk-2`, etc.
   - After all chunks complete, merge findings (deduplicate by file:line)
4. **Unchunked agents** — these grep/glob for specific patterns and self-scope. Run once against full repo:
   - `@access-query-validator`, `@permission-chain-checker`, `@collection-reference-validator`, `@role-visibility-matrix`
   - `@rbac-reviewer`, `@deploy-readiness-reviewer`, `@spec-verifier`, `@ui-intent-verifier`
   - `@compliance-reviewer`, `@contract-reviewer`, `@dead-code-reviewer`, `@semantic-diff-reviewer`
   - `@build-verifier`, `@risk-analyzer`, `@regression-risk-scorer`
5. **Log the chunking decision** to the session log under `## Chunking`:
   ```
   Source files: {n}
   Chunk size: 25
   Chunks: {n}
   Chunked agents: code-reviewer ({n} instances), security-reviewer ({n}), performance-reviewer ({n}), a11y-reviewer ({n})
   Unchunked agents: {comma-separated list}
   ```

If the repo has ≤50 source files, skip chunking — run all agents once against the full repo.

## Step 5: Agent Delegation

For each agent selected in Step 4, run it against the target repo. Two agent types:

**ARCHITECTURE: Per-agent output files.** Each agent writes its own complete output to a dedicated file in the session log directory. The orchestrator does NOT copy agent output — that eliminates the summarization problem. The session log directory IS the forensic record.

### Analysis Agents (produce findings only)

For each:
1. **Determine the agent's output file path**: `{session-log-dir}/{HH-MM-SS}_{agent-name}.md`. The orchestrator tracks each agent's launch time and includes the timestamp in the filename. For chunked agents: `{HH-MM-SS}_{agent-name}-chunk-{N}.md`.
2. **Include the output file instruction in the delegation prompt**:
   ```
   IMPORTANT — Write your complete output to a file.
   At the END of your analysis, use the Write tool to write your ENTIRE response to:
     {agent-output-path}
   Do NOT use Bash for this — use the Write tool directly.
   This file must contain everything: every file you read, every grep you ran,
   every finding with evidence, every clean check. This IS the forensic record.
   ```
   **Why Write instead of Bash**: Bash heredocs can be blocked by safety hooks (seen in practice). The Write tool is always available to agents and handles large content without shell escaping issues.
3. **Run the agent** (in background for parallel stages)
4. **On completion, verify output file exists** via Glob. If MISSING, write whatever the agent returned (even if summarized from notification) to the output file as a fallback.
5. **Stream findings to JSONL (MANDATORY — report generation depends on this)**:
   a. After the agent completes and its output file exists, use Grep to extract ALL `<!-- finding: {...} -->` tags from the output file (not from memory).
   b. Validate each tag has required fields: `severity`, `category`, `file`, `title`, `fix`. If `line` is missing, set to 0.
   c. Add `agent` field (agent name) and `runId` field if not present.
   d. Read the current findings.jsonl, append the new entries, and Write the updated file.
   e. Count tags parsed vs findings the agent claimed to report. If mismatch, log: `"FINDING TAG GAP: {agent} reported {n} findings but only {m} tags parsed."` Then extract missing findings from the agent's prose output and create tags for them.
   f. After ALL agents complete, count total lines in findings.jsonl. Log: `"Total streamed findings: {n}"`.
7. **Expand batched agent findings**: If an agent's output batches multiple locations into one finding (e.g., "useSetup + 10 more hooks — 11 web hooks..."), the orchestrator MUST expand these into individual findings.jsonl entries:
   a. Identify all affected files/lines from the agent's text
   b. Create one JSONL entry per file:line, copying severity/category/fix
   c. Each entry gets a unique title (e.g., "useSetup falls back to MOCK_ data", "useKpiDashboard falls back to MOCK_ data")
   d. Add a `group` field linking them (e.g., `"group": "mock-fallback-hooks"`)
8. **Tag deployment scope**: If Step 2.5 detected deployment scope, add a `scope` field to each finding based on the file path: `"deployed"` if the file is in a deployed directory, `"mfe-pending"` if in an MFE-pending directory. Files in `libs/`, `functions/`, `firestore/` are always `"deployed"`.

### Coverage Enforcement (after all chunked agents complete)

**Target: 98% file coverage.** After all chunk instances of a chunked agent complete:

1. Collect the list of files each chunk instance actually read (from the agent's output — look for file paths in Read tool calls or grep results)
2. Compare against the assigned file list
3. If coverage < 98%:
   - Log: `"COVERAGE GAP: {agent} read {n}/{total} files ({pct}%). Missing: {file list}"`
   - Re-run the agent with ONLY the missed files as a follow-up chunk
   - Merge follow-up findings with original findings
   - Repeat until 98% reached or 3 retries exhausted
4. Include final coverage per agent in `meta.json` under `fileCoverage` key (written in Step 6.25)

### Generator Agents (produce executable scripts)

**Credential pass-through**: If a credentials file path was noted during intake, include it in the delegation prompt to generator agents (`@e2e-tester`, `@crud-tester`, `@contract-reviewer`): "Authenticated testing is available. Read the credential file at {path} using `Bash(cat {path})` and use the `strategy`, `credentials`, `target`, and `metadata` fields to generate test specs with proper authentication setup. Do NOT log the credential values — only log the strategy type."

For each:
1. **Determine the agent's output file path**: `{session-log-dir}/{HH-MM-SS}_{agent-name}.md` (same pattern as analysis agents).
2. Ensure `generated/{project-name}/` directory exists in the sparfuchs-qa repo (use Bash `mkdir -p`)
3. Run the agent, instructing it to:
   - Write scripts to `generated/{project-name}/{category}/`
   - Write its complete analysis output (including script contents, execution results, errors) to the output file using the Write tool
4. After generation, update `generated/{project-name}/manifest.json`:
   - If the file exists, read it first and merge new entries
   - Each entry: `{ "file": "{path}", "agent": "{name}", "timestamp": "{ISO}", "targetCommit": "{SHA}" }`
5. Attempt execution: run `npx tsx {generated-script}` via Bash
   - If external tool not installed (k6, etc.): log `"Script generated but not executed — {tool} not installed"`
   - If executed: capture full stdout/stderr
6. Verify the agent output file exists. If MISSING, write whatever was returned to the file as fallback.
7. Collect findings from execution results for the report

### Agent Routing Table

| Condition | Agent | Type | Stage |
|---|---|---|---|
| Always (Stage 0 — runs before all others) | `@build-verifier` | Analysis | 0 |
| Always (Stage 0 — after build-verifier) | `@semantic-diff-reviewer` | Analysis | 0 |
| Always | `@regression-risk-scorer` | Analysis | 1 |
| Always | `@code-reviewer` | Analysis | 1 |
| Always (or when deps change) | `@dependency-auditor` | Analysis |
| Dependency files changed (package.json, lockfile) | `@sca-reviewer` | Analysis |
| Security-sensitive files (auth, crypto, tokens) | `@security-reviewer` | Analysis |
| Performance-sensitive files (endpoints, DB, loops) | `@performance-reviewer` | Analysis |
| Documentation changed (.md, docstrings) | `@doc-reviewer` | Analysis |
| API routes or DB operations changed | `@crud-tester` | Generator |
| Frontend files changed (.tsx, .jsx, .vue, .css, .html) | `@a11y-reviewer` | Analysis |
| API route handlers AND client-side fetch/axios calls exist | `@contract-reviewer` | Generator |
| Route/navigation structure changed | `@e2e-tester` | Generator |
| Test failures detected during execution | `@failure-analyzer` | Analysis |
| Data models, user data, PII fields changed | `@compliance-reviewer` | Analysis |
| Terraform, Docker, CI/CD files changed | `@iac-reviewer` | Analysis |
| TypeScript type/interface definitions changed | `@fixture-generator` | Generator |
| Auth, role, permission, guard files changed | `@rbac-reviewer` | Analysis |
| Auth, role, permission, guard, access-control, policy, scope files changed | `@access-query-validator` | Analysis |
| Auth, role assignment, claims, user creation, access-builder files changed | `@permission-chain-checker` | Analysis |
| Collection/table/model references, security rules, or migration files changed | `@collection-reference-validator` | Analysis |
| Always (full audit) | `@role-visibility-matrix` | Synthesis |
| OpenAPI/Swagger specs OR API route handlers changed | `@api-spec-reviewer` | Analysis |
| Always (full audit) or repo hygiene concerns | `@dead-code-reviewer` | Analysis |
| Config files, env vars, database indexes/rules/migrations, CI/CD build configs, or data-handling/workflow logic changed | `@deploy-readiness-reviewer` | Analysis |
| Frontend files with interactive elements (buttons, forms, toggles, links) changed | `@ui-intent-verifier` | Analysis |
| Always (full audit) or interactive UI/handler/service files changed | `@stub-detector` | Analysis |

### Stage 2 Agents (Integrity & Prep)

| Condition | Agent | Type | Stage |
|---|---|---|---|
| Schema, migration, seed, or ORM model files changed (or full audit) | `@schema-migration-reviewer` | Analysis | 2 |
| Always (test files exist) | `@mock-integrity-checker` | Analysis | 2 |
| Always (env files exist) | `@environment-parity-checker` | Analysis | 2 |
| Always | `@boundary-fuzzer` | Generator (Stage 2: generate, Stage 3: execute) | 2/3 |

### Stage 3 Agents (Execution & Live Validation)

| Condition | Agent | Type | Stage |
|---|---|---|---|
| Always (test suite exists) | `@test-runner` | Execution | 3 |
| Running environment available (AUTH flag) | `@smoke-test-runner` | Execution | 3 |
| Running environment + API endpoints found | `@api-contract-prober` | Execution | 3 |
| Test failures detected in Stage 3 | `@failure-analyzer` | Analysis | 3 |

### Stage 4 Agents (Synthesis & Gate)

| Condition | Agent | Type | Stage |
|---|---|---|---|
| Always (full audit) or page/route/feature files changed | `@spec-verifier` | Analysis — writes `_spec-report.md` | 1 |
| Always | `@qa-gap-analyzer` | Analysis — writes `_qa-gaps.md` | 4 |
| Always — runs LAST | `@release-gate-synthesizer` | Synthesis — produces verdict + risk score | 4 |

Future agents:
- `@i18n-reviewer` — when locale/translation files change

## Step 5.5: Run Spec Verifier

After all domain agents complete (Step 5), run `@spec-verifier`:

1. Delegate to `@spec-verifier` with the target repo path, the run ID, today's date, and the output file path: `{output-dir}/{YYYY-MM-DD}_{project-slug}_spec-report.md`
2. The agent searches for PRD/spec documents. If found: Mode A (verify). If not: Mode B (reverse-engineer).
3. It writes the spec report directly to the output file
4. The agent writes its output to `{session-log-dir}/{HH-MM-SS}_spec-verifier.md` (include path in delegation prompt).

## Step 5.7: Training & Documentation Generation (optional)

Skip this step entirely if neither `--training` nor `--docs` flags are present.

### Training Content Generation (`--training` flag)

1. Detect training sub-mode from the user prompt:
   - `"Module: {name}"` → DEEP-DIVE mode on that module
   - `"Journey: {description}"` → JOURNEY mode
   - Neither → OVERVIEW mode

2. Determine the output file name:
   - OVERVIEW: `{output-dir}/{YYYY-MM-DD}_{project-slug}_training-spec.md`
   - DEEP-DIVE: `{output-dir}/{YYYY-MM-DD}_{project-slug}_training-deep-{module-slug}.md`
   - JOURNEY: `{output-dir}/{YYYY-MM-DD}_{project-slug}_training-journey-{journey-slug}.md`

3. Delegate to `@training-system-builder` with this prompt:

   ```
   Generate training content for this repository.
   
   Mode: {OVERVIEW / DEEP-DIVE / JOURNEY}
   {If DEEP-DIVE: "Module: {module name}"}
   {If JOURNEY: "Journey: {journey description}"}
   
   The session log at {session-log-path} contains analysis from these QA agents that already examined this codebase:
   - @spec-verifier: feature inventory (Complete/Stubbed/Shell/Broken), user personas, route map
   - @ui-intent-verifier: UI element inventory, handler traces, settings sweep
   - @rbac-reviewer: role definitions, hierarchy, route guards, permission matrix
   - @stub-detector: stub classifications (training blockers)
   - @collection-reference-validator: collection/table names, cross-references
   
   Read the session log to consume their findings. Do NOT re-discover what they already found.
   
   Write output to: {training output file path}
   Previous training specs (if any): {output-dir}/*_training-*.md
   ```

4. The agent writes its output to `{session-log-dir}/{HH-MM-SS}_training-system-builder.md`.

### Architecture Documentation (`--docs` flag)

1. Delegate to `@architecture-doc-builder` with this prompt:

   ```
   Generate architecture documentation for this repository.
   
   The session log at {session-log-path} contains analysis from these QA agents:
   - @spec-verifier: feature/route inventory
   - @rbac-reviewer: auth architecture, role hierarchy
   - @collection-reference-validator: data model references
   - @contract-reviewer: API contract analysis
   - @deploy-readiness-reviewer: env var/config architecture
   
   Read the session log to consume their findings. Do NOT re-discover what they already found.
   
   Write output to: {output-dir}/{YYYY-MM-DD}_{project-slug}_architecture.md
   ```

2. The agent writes its output to `{session-log-dir}/{HH-MM-SS}_architecture-doc-builder.md`.

## Step 6: Write Final Report

**CRITICAL RULE: ONE FINDING PER FILE:LINE. GENERATED FROM findings.jsonl.**

The Findings sections are GENERATED from findings.jsonl (compiled in Step 6.0 below), not written from memory. This ensures every finding is individually listed.

Rules:
1. **One finding per file:line pair.** If a pattern repeats in 11 files, the report shows 11 numbered findings.
2. **NEVER batch**: `"257. [stub] useSetup.ts:206 + 10 more hooks"` is FORBIDDEN. Write 11 separate findings.
3. **NEVER range-number**: `"11-15. Minor issues across X"` is FORBIDDEN.
4. **NEVER use vague locations**: `"Multiple routes lack role checks"` is FORBIDDEN. Each route gets its own finding.
5. **When agents batch despite instructions**: The orchestrator expanded batched findings in Step 5 item 7 BEFORE reaching this step.
6. **Related findings linked by `group`**: If findings share a root cause (linked by `group` field in JSONL), add a note after the last in the group: `> _Findings {n}-{m} share root cause: {group}. Can be batch-fixed._` Each finding STILL gets its own numbered line.
7. **Validation catches violations**: Step 6.1 scans the final report for anti-patterns and fixes them.

If an agent reported 15 findings, the report lists 15 findings. If an agent batched 11 locations into 1 finding, the report STILL lists 11 findings (one per location, expanded in Step 5 item 7).

### Step 6.0: Compile Findings from JSONL (required before writing report)

The findings.jsonl is the SINGLE SOURCE OF TRUTH for the Findings sections. Do NOT write findings from memory.

1. **Read findings.jsonl**: Read `qa-data/{project-name}/runs/{run-id}/findings.jsonl`. Parse each line as JSON.
2. **Deduplicate by file+line+rule**: If multiple agents reported the same file:line with the same rule, keep the entry with the most detailed title and fix. Prefer higher severity. Record contributing agents.
3. **Sort**: severity (critical > high > medium > low) > category > file path (alphabetical).
4. **Assign sequential numbers**: 1 through N across all severity sections.
5. **Format each finding**: `{n}. [{agent}] \`{file}:{line}\` — {title}. **Fix**: {fix}`
6. **Count and verify**: Total numbered findings MUST equal the deduplicated JSONL count.

Append the full report body to File 2 (`_qa-report.md`) using Edit:

```markdown
## Tier Summary

{Include this section when running in tiered mode (--full, --tier1, --tier2). Omit in diff mode.}

### Tier 1: Structure & Intent
- Features discovered: {n}
- Complete: {n} | Stubbed: {n} | Shell: {n} | Broken: {n}
- Decorative settings: {n}/{total}
- Unfulfilled UI intent contracts: {n}

### Tier 2: Code Quality (applied to {n} complete/partial features)
- Critical: {n} | High: {n} | Medium: {n} | Low: {n}

### Tier 3: Infrastructure & Tests
- Test scripts generated: {n}
- Infra findings: {n}

## Coverage Scope

**Mode**: {--tier1 / --tier2 / --full} | **Stages executed**: {0-1 / 0-2 / 0-4} | **Agents run**: {n} of 37

{If chunking was used:}
**Large codebase chunking**: {n} source files split into {n} chunks of ~25. Chunked agents ran {n} parallel instances each.

### File Coverage Matrix

{Include this if chunking was used (Step 4.5). Shows per-agent file coverage.}

| Agent | Files Assigned | Files Read | Coverage | Status |
|---|---|---|---|---|
| code-reviewer ({n} chunks) | {n} | {n} | {pct}% | PASS/RETRY |
| security-reviewer ({n} chunks) | {n} | {n} | {pct}% | PASS/RETRY |
| performance-reviewer ({n} chunks) | {n} | {n} | {pct}% | PASS/RETRY |
| a11y-reviewer ({n} chunks) | {n} | {n} | {pct}% | PASS/RETRY |

**Overall file coverage**: {pct}% (target: 98%)
**Unreviewed files**: {list, or "none"}

### Skipped agents (not in scope for this tier)

{Generate this table based on the tier. List every agent that was NOT invoked, with the tier flag needed to enable it. Omit rows for agents that DID run.}

| Check | Stage | Agent | Enable with |
|---|---|---|---|
| Dependency vulnerabilities | 2 | sca-reviewer | --tier2 or --full |
| Package health & currency | 2 | dependency-auditor | --tier2 or --full |
| Infrastructure-as-code | 2 | iac-reviewer | --tier2 or --full |
| Schema vs migration drift | 2 | schema-migration-reviewer | --tier2 or --full |
| Mock/real implementation sync | 2 | mock-integrity-checker | --tier2 or --full |
| Environment config parity | 2 | environment-parity-checker | --tier2 or --full |
| Edge-case input fuzzing | 2/3 | boundary-fuzzer | --tier2 or --full |
| Test suite execution | 3 | test-runner | --full |
| Critical-path smoke tests | 3 | smoke-test-runner | --full + --auth |
| Live API response validation | 3 | api-contract-prober | --full + --auth |
| Test failure classification | 3 | failure-analyzer | --full |

### Inherent limitations (not addressable by any tier)

- Runtime behavior (API responses, auth flow execution, focus management) requires live probing (--full + --auth) or manual testing
- Vendor agreement verification (DPAs, ToS compliance with Gemini, SendGrid, etc.) requires manual legal review
- Cloud Function performance (cold start, concurrency, cost) requires production monitoring tools
- Screen reader / assistive technology behavior requires manual testing or Playwright + axe-core

## Deployment Scope

{Include this section if Step 2.5 detected a monorepo with deployed vs MFE-pending directories. Omit for single-app repos.}

**Deployed (affecting users now)**: {n} findings across {file count} files in {directory list}
**MFE pending (pre-migration, not user-facing)**: {n} findings across {file count} files in {directory list}
**Detection method**: {method} + user confirmation

{Findings below are split: deployed findings at original severity first, then MFE-pending findings grouped separately with preserved severity labels.}

## Project Profile

{Discovery summary from Step 2 — tech stack, architecture, test infra, deps, git state, size}

## Risk Assessment

**Overall Risk: {CRITICAL/HIGH/MEDIUM/LOW}**

{Risk-analyzer summary — change stats, per-file breakdown, risk factors}

## Remediation Status

{Include this section if a previous baseline existed. Omit on first run.}

Compared against run {previous-run-id} ({previous-date}):

| Metric | Count |
|---|---|
| New findings | {n} |
| Recurring (unfixed) | {n} |
| Remediated since last run | {n} |
| Closure rate | {n}% |

### Remediated (fixed since last run)
{Strikethrough each remediated finding: ~~[category] `file:line` — description~~ FIXED}

### New (regressions or newly detected)
{List each new finding with severity and location}

### Recurring Critical (open for 2+ runs — please prioritize)
{List findings that have appeared in multiple consecutive runs}

## Findings — Deployed Code

{If Step 2.5 detected a monorepo with deployment scope, show deployed findings first. For single-app repos, use this section for all findings.}

Group by severity. Every finding individually listed — no batching, no summarizing.

### Critical
1. [{agent}] `{file}:{line}` — {full description}. **Fix**: {full suggestion}
2. [{agent}] `{file}:{line}` — {full description}. **Fix**: {full suggestion}

### High
3. [{agent}] `{file}:{line}` — {full description}. **Fix**: {full suggestion}

### Medium
4. [{agent}] `{file}:{line}` — {full description}. **Fix**: {full suggestion}

### Low
5. [{agent}] `{file}:{line}` — {full description}. **Fix**: {full suggestion}

{Omit empty severity sections. NEVER roll up multiple findings into one line.}

## Findings — MFE Pending (not yet deployed to users)

{Include this section only if Step 2.5 detected MFE-pending directories and the user confirmed them. Omit for single-app repos.}

{These findings will become actionable when the MFE app is federated. Grouped separately but severity preserved — "Would be Critical" means it IS critical once deployed. This ensures nothing is hidden during the migration period.}

### Would be Critical (when deployed)
1. [{agent}] `{file}:{line}` — {description}. **Affects**: {app name}

### Would be High (when deployed)
2. [{agent}] `{file}:{line}` — {description}. **Affects**: {app name}

{Omit empty severity sections.}

## Generated Artifacts

| File | Agent | Executed? | Result |
|---|---|---|---|
| `generated/{project}/crud-tests/{name}.test.ts` | crud-tester | Yes/No | {pass/fail summary or reason not executed} |

{Omit this section if no generator agents ran}

## Agents Run

| Agent | Type | Triggered By | Findings |
|---|---|---|---|
| code-reviewer | Analysis | always | {count} |
| security-reviewer | Analysis | {trigger reason} | {count} |
| crud-tester | Generator | {trigger reason} | {count} |

## Verdict

**{PASS / NEEDS CHANGES / BLOCKED}**

{If PASS: "No critical or high findings. Code is ready for review."}
{If NEEDS CHANGES: List the blocking issues that must be addressed.}
{If BLOCKED: Critical security or supply-chain issues that must be resolved before any further review.}

## Statistics

- Total findings: {n}
- By severity: {critical} critical, {high} high, {medium} medium, {low} low
- Agents invoked: {n} ({analysis count} analysis, {generator count} generators)
- Scripts generated: {n}
- Scripts executed: {n}
- Duration: {elapsed time}
```

## Step 6.1: Validate Report Completeness

After writing the report, verify completeness and format:

1. **Count findings in report**: Count all numbered findings in the Findings sections using Grep for lines matching the pattern `^\d+\. \[`.
2. **Count findings in JSONL**: Count lines in `qa-data/{project-name}/runs/{run-id}/findings.jsonl` (after deduplication in Step 6.0).
3. **Compare**:
   - Report count < JSONL count: findings lost during report writing. Log `"VALIDATION FAIL: Report has {n} but JSONL has {m}."` Re-read JSONL, identify missing entries, append to correct severity section.
   - Report count > JSONL count: findings added without tags. Log warning and backfill JSONL.
   - Counts match: Log `"VALIDATION PASS: {n} findings in both report and JSONL."`.
4. **Scan for anti-patterns** in the report:
   - `+ \d+ more` — indicates batching
   - `\d+-\d+\. ` — indicates range-numbered findings
   - `Multiple ` or `Various ` at start of a finding description — indicates vague findings
   - Lines matching the finding format that lack backtick-wrapped `file:line` — indicates missing location
   For each anti-pattern found, log a warning and fix it inline.
5. **Log validation result** — include in `meta.json` under `reportValidation` key (written in Step 6.25).

## Step 6.25: Build Findings Index & Delta

After writing the report, process the streamed findings for cross-run tracking:

1. **Read JSONL**: Read `qa-data/{project-slug}/runs/{run-id}/findings.jsonl` via Bash. Each line is a JSON finding object.
2. **Deduplicate**: If the same finding ID appears multiple times (e.g., from two agents), keep the higher-severity version. Write the deduplicated array to `qa-data/{project-slug}/runs/{run-id}/findings-final.json`.
3. **Compute delta** (if baseline exists from Step 0.5):
   - **New findings**: in current but not in baseline
   - **Recurring findings**: in both current and baseline
   - **Remediated findings**: in baseline but not in current
   - Calculate closure rate: `remediated / previous_total * 100`
   - Write delta to `qa-data/{project-slug}/runs/{run-id}/delta.json`
4. **Update finding index**: Read `qa-data/{project-slug}/findings/index.json` (create if missing). For each finding:
   - New → add with lifecycle `open`, `occurrenceCount: 1`
   - Recurring → increment `occurrenceCount`, update `lastSeenAt`
   - Remediated → transition lifecycle: `open` → `remediated`, `remediated` → `verified`, `verified` → `closed`
   - Write updated index back
5. **Update baseline**: Copy `findings-final.json` to `qa-data/{project-slug}/current-baseline.json`
6. **Write run metadata**: Write `qa-data/{project-slug}/runs/{run-id}/meta.json` with: runId, projectSlug, branch, commit, mode, agents run, verdict, stats (total, by severity, new/recurring/remediated counts)
7. **Log delta to session log**: Append a `## Remediation Delta` section with new/recurring/remediated counts and closure rate

If this is the first run (no baseline), skip steps 3-4 and just write the baseline and metadata.

## Step 7.5: Generate Remediation Plan

After writing the report and session log, generate File 5: `{output-dir}/{YYYY-MM-DD}_{project-slug}_remediation-plan.md`

This is a structured, prioritized action plan a developer can take directly into plan mode before coding. It transforms findings into phased work items grouped by dependency order.

### How to generate

1. Read back all findings from the session log and qa-report
2. Cross-reference with `@spec-verifier` feature map and `@ui-intent-verifier` intent analysis (if they ran)
3. Group findings by dependency: what must be fixed first for other fixes to be possible
4. Assign each finding to a phase
5. For findings where working code exists elsewhere in the repo (detected by spec-verifier's "Backend without frontend" or intent-verifier's "existing implementation" notes), include "Existing code to reuse" references

### Remediation plan format

```markdown
# Remediation Plan — {Project Name}

**Generated**: {date} | **Run ID**: {run-id} | **Total findings**: {n}

## Executive Summary

{2-3 sentences: project state, most important thing to fix first, rough scope of work ahead}

## Phase 1: Foundation (fix these first — everything else depends on them)

Blocking issues. Other fixes will be wasted effort if these aren't resolved.

### 1.1 {Title} — {Severity}
- **What's wrong**: {1-2 sentence summary}
- **Why it blocks**: {what other features/fixes depend on this}
- **Files to modify**: {file paths with line numbers}
- **Approach**: {concrete steps — not "fix the bug" but specific guidance like "replace calendarConnectionsService.create() with the OAuth flow from Integrations.tsx:74-90"}
- **Existing code to reuse**: {reference working implementations found elsewhere in repo, if any}
- **Acceptance criteria**: {how to verify this is fixed}
- **Estimated scope**: Small (1-2 files) / Medium (3-5 files) / Large (6+ files)

## Phase 2: Wiring (connect the pieces)

Features that exist but aren't wired up. The code is there, just needs connecting.

### 2.1 {Title}
- **What exists**: {what's already built and where}
- **What's missing**: {the connection/glue that's absent}
- **Files to modify**: ...
- **Approach**: ...
- **Acceptance criteria**: ...
- **Estimated scope**: ...

## Phase 3: Completeness (fill the gaps)

Features that are partially implemented or stubbed. Real work needed, not just wiring.

## Phase 4: Hardening (quality & safety)

Security, performance, accessibility, infrastructure findings. Only worth tackling after Phases 1-3.

## Phase 4.5: Observability & Instrumentation

Gaps in logging, metrics, audit trails, and security event coverage identified by `@observability-auditor` (12-dimension audit). Organized by remediation tier.

### 4.5.1 Tier 1 — Security Observability (SIEM/Syslog feed)
{Auth audit logging, rate limit events, security event instrumentation — gaps from dimensions 7, 9}
- **What's missing**: {specific gaps}
- **Why it matters**: {incident response, threat detection, compliance}
- **Files to modify**: {paths}
- **Approach**: {concrete steps}

### 4.5.2 Tier 2 — Operational Observability
{Structured logging, error context, tracing, log enrichment, tiered logging — gaps from dimensions 1-4, 8, 10}
- **What's missing**: {specific gaps}
- **Files to modify**: {paths}
- **Approach**: {concrete steps}

### 4.5.3 Tier 3 — Business & Compliance Observability
{Business metrics, funnel tracking, compliance event trail — gaps from dimensions 5-6, 11-12}
- **What's missing**: {specific gaps}
- **Files to modify**: {paths}
- **Approach**: {concrete steps}

## Phase 5: Polish (nice-to-haves)

Low-severity findings, documentation gaps, code style.

## Dependency Graph

{Which items block which — ASCII art or simple notation}

Phase 1.1 (credentials) ──► Phase 1.2 (wire OAuth) ──► Phase 2.1 (calendar sync)
Phase 1.1 ──► Phase 2.3 (settings persistence)

## Decorative / Non-Functional Features

{Explicit list of features that are 100% theater — developer decides: build for real or remove}

| Feature | Location | Verdict | Recommendation |
|---|---|---|---|
| {feature} | {file}:{line} | DECORATIVE | {build for real OR remove and show actual state} |
```

{Omit empty phases. Every finding from the qa-report must appear in exactly one phase.}

## Step 7.6: Generate Observability Gap Report

After the remediation plan, generate File 6: `{output-dir}/{YYYY-MM-DD}_{project-slug}_observability-gaps.md`

This consolidates `@observability-auditor` (12-dimension coverage matrix) and `@workflow-extractor` (step-by-step observability cross-reference) into a standalone gap report.

### How to generate

1. Read the `@observability-auditor` session output from `{session-log-dir}/{HH-MM-SS}_observability-auditor.md`
2. Read the `@workflow-extractor` session output from `{session-log-dir}/{HH-MM-SS}_workflow-extractor.md`
3. If either agent did not run, generate a partial report from whichever is available
4. Consolidate into the format below

### Observability gap report format

```markdown
# Observability Gap Report — {Project Name}

**Generated**: {date} | **Run ID**: {run-id}

## Executive Summary

{2-3 sentences: overall observability posture, most critical gaps, % of workflow steps with full coverage}

## Workflow Observability Map

{For each workflow discovered by @workflow-extractor, show the step-by-step view with observability status}

### Workflow: "{name}"

| Step | Phase | Description | Code Location | Status | Logging | Metrics | Audit Trail | Observable? |
|---|---|---|---|---|---|---|---|---|
| 1 | ENTRY | Widget loads | widget.js:loadWidget() | VERIFIED | NO | NO | NO | NO |
| 2 | SUBMIT | Message sent | POST /api/chat | VERIFIED | PARTIAL | NO | NO | PARTIAL |

**Gap impact**: {which steps are blind spots for debugging, security, analytics}

## Coverage Matrix (All 12 Dimensions)

{Copy from @observability-auditor output — both Tier A and Tier B matrices}

## Tiered Remediation Recommendations

### Tier 1 — Immediate (Security & Incident Response)
{Audit event logging gaps, rate limit silencing, swallowed errors — these block incident investigation}

- [ ] Add auth success/failure logging to {handlers}
- [ ] Add rate limit event logging to {middleware}
- [ ] Configure separate audit log stream

### Tier 2 — Standard (Operational Visibility)
{Structured logging, error context, tracing, log enrichment — these enable day-to-day debugging}

- [ ] Replace console.log with structured logger in {files}
- [ ] Add request context propagation via AsyncLocalStorage
- [ ] Configure log level via LOG_LEVEL environment variable

### Tier 3 — Advanced (Business Intelligence & Compliance)
{Business metrics, funnel tracking, compliance event trail — these enable analytics and audit readiness}

- [ ] Add per-step counters for {workflows}
- [ ] Implement data lifecycle logging for {collections/tables}
- [ ] Add consent change tracking

## Gaps by Impact

### Increases Bug Identification Time
{Gaps that make bugs harder to find — swallowed errors, missing logging, no correlation IDs}

### Reduces User Support Capability
{Gaps that prevent tracing a user's journey — no requestId propagation, no session tracking}

### Blocks Compliance Audit
{Gaps an auditor would flag — missing data access logging, no consent trail, no retention logging}

### Prevents Threat Detection
{Gaps that reduce SIEM effectiveness — silent rate limiting, no auth failure counting, no security event stream}

### Hides Business Performance
{Gaps that prevent measuring workflow effectiveness — no step metrics, no funnel tracking}
```

## Step 7.75: Run QA Gap Analyzer

Run `@qa-gap-analyzer` as the final analysis step:

1. Delegate to `@qa-gap-analyzer` with paths to the QA report, spec report, observability gaps report, and the target repo path
2. The agent reads all files, independently explores the repo, and produces `{output-dir}/{YYYY-MM-DD}_{project-slug}_qa-gaps.md`

## Step 8: Present Results

Present all file paths and the delta summary to the user:

```
QA review complete.

QA report:            {report path}
Spec report:          {spec-report path}
Remediation plan:     {remediation-plan path}
Observability gaps:   {observability-gaps path}
Gap analysis:         {qa-gaps path}
Session log dir:      {session-log directory path}
Findings data:        qa-data/{project-slug}/runs/{run-id}/

{If delta exists:}
Compared to last run ({previous-run-id}):
  Fixed:     {remediated count}
  New:       {new count}
  Recurring: {recurring count}
  Closure rate: {n}%

{If deployment scope detected:}
Deployment scope:
  Deployed findings:    {n} (affecting users now)
  MFE-pending findings: {n} (not yet deployed)

{If not --full:}
Coverage: {n} of 37 agents ran (Stages {stages}). File coverage: {pct}%.
Skipped: {comma-separated skipped categories}.
Run `--tier2` for integrity checks or `--full` for test execution + live probing.
```
