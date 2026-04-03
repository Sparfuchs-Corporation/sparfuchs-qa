---
name: qa-review
description: Full QA review — intake interview, project discovery, risk triage, specialist agent delegation, and dual-file output (session log + report).
argument-hint: "[output directory — default: qa-reports/]"
disable-model-invocation: true
---

Comprehensive QA review that discovers a project, assesses risk, delegates to specialist agents, and produces exactly two local output files: a structured session log and a final QA report.

**CRITICAL RULES**:
- You must produce EXACTLY 2 output files. No more. All agent output goes inline into these two files.
- Do NOT create additional files in `qa-reports/` (no raw JSON dumps, no per-agent output files, no intermediate results).
- File names MUST use today's calendar date (the date the review is run), NOT commit dates, analysis timestamps, or git log dates.
- All raw agent output, execution results, and intermediate data goes into the session log. The report gets the synthesized summary only.

## Step 0: Intake Interview

Before any analysis, gather project metadata using AskUserQuestion. Ask all four in a single prompt:

- **Project Name** — display name for reports (e.g., "Sparfuchs", "The Forge")
- **Repo Location** — absolute path to the target repository root (default: current working directory)
- **Web URL** — GitHub/GitLab URL for the project (or "none")
- **Person Name** — who is initiating this QA review

Parse `$ARGUMENTS` for the output directory. Default to `qa-reports/` at the sparfuchs-qa repo root.

Generate using **today's date** (run `date '+%Y-%m-%d'` via Bash to get it — do NOT use commit dates or git log dates):
- **Run ID**: `qa-{YYYYMMDD}-{HHmm}-{random 4 hex chars}`
- **Timestamp**: today's date and current time in ISO 8601
- **File names** (use today's date, NOT any date from git history):
  - `{output-dir}/{YYYY-MM-DD}_{project-name-slug}_session-log.md`
  - `{output-dir}/{YYYY-MM-DD}_{project-name-slug}_qa-report.md`

These are the ONLY two files you will create. Do not create any other files in the output directory.

Create the output directory if it doesn't exist (use Bash `mkdir -p`).

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

Determine what code to review:

- **If `git diff --cached` has content**: review staged changes
- **If `git diff` has content**: review unstaged changes
- **If neither**: review the last commit via `git diff HEAD~1`
- **If the user provides a PR number via the intake or arguments**: fetch with `gh pr diff {number}`

Log the scope decision to the session log under `## Scope`.

If there are no changes to review, write that to both files and stop.

## Step 4: Risk Triage

Delegate to `@risk-analyzer` with the target repo path and the diff from Step 3.

Append the full risk-analyzer output to the session log under `## Risk Triage`.

Use the overall risk score to determine which agents to invoke:

| Risk Level | Agents to Invoke |
|---|---|
| **Low** | `@code-reviewer`, `@doc-reviewer` (if docs changed) |
| **Medium** | Above + `@security-reviewer` (if security-sensitive), `@performance-reviewer` (if perf-sensitive) |
| **High** | Above + `@sca-reviewer` (if deps changed), `@crud-tester` (if API/DB changed) |
| **Critical** | All available agents regardless of file type |

Always invoke `@code-reviewer` regardless of risk level.

## Step 5: Agent Delegation

For each agent selected in Step 4, run it against the target repo. Two agent types:

### Analysis Agents (produce findings only)

For each:
1. Append `### {Agent Name} — {timestamp}` to session log
2. Append `Delegating to @{agent-name}...` to session log
3. Run the agent
4. Append the agent's full output to the session log
5. Collect findings (file, line, severity, issue, fix) for the report

### Generator Agents (produce executable scripts)

For each:
1. Append `### {Agent Name} — {timestamp}` to session log
2. Ensure `generated/{project-name-slug}/` directory exists in the sparfuchs-qa repo (use Bash `mkdir -p`)
3. Run the agent, instructing it to write scripts to `generated/{project-name-slug}/{category}/`
4. After generation, update `generated/{project-name-slug}/manifest.json`:
   - If the file exists, read it first and merge new entries
   - Each entry: `{ "file": "{path}", "agent": "{name}", "timestamp": "{ISO}", "targetCommit": "{SHA}" }`
5. Attempt execution: run `npx tsx {generated-script}` via Bash
   - If external tool not installed (k6, etc.): log `"Script generated but not executed — {tool} not installed"`
   - If executed: capture stdout/stderr
6. Append generation summary and execution results (including raw output) **inline to the session log** — do NOT create separate output files
7. Collect findings from execution results for the report

### Agent Routing Table

| Condition | Agent | Type |
|---|---|---|
| Always | `@code-reviewer` | Analysis |
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

Future agents (Phase 3+):
- `@compliance-reviewer` — when data models/user data change
- `@iac-reviewer` — when Terraform/Docker/CI files change
- `@fixture-generator` — when type definitions change

## Step 6: Write Final Report

Append the full report body to File 2 (`_qa-report.md`) using Edit:

```markdown
## Project Profile

{Discovery summary from Step 2 — tech stack, architecture, test infra, deps, git state, size}

## Risk Assessment

**Overall Risk: {CRITICAL/HIGH/MEDIUM/LOW}**

{Risk-analyzer summary — change stats, per-file breakdown, risk factors}

## Findings

### Critical
- [{agent}] `{file}:{line}` — {issue}. **Fix**: {suggestion}

### High
- [{agent}] `{file}:{line}` — {issue}. **Fix**: {suggestion}

### Medium
- [{agent}] `{file}:{line}` — {issue}. **Fix**: {suggestion}

### Low
- [{agent}] `{file}:{line}` — {issue}. **Fix**: {suggestion}

{Omit empty severity sections}

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

## Step 7: Finalize Session Log

Append a closing section to the session log using Edit:

```markdown
---

## Session Complete

- **Agents run**: {comma-separated list}
- **Total findings**: {n}
- **Verdict**: {PASS/NEEDS CHANGES/BLOCKED}
- **Report written to**: {report file path}
- **Session log**: {session log file path}
- **Duration**: {elapsed time}
- **Completed**: {ISO timestamp}
```

Present both file paths to the user:

```
QA review complete.

Session log: {session-log path}
QA report:   {report path}
```
