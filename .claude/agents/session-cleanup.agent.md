# @session-cleanup

> **Sparfuchs Agent Tooling** | `session-cleanup.agent.md`
> Compatible with: Claude (claude.ai, Claude Code) · OpenAI Codex
> Source: [github.com/Sparfuchs-Pro/Sparfuchs-Agent-Tooling](https://github.com/Sparfuchs-Pro/Sparfuchs-Agent-Tooling)

---

## Agent Description

When invoked, this agent performs a structured session cleanup and handoff for any active development project. It scans the current working context, then systematically updates all session and project documents so that any AI agent — Claude or Codex — can resume work immediately and with full context.

Invoke this at the end of any work session, before switching tasks, or when handing off between agents or developers.

---

## Trigger

Reference this agent by name in your session:

```
@session-cleanup
```

Or paste the contents of this file into your Claude or Codex session as a prompt.

---

## Execution Instructions

When this agent is invoked, execute ALL of the following steps in order. Do not skip any step. For each step, read the existing file (if present), update it with current session knowledge, and write it back. If a file does not yet exist, create it.

---

### STEP 1 — Orient and Audit the Session

Before updating any files, collect and hold in context:

1. **What is the project?** — Identify the repo name, purpose, and primary language/stack from existing files or conversation history.
2. **What was worked on this session?** — Summarize all changes, decisions, and work completed since the last cleanup or session start.
3. **What is the current state?** — Identify what is working, what is broken, what is in progress, and what is blocked.
4. **What are the open questions or unknowns?**
5. **What is the intended next action?** — Identify the single most important thing the next agent or developer should do when they resume.

Hold this context. You will use it in every step below.

---

### STEP 2 — Update `SPEC.md` (Specifications)

**File:** `SPEC.md` in the project root (create if missing)

Update this file to reflect the current, accurate specification of the system. It should contain:

```markdown
# Project Specification

## Purpose
[One paragraph describing what this project does and why it exists]

## Architecture Overview
[High-level description of system components and how they interact]

## Tech Stack
[Languages, frameworks, services, databases, APIs used]

## Key Design Decisions
[Numbered list of important architectural or design choices made, with brief reasoning]

## Constraints & Non-Goals
[What this system intentionally does NOT do, or limitations it must operate within]

## Last Updated
[ISO date — e.g. 2026-03-17] by session-cleanup agent
```

Rules:
- Do not remove existing content unless it is factually incorrect.
- Mark any section as `[NEEDS REVIEW]` if you are uncertain about its accuracy.
- Add new decisions or constraints discovered this session.

---

### STEP 3 — Update `MEMORY.md` (Session Memory & Context)

**File:** `MEMORY.md` in the project root (create if missing)

This file is the persistent memory of the project across sessions. It is the first file any new agent should read.

```markdown
# Agent Memory

## Project Identity
- **Name:** [Project name]
- **Repo:** [GitHub URL]
- **Owner:** [Owner/org]
- **Primary Language:** [e.g. Python, TypeScript]

## Current Status
**As of [ISO date]:** [One sentence status — e.g. "Auth flow complete, payment integration in progress"]

## Session Log
### [ISO date] — Session Summary
- **Completed:** [Bullet list of what was done]
- **Decisions Made:** [Bullet list of decisions and reasoning]
- **Problems Encountered:** [Bugs, blockers, surprises]
- **How Problems Were Resolved:** [Or "Unresolved — see Next Steps"]

## Persistent Context
[Facts about this project that every agent must know — e.g. API quirks, naming conventions, gotchas, environment setup notes]

## Unresolved Questions
[Numbered list of open questions. Remove items as they are answered in future sessions.]

## Last Updated
[ISO date] by session-cleanup agent
```

Rules:
- Prepend new session logs; keep all previous session logs intact.
- Never delete from "Persistent Context" unless a fact has changed.
- Keep "Unresolved Questions" current.

---

### STEP 4 — Update `REQUIREMENTS.md`

**File:** `REQUIREMENTS.md` in the project root (create if missing)

```markdown
# Requirements

## Functional Requirements
| ID | Requirement | Status | Notes |
|----|-------------|--------|-------|
| FR-01 | [Description] | ✅ Done / 🔄 In Progress / ⬜ Not Started / ❌ Blocked | [Notes] |

## Non-Functional Requirements
| ID | Requirement | Status | Notes |
|----|-------------|--------|-------|
| NFR-01 | [Description] | ✅ / 🔄 / ⬜ / ❌ | [Notes] |

## Out of Scope
[Items explicitly deferred or excluded from this project]

## Last Updated
[ISO date] by session-cleanup agent
```

Rules:
- Update the Status column for any requirement touched this session.
- Add new requirements discovered this session as new rows.
- Move completed items to Done; do not delete them.
- If a requirement is blocked, note why in the Notes column.

---

### STEP 5 — Update `PLAN.md`

**File:** `PLAN.md` in the project root (create if missing)

```markdown
# Project Plan

## Milestones
| # | Milestone | Status | Target Date | Notes |
|---|-----------|--------|-------------|-------|
| 1 | [Milestone name] | ✅ / 🔄 / ⬜ | [Date or TBD] | |

## Current Sprint / Focus
**Active as of [ISO date]:**

### In Progress
- [ ] [Task] — [Brief status note]

### Up Next
- [ ] [Task]
- [ ] [Task]

### Backlog
- [ ] [Task]

### Done This Session
- [x] [Task]
- [x] [Task]

## Blockers
[Any tasks that cannot proceed and why]

## Risks
[Anticipated risks to timeline or quality]

## Last Updated
[ISO date] by session-cleanup agent
```

Rules:
- Move completed tasks from "In Progress" or "Up Next" to "Done This Session."
- Carry "Done This Session" items forward as a running record; do not delete them.
- Update milestone statuses to reflect current reality.
- Surface blockers explicitly.

---

### STEP 6 — Update `README.md` with Current Status

**File:** `README.md` in the project root

Do NOT rewrite the entire README. Locate or create a `## Project Status` section near the top (below the title and description) and update it:

```markdown
## Project Status

**Status:** 🔄 In Progress | ✅ Stable | 🚧 Early Development | ❌ Blocked
**Last Updated:** [ISO date]
**Current Focus:** [One sentence describing what is actively being built]

### Recent Progress
- [Bullet: thing completed recently]
- [Bullet: thing completed recently]

### Known Issues
- [Bullet: known bug or limitation, if any]

### Up Next
- [Bullet: next planned action]
```

Rules:
- If `## Project Status` already exists, replace only that section.
- Do not modify any other section of the README unless it contains factual errors.
- Keep it brief — this section should be scannable in under 30 seconds.

---

### STEP 6b — Add GCP Pre-Production Link to README (if applicable)

Attempt to find the current GCP pre-production / preview URL for this project and add it to `README.md`. If no GCP deployment is detected or all commands fail, skip this step silently.

**Detection — identify deployment type (check in order, stop on first match):**

1. `firebase.json` or `.firebaserc` present → Firebase Hosting
2. `app.yaml` present → App Engine
3. `cloudbuild.yaml`, `.cloudbuild/`, or `k8s/` directory present → likely Cloud Run or GKE
4. Any `*.yaml` referencing `run.googleapis.com` → Cloud Run

**Authentication check — run before any URL lookup:**

Once a GCP deployment is detected, verify the `gcloud` CLI is authenticated:

```bash
gcloud auth print-access-token 2>/dev/null
```

- If this returns a token → proceed to URL retrieval below.
- If it returns an error or empty output → **pause and tell the user:**

  > "GCP deployment detected but `gcloud` is not authenticated. Please run:
  > ```
  > ! gcloud auth login
  > ```
  > Then confirm when done and I will continue fetching the pre-production URL."

  Wait for the user to confirm before continuing. Do not proceed to URL retrieval until authentication succeeds. After confirmation, re-run the token check to verify before continuing.

  If the user declines or says to skip, note the section as `⚠️ Skipped — gcloud not authenticated` in the STEP 8 summary and move on.

**Getting the URL — run the matching command:**

- **Cloud Run** — list services and find any with a name containing "staging", "preview", "dev", or "pre-prod":
  ```bash
  gcloud run services list --platform managed --format="table(metadata.name,status.url,metadata.namespace)" 2>/dev/null
  ```
  Use the URL of the matching pre-production service. If multiple exist, prefer the one most recently deployed.

- **Firebase Hosting preview channels:**
  ```bash
  firebase hosting:channel:list 2>/dev/null
  ```
  Use the URL of the most recently updated non-production channel.

- **App Engine (non-default version):**
  ```bash
  gcloud app versions list --hide-no-traffic --sort-by="~last_deployed_time" --limit=1 --format="value(version.id)" 2>/dev/null
  ```
  Construct the URL as: `https://VERSION-dot-PROJECT_ID.REGION.r.appspot.com`

If a URL is found, locate or create a `## Pre-Production Build` section in `README.md` immediately after `## Project Status` and update it:

```markdown
## Pre-Production Build

| Field | Value |
|-------|-------|
| **Preview URL** | [URL] |
| **Service** | [Cloud Run service / Firebase channel name / App Engine version] |
| **Last Updated** | [ISO date] |
```

If the section already exists, replace only its table content. Do not modify surrounding sections.

---

### STEP 7 — Write `NEXT_STEPS.md` (Handoff Document)

**File:** `NEXT_STEPS.md` in the project root (always overwrite with current session output)

This is the most critical file for agent-to-agent or human-to-agent handoff. It must be written fresh every session.

```markdown
# Next Steps — Agent Handoff

**Written:** [ISO date and time]
**Written by:** session-cleanup agent
**Project:** [Project name]
**Repo:** [GitHub URL]

---

## Immediate Next Action

> [Single, specific, unambiguous instruction for what to do first when resuming this project]

Example: "Run `npm test` to confirm the auth middleware tests pass, then implement the `/api/payments/initiate` endpoint as defined in SPEC.md §3.2."

---

## Context to Load First

Before starting work, read these files in this order:
1. `MEMORY.md` — Full project history and persistent context
2. `SPEC.md` — Current system specification
3. `PLAN.md` — Active tasks and backlog
4. `REQUIREMENTS.md` — Requirements and their status

---

## What Was Just Completed

[Bullet list of everything done this session]

---

## What Is In Progress

[Bullet list of tasks started but not finished, with their current state]

---

## What Is Blocked

[Bullet list of blocked tasks and what is needed to unblock them. Write "None" if nothing is blocked.]

---

## Open Questions

[Numbered list of unresolved questions the next agent or developer needs to answer or investigate]

---

## Warnings & Gotchas

[Anything the next agent must know to avoid mistakes — e.g. "Do not run migrations in prod without backup", "API rate limit is 100 req/min", "The `config.local.json` file must exist before running locally"]

---

## Environment & Setup Notes

[Any commands needed to get the project running locally, or notes on environment variables, secrets, or dependencies]

---

## For Claude

If you are Claude, start by saying: "I've read the handoff document. The current project is [project name]. The immediate next action is: [paste the Immediate Next Action above]. Ready to proceed — confirm or redirect me."

## For Codex

If you are Codex, begin with the Immediate Next Action above. Reference `MEMORY.md` and `SPEC.md` for all context. Do not make assumptions; surface questions in `NEXT_STEPS.md` under Open Questions.
```

---

### STEP 8 — Final Confirmation

After completing all steps, output a summary in this exact format:

```
✅ session-cleanup complete

Project: [name]
Date: [ISO date]

Files Updated:
  ✅ SPEC.md
  ✅ MEMORY.md
  ✅ REQUIREMENTS.md
  ✅ PLAN.md
  ✅ README.md (Status section)
  ✅ README.md (Pre-Production Build section) [or ⚠️ Skipped — no GCP deployment detected]
  ✅ NEXT_STEPS.md

Session Summary:
  [2-3 sentence summary of what was done this session]

Immediate Next Action:
  [Copy of the Immediate Next Action from NEXT_STEPS.md]

Ready for handoff. ✓
```

If any file could not be updated (e.g. because insufficient context exists to populate it), mark it `⚠️ Skipped — [reason]` and explain what information is needed.

---

## Compatibility Notes

| Platform | How to Invoke |
|----------|---------------|
| **Claude (claude.ai)** | Paste file contents into chat, or reference `@session-cleanup` if using a skill/plugin |
| **Claude Code** | Add as a skill, or run `claude --print < session-cleanup.agent.md` in your project directory |
| **OpenAI Codex** | Paste file contents as the system or user prompt at the start of a session |
| **Any LLM** | Copy and paste the full file content as a prompt. All steps are self-contained. |

---

## Version

`v1.0.0` — Initial release
Maintained at: [github.com/Sparfuchs-Pro/Sparfuchs-Agent-Tooling](https://github.com/Sparfuchs-Pro/Sparfuchs-Agent-Tooling)
