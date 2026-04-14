# Project Specification

## Purpose

`sparfuchs-qa` provides a reusable QA platform for auditing application repositories with canaries, scripted review flows, multi-agent orchestration, and report persistence. It exists to let a team run fast local checks, targeted remote reviews, and broader training or documentation passes from one toolkit.

## Architecture Overview

The repository is centered on a TypeScript CLI-style toolkit. `canaries/` contains discrete static/runtime checks that roll up into a unified canary runner. `scripts/` exposes operational workflows such as remote repo review, baseline seeding, delta reporting, cleanup, and Firestore sync. `lib/` holds shared Firestore access, QA types, credential management, and the multi-engine orchestrator that can route work across API and CLI-backed providers. `.claude/agents/` and related `.claude/` config files supply the specialist prompts and local workflow automation used during reviews.

## Tech Stack

- TypeScript on Node.js 22+
- `tsx` for script execution
- Firebase Admin / Firestore for persistence
- Vercel AI SDK-compatible provider integrations via `ai` and provider adapters
- Shell/Make targets for local operator workflows
- Markdown docs and `.claude` agent configuration for review automation

## Key Design Decisions

1. Keep QA tasks script-driven and repo-local so contributors can run checks without deploying a separate service.
2. Separate narrow canaries from the larger orchestrated review pipeline so quick checks and full audits can evolve independently.
3. Support multiple execution backends through adapters in `lib/orchestrator/` instead of hard-coding a single AI provider.
4. Persist QA artifacts and run metadata in Firestore to support historical analysis, deltas, flaky-test tracking, and follow-up automation.
5. Use checked-in `.claude` agent definitions to make specialist QA behavior reproducible across local sessions.
6. Treat installer/uninstaller flows as safe bootstrap helpers only; they should not overwrite tracked source files, clone unrelated repos, or auto-push git changes.

## Constraints & Non-Goals

- This repo is a QA toolkit, not the target application under review.
- Runtime behavior depends on external credentials and, for some workflows, Firestore/GCP access.
- Some review paths assume external AI CLIs or API keys are available.
- Root handoff documentation was initialized during this session and should be reviewed as the project evolves.
- The root handoff docs and local `session-cleanup` agent are internal workflow artifacts and should be reviewed or removed before public distribution if they are not intended as part of the published repo surface.
- This repo currently has no root-level deployment config for preview/GCP environment discovery.

## Last Updated

2026-04-13 by session-cleanup agent
