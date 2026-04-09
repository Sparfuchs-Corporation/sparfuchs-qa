---
name: qa-docs
description: Generate architecture documentation for the target repo — system overview, data flows, data models, API contracts, auth architecture, and module dependencies
argument-hint: "[output directory — default: architecture-reports/]"
disable-model-invocation: true
---

Architecture documentation generator. Analyzes a codebase and produces comprehensive architecture documentation covering data flows, models, APIs, auth, and dependencies.

**CRITICAL RULES**:
- This is a DOCUMENTATION task, not a QA task. Do not produce QA findings.
- File names MUST use today's calendar date (run `date '+%Y-%m-%d'` via Bash)
- Session log = full debug log of the analysis
- Architecture doc = the complete architecture reference

## Step 0: Setup

Parse the output directory from the prompt. Default to `architecture-reports/` in the sparfuchs-qa repo root.

Generate:
- **Run ID**: `arch-{YYYYMMDD}-{HHmm}-{random 4 hex chars}`
- **File names**:
  - `{output-dir}/{YYYY-MM-DD}_{project-slug}_arch-session-log.md`
  - `{output-dir}/{YYYY-MM-DD}_{project-slug}_architecture.md`

Extract project name and person name from the prompt if provided.

Create the output directory if needed (`mkdir -p`).

## Step 1: Quick Project Discovery

Navigate to the target repo. Gather:

- **Tech stack**: language, framework, database, auth, hosting, CI/CD
- **Project structure**: monorepo vs single-app, directory layout
- **Size**: file count, dependency count
- **Git state**: branch, recent commits

Write the session log header:

```markdown
# Architecture Doc Builder Session Log — {Project Name}

**Run ID**: {run-id}
**Date**: {YYYY-MM-DD HH:MM}
**Repo**: {repo path}

---

## Discovery
{tech stack, structure, size summary}
```

## Step 2: Delegate to Architecture Doc Builder

Delegate to `@architecture-doc-builder` with:
- Target repo path
- Project name
- Git commit SHA (for versioning the doc)
- Any context gathered in Step 1

Capture the agent's complete output. Append verbatim to session log.

## Step 3: Write Architecture Document

The architecture-doc-builder agent's output IS the architecture doc. Write it to the architecture file.

If the agent's output doesn't have a proper header, prepend:

```markdown
# Architecture Documentation — {Project Name}

| Field | Value |
|---|---|
| Generated | {YYYY-MM-DD HH:MM} |
| Source | {repo path} |
| Commit | {git SHA} |
| Run ID | {run-id} |

---

{agent output}
```

## Step 4: Summary Statistics

Parse the architecture doc for key metrics and log to session log:

- Collections/tables documented: {n}
- API endpoints documented: {n}
- Data flows traced: {n}
- Roles documented: {n}
- Mermaid diagrams generated: {n}
- Shared services identified: {n}
- Modules mapped: {n}

Report summary to user.
