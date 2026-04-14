# Project Plan

## Milestones

| # | Milestone | Status | Target Date | Notes |
|---|-----------|--------|-------------|-------|
| 1 | Stabilize local QA toolkit commands and canary workflows | ✅ | Achieved | Core canary, review, sync, and cleanup flows exist. |
| 2 | Make bootstrap and uninstall flows safe for contributors | ✅ | 2026-04-13 | Completed in PR #19, now merged on `origin/main`. |
| 3 | Establish durable session handoff documentation and cleanup workflow | ✅ | 2026-04-13 | Root docs and the local session-cleanup agent were added with an internal-use distribution note. |
| 4 | Continue evolving orchestration, reporting, and review coverage | 🔄 | TBD | Ongoing product/workflow milestone. |

## Current Sprint / Focus

**Active as of 2026-04-13:**

### In Progress
- [ ] Decide whether the new handoff docs and `@session-cleanup` agent should remain in the long-term public repository surface.
- [ ] Keep the newly added handoff docs current if they remain tracked.

### Up Next
- [ ] Push the new handoff docs and local workflow agent additions on `main`.
- [ ] Review whether `.claude/agents/session-cleanup.agent.md` belongs in the tracked default agent set.
- [ ] Reassess later whether these internal workflow files should be removed before broader/public distribution.

### Backlog
- [ ] Keep expanding QA review coverage, report workflows, and orchestration adapters.
- [ ] Revisit installer/uninstaller docs if contributor onboarding changes again.

### Done This Session
- [x] Audited and fixed the brittle installer script.
- [x] Added a safe uninstaller script.
- [x] Pushed the changes and opened PR #19.
- [x] Confirmed PR #19 merged into `origin/main`.
- [x] Installed the canonical `@session-cleanup` agent locally in this repo.
- [x] Initialized root project handoff documents.
- [x] Checked out `main` and fast-forwarded it to `origin/main`.

## Blockers

- None technically blocked; the remaining question is governance around keeping or later removing the new internal workflow files.

## Risks

- If the newly created root docs are not maintained, they can quickly drift from the real project state.
- Internal workflow artifacts may be unintentionally distributed publicly unless the review/remove note is acted on later.

## Last Updated

2026-04-13 by session-cleanup agent
