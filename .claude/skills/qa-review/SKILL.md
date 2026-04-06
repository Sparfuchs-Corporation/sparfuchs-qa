---
name: qa-review
description: Full QA review — intake interview, project discovery, risk triage, specialist agent delegation, and dual-file output (session log + report).
argument-hint: "[--full | --tier1 | --tier2] [--model-override opus|sonnet|haiku] [output directory — default: qa-reports/]"
disable-model-invocation: true
---

Comprehensive QA review that discovers a project, assesses risk, delegates to specialist agents via a tiered execution pipeline, and produces structured output files.

**CRITICAL RULES**:
- Do NOT create additional files in `qa-reports/` beyond the ones specified below (no raw JSON dumps, no per-agent output files, no intermediate results).
- File names MUST use today's calendar date (the date the review is run), NOT commit dates, analysis timestamps, or git log dates.
- **Session log = full debug log.** Think of it as console output at maximum verbosity. Every agent's complete unedited response, every error message, every tool call result, every file read, every search executed. Never summarize or condense anything in the session log. It is the forensic record of exactly what happened during the review.
- **Report = full findings.** Every individual finding from every agent listed with file:line, description, and fix. Never batch or summarize findings (e.g., "11-15. Minor issues" is forbidden — list each one).
- You produce EXACTLY 5 output files. No more, no less:
  1. `{YYYY-MM-DD}_{project-slug}_session-log.md` — full debug log
  2. `{YYYY-MM-DD}_{project-slug}_qa-report.md` — all findings
  3. `{YYYY-MM-DD}_{project-slug}_spec-report.md` — functional spec verification (from @spec-verifier)
  4. `{YYYY-MM-DD}_{project-slug}_qa-gaps.md` — QA coverage gap analysis (from @qa-gap-analyzer)
  5. `{YYYY-MM-DD}_{project-slug}_remediation-plan.md` — prioritized, phased action plan for fixing findings

## Step 0: Intake Interview

Before any analysis, gather project metadata. Check if the user's prompt already contains pre-filled values (the `qa-review-remote.sh` wrapper provides these). If a value is present in the prompt (e.g., "Project name: X", "Initiated by: Y", "Write reports to: Z"), use it as the default. Only use AskUserQuestion for values that are NOT pre-filled. If all four values are provided, skip the interview entirely.

Gather these four values:

- **Project Name** — display name for reports (e.g., "Sparfuchs", "The Forge"). If not pre-filled, default to the repo directory name.
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

Write both files immediately after intake.

**File 1 — Session Log**: Write using the Write tool:

```markdown
# QA Session Log — {Project Name}

**Run ID**: {run-id}
**Date**: {YYYY-MM-DD HH:MM}
**Person**: {person name}
**Repo**: {repo path}
**URL**: {web url}
**Output Dir**: {output dir}

---

## Intake Complete
- Project: {project name}
- Repo: {repo path}
- URL: {web url}
- Initiated by: {person name}
- Output directory: {output dir}
- Run ID: {run-id}
```

**File 2 — QA Report**: Write the header block using the Write tool:

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

## Step 3: Determine Review Scope

Parse `$ARGUMENTS` for execution mode flags. Only one mode flag is allowed:

| Flag | Mode | Description |
|---|---|---|
| `--full` | Full tiered audit | All 3 tiers against full repo, with tier gating |
| `--tier1` | Structure & Intent only | Quick structural audit — feature map + intent verification |
| `--tier2` | Structure + Quality | Tier 1 + code quality/security agents, no test generation |
| (none) | Diff review | Risk triage picks agents based on what changed |

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

## Step 5: Agent Delegation

For each agent selected in Step 4, run it against the target repo. Two agent types:

**CRITICAL RULE: The session log is a FULL DEBUG LOG.** It must capture everything — like console output with full verbosity. Every agent communication, every error, every tool call result, every file that was read, every search that was run. The session log is the forensic record of exactly what happened. Never summarize, condense, or omit output. If an agent returned 500 lines of analysis, all 500 lines go in the session log.

### Analysis Agents (produce findings only)

