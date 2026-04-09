---
name: qa-training
description: Generate training content for the target repo — standalone mode with full discovery, or integrated mode consuming upstream QA agent data
argument-hint: "[--module MODULE | --journey DESCRIPTION] [output directory — default: training-reports/]"
disable-model-invocation: true
---

Training content generator. Operates in two modes:

- **Standalone** (via `make qa-training`): performs its own discovery, warns that results are shallower without QA agent data
- **Integrated** (via `make qa-review TRAINING=1`): consumes session log data from spec-verifier, rbac-reviewer, ui-intent-verifier, stub-detector, collection-reference-validator for richer output

Both modes support three training sub-modes: OVERVIEW (default), DEEP-DIVE (`Module: X`), and JOURNEY (`Journey: X`).

**CRITICAL RULES**:
- This is a DOCUMENTATION task, not a QA task. Do not produce QA findings.
- File names MUST use today's calendar date (run `date '+%Y-%m-%d'` via Bash)

## Step 0: Detect Mode and Setup

### Detect operating mode

- If the prompt contains `"session log at"` or a session log file path → **Integrated mode**
- Otherwise → **Standalone mode**

### Detect training sub-mode

- If the prompt contains `"Module: {name}"` or `"Deep dive: {name}"` → **DEEP-DIVE** on that module
- If the prompt contains `"Journey: {description}"` → **JOURNEY** for that journey
- Neither → **OVERVIEW**

### Setup

Parse the output directory from the prompt. Default to `training-reports/` in the sparfuchs-qa repo root.

Generate:
- **Run ID**: `train-{YYYYMMDD}-{HHmm}-{random 4 hex chars}` (use `date` + `openssl rand -hex 2` via Bash)
- **File names** (use today's date):
  - Session log: `{output-dir}/{YYYY-MM-DD}_{project-slug}_training-session-log.md`
  - Training content (varies by sub-mode):
    - OVERVIEW: `{output-dir}/{YYYY-MM-DD}_{project-slug}_training-spec.md`
    - DEEP-DIVE: `{output-dir}/{YYYY-MM-DD}_{project-slug}_training-deep-{module-slug}.md`
    - JOURNEY: `{output-dir}/{YYYY-MM-DD}_{project-slug}_training-journey-{journey-slug}.md`

Extract project name and person name from the prompt if provided.

Create the output directory if needed (`mkdir -p`).

## Step 1: Project Discovery

### Standalone mode

Navigate to the target repo. Gather:
- Tech stack (framework, database, auth system)
- Module structure (user-facing modules)
- Routes (all routable pages)
- Roles (all role definitions)

Log a warning to the user and session log:
```
NOTE: Running in standalone mode — no upstream QA agent data available.
Training content will be generated from scratch via code analysis.
For richer, deeper output, run as part of a QA review session:
  make qa-review REPO=... FULL=1 TRAINING=1 PROJECT=...
```

### Integrated mode

Read the session log path provided. Verify it exists and contains agent output sections. Log:
```
Integrated mode — consuming upstream data from QA session.
Session log: {path}
```

Write the session log header:

```markdown
# Training Builder Session Log — {Project Name}

**Run ID**: {run-id}
**Date**: {YYYY-MM-DD HH:MM}
**Mode**: {Standalone / Integrated}
**Training sub-mode**: {OVERVIEW / DEEP-DIVE: {module} / JOURNEY: {journey}}
**Repo**: {repo path}

---
```

## Step 2: Check for Previous Training Specs

For DEEP-DIVE and JOURNEY modes, check if a previous overview spec exists:

```bash
ls {output-dir}/*_training-spec.md 2>/dev/null | tail -1
```

- If found: log `"Previous overview spec found: {file}. Deep-dive will reference it for module context."`
- If not found and sub-mode is DEEP-DIVE/JOURNEY: log `"WARNING: No overview spec found. Consider running OVERVIEW mode first for a complete module inventory. Proceeding with deep-dive from scratch."`

Also check for previous deep-dives of the same module:
```bash
ls {output-dir}/*_training-deep-{module-slug}.md 2>/dev/null | tail -1
```

If found: log `"Previous deep-dive found: {file}. This run will produce an updated version."`

## Step 3: Delegate to Training System Builder

Build the delegation prompt based on mode:

### Standalone delegation

```
Generate training content for this repository.

Mode: {OVERVIEW / DEEP-DIVE / JOURNEY}
{If DEEP-DIVE: "Module: {module name}"}
{If JOURNEY: "Journey: {journey description}"}

No upstream agent data is available — perform full discovery.

{If previous spec exists: "Previous training spec at: {path}. Read it for context."}

Write output to: {training content file path}
```

### Integrated delegation

```
Generate training content for this repository.

Mode: {OVERVIEW / DEEP-DIVE / JOURNEY}
{If DEEP-DIVE: "Module: {module name}"}
{If JOURNEY: "Journey: {journey description}"}

The session log at {session-log-path} contains analysis from these QA agents:
- @spec-verifier: feature inventory, completeness, route map
- @ui-intent-verifier: UI elements, handler traces, settings sweep
- @rbac-reviewer: role definitions, hierarchy, guards, permissions
- @stub-detector: stub classifications (training blockers)
- @collection-reference-validator: collection names, cross-references

Read the session log to consume their findings. Do NOT re-discover what they already found.

{If previous spec exists: "Previous training spec at: {path}. Read it for context."}

Write output to: {training content file path}
```

Delegate to `@training-system-builder`. Capture the agent's complete output. Append verbatim to session log.

## Step 4: Write Training Content

The training-system-builder agent writes its output to the specified file. Verify the file was created:

```bash
test -f "{training content file path}" && echo "exists" || echo "missing"
```

If missing, write the agent's output as the file content.

## Step 5: Summary

Parse the training content for key metrics and log to session log:

**OVERVIEW metrics**: features documented, features excluded (stubbed), roles mapped, walkthroughs documented, training targets found/missing, demo entities specified

**DEEP-DIVE metrics**: workflows documented, form fields documented, decision branches mapped, role variations documented, error messages captured

**JOURNEY metrics**: chapters written, module transitions, role handoffs, total steps

Report summary to user:
```
Training content generated:
  Mode: {mode}
  File: {output file path}
  {key metrics}
```
