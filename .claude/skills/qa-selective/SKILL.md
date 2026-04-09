---
name: qa-selective
description: Run specific named QA agents against a target repo — lightweight orchestrator without full QA pipeline overhead
argument-hint: "[agent names provided in prompt] [output directory]"
disable-model-invocation: true
---

Lightweight QA orchestrator that runs only the agents specified in the prompt. No intake interview, no tier selection, no release gate — just: discover project, run named agents, write report.

**CRITICAL RULES**:
- Do NOT run agents beyond those specified in the prompt
- File names MUST use today's calendar date (run `date '+%Y-%m-%d'` via Bash)
- Session log = full debug log. Every agent's complete unedited response.
- Report = all findings from the specified agents, listed individually

## Step 0: Parse Agent Names and Setup

The prompt will contain: `"Run ONLY these agents: agent1, agent2"` — extract the agent names.

Parse the output directory from the prompt (e.g., "Write reports to: /path/"). Default to `qa-reports/`.

Generate:
- **Run ID**: `qa-{YYYYMMDD}-{HHmm}-{random 4 hex chars}` (use `date` + `openssl rand -hex 2` via Bash)
- **File names** (use today's date):
  - `{output-dir}/{YYYY-MM-DD}_{project-slug}_session-log.md`
  - `{output-dir}/{YYYY-MM-DD}_{project-slug}_selective-report.md`

Also extract project name and person name from the prompt if provided.

## Step 1: Quick Project Discovery

Navigate to the target repo. Gather a minimal profile:

- **Tech stack**: read `package.json` or equivalent. Note language, framework.
- **Architecture**: use Glob to identify source directories (`apps/`, `src/`, `libs/`).
- **Git state**: run `git branch --show-current` and `git log --oneline -3` via Bash.

Write the session log header:

```markdown
# QA Selective Session Log — {Project Name}

**Run ID**: {run-id}
**Date**: {YYYY-MM-DD HH:MM}
**Mode**: Selective — agents: {agent names}
**Repo**: {repo path}

---
```

## Step 2: Run Named Agents

For each agent specified:

1. Log to session log: `## Agent: {agent-name}`
2. Delegate to `@{agent-name}` with the repo path
3. Capture the agent's complete output — append verbatim to session log
4. Parse `<!-- finding: {...} -->` tags from the output
5. Collect all findings

Run agents sequentially (they may have implicit dependencies on each other's file reads).

## Step 3: Write Report

Write the selective report:

```markdown
# QA Selective Report — {Project Name}

| Field | Value |
|---|---|
| Project | {project name} |
| Repo | {repo path} |
| Date | {YYYY-MM-DD HH:MM} |
| Run ID | {run-id} |
| Agents | {agent names} |

---

## Findings

{All findings listed individually by severity, with full detail from each agent}

## Statistics

- Agents run: {n}
- Total findings: {n}
- By severity: {critical: n, high: n, medium: n, low: n}
```

## Step 4: Finalize

- Ensure both output files are written
- Log completion to session log
- Report summary to user