For each:
1. Append `### {Agent Name} — {timestamp}` to session log
2. Append `Delegating to @{agent-name}...` to session log
3. Run the agent
4. Append the agent's **complete, unedited output** to the session log — every finding, every file it examined, every error it hit, every note it made. Do NOT summarize or paraphrase. Copy the full agent response verbatim.
5. If the agent hit errors or permission issues, log those too with full error messages
6. Collect findings (file, line, severity, issue, fix) for the report
7. **Stream findings to JSONL**: Parse `<!-- finding: {...} -->` tags from the agent's output. For each tag found, append the JSON object as a line to `qa-data/{project-slug}/runs/{run-id}/findings.jsonl` via Bash: `echo '{json}' >> qa-data/{project-slug}/runs/{run-id}/findings.jsonl`. Add the `agent` field if not present in the tag.

### Generator Agents (produce executable scripts)

**Credential pass-through**: If a credentials file path was noted during intake, include it in the delegation prompt to generator agents (`@e2e-tester`, `@crud-tester`, `@contract-reviewer`): "Authenticated testing is available. Read the credential file at {path} using `Bash(cat {path})` and use the `strategy`, `credentials`, `target`, and `metadata` fields to generate test specs with proper authentication setup. Do NOT log the credential values — only log the strategy type."

For each:
1. Append `### {Agent Name} — {timestamp}` to session log
2. Ensure `generated/{project-name-slug}/` directory exists in the sparfuchs-qa repo (use Bash `mkdir -p`)
3. Run the agent, instructing it to write scripts to `generated/{project-name-slug}/{category}/`
4. After generation, update `generated/{project-name-slug}/manifest.json`:
   - If the file exists, read it first and merge new entries
   - Each entry: `{ "file": "{path}", "agent": "{name}", "timestamp": "{ISO}", "targetCommit": "{SHA}" }`
5. Attempt execution: run `npx tsx {generated-script}` via Bash
   - If external tool not installed (k6, etc.): log `"Script generated but not executed — {tool} not installed"`
   - If executed: capture full stdout/stderr
6. Append **everything** inline to the session log: the agent's full output, the generated script contents, the complete execution output (stdout + stderr), exit codes, and any errors. Do NOT create separate output files and do NOT truncate.
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
4. Append the agent's full verbatim output to the session log under `### Spec Verifier — {timestamp}`

## Step 6: Write Final Report

**CRITICAL RULE: FULL DETAIL, NEVER SUMMARIZE.** Every single finding from every agent must be listed individually with its file path, line number, full description, and fix. NEVER batch findings like "11-15. Minor issues across X" — each one gets its own numbered line with specifics. The entire point of specialist agents is their detailed analysis. If an agent reported 15 findings, the report lists 15 findings.

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

## Findings

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

## Step 7: Finalize Session Log

Append a closing section to the session log using Edit:

```markdown
---

## Session Complete

- **Agents run**: {comma-separated list}
- **Total findings**: {n}
- **Verdict**: {PASS/NEEDS CHANGES/BLOCKED}
- **Report written to**: {report file path}
- **Spec report**: {spec report file path}
- **Session log**: {session log file path}
- **Duration**: {elapsed time}
- **Completed**: {ISO timestamp}
```

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

## Step 7.75: Run QA Gap Analyzer

After the session log is finalized, run `@qa-gap-analyzer` as the very last step:

1. Delegate to `@qa-gap-analyzer` with paths to the session log, QA report, spec report, and the target repo path
2. The agent reads all three files, independently explores the repo, and produces `{output-dir}/{YYYY-MM-DD}_{project-slug}_qa-gaps.md`
3. Append the gap analyzer's full verbatim output to the session log under `### QA Gap Analyzer — {timestamp}`

## Step 8: Present Results

Present all five file paths and the delta summary to the user:

```
QA review complete.

Session log:        {session-log path}
QA report:          {report path}
Spec report:        {spec-report path}
Gap analysis:       {qa-gaps path}
Remediation plan:   {remediation-plan path}
Findings data:      qa-data/{project-slug}/runs/{run-id}/

{If delta exists:}
Compared to last run ({previous-run-id}):
  Fixed:     {remediated count}
  New:       {new count}
  Recurring: {recurring count}
  Closure rate: {n}%
```
