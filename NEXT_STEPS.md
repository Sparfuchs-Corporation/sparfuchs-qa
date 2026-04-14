# Next Steps — Agent Handoff

**Written:** 2026-04-13 22:43 PDT
**Written by:** session-cleanup agent
**Project:** Sparfuchs QA
**Repo:** https://github.com/Sparfuchs-Pro/sparfuchs-qa

---

## Immediate Next Action

> Review over time whether the new root handoff docs plus `.claude/agents/session-cleanup.agent.md` should remain tracked or be removed before broader/public distribution.

---

## Context to Load First

Before starting work, read these files in this order:
1. `MEMORY.md` — Full project history and persistent context
2. `SPEC.md` — Current system specification
3. `PLAN.md` — Active tasks and backlog
4. `REQUIREMENTS.md` — Requirements and their status

---

## What Was Just Completed

- Audited `setup-qa-complete.sh` and replaced the old destructive behavior with a safe repo-relative bootstrap flow.
- Added `uninstall-qa-complete.sh` for removing only generated/local artifacts.
- Pushed the installer/uninstaller work and opened PR #19.
- Verified that PR #19 merged into `origin/main`.
- Installed the canonical `@session-cleanup` agent locally at `.claude/agents/session-cleanup.agent.md`.
- Created root handoff documents: `README.md`, `SPEC.md`, `MEMORY.md`, `REQUIREMENTS.md`, `PLAN.md`, and `NEXT_STEPS.md`.

---

## What Is In Progress

- The new handoff docs and local session-cleanup agent install have been added on `main`.
- Decision-making around whether these internal workflow files should remain tracked long term.

---

## What Is Blocked

- None technically blocked. The remaining work is a product/repo decision about whether to keep these internal workflow files in the published repository over time.

---

## Open Questions

1. Should the new root docs remain in the public repo long term, or only temporarily as internal handoff tooling?
2. Should `.claude/agents/session-cleanup.agent.md` be distributed with this repo by default?
3. Who should own keeping these handoff docs current if they remain tracked?

---

## Warnings & Gotchas

- Local `main` has been fast-forwarded to the PR #19 merge.
- The new root docs and `session-cleanup` agent are internal workflow artifacts and should be reviewed or removed before broader/public distribution if they are not meant to ship.
- If these files remain checked in, they need active maintenance to stay accurate.

---

## Environment & Setup Notes

- Recommended local setup: `make qa-setup`
- Quick canary run: `make qa-quick`
- Main review entrypoint: `make qa-review REPO=/path/to/target/repo`
- Safe bootstrap helper: `./setup-qa-complete.sh`
- Safe local cleanup helper: `./uninstall-qa-complete.sh`
- Typecheck: `npx tsc --noEmit`

---

## For Claude

If you are Claude, start by saying: "I've read the handoff document. The current project is Sparfuchs QA. The immediate next action is: Review over time whether the new root handoff docs plus `.claude/agents/session-cleanup.agent.md` should remain tracked or be removed before broader/public distribution. Ready to proceed — confirm or redirect me."

## For Codex

If you are Codex, begin with the Immediate Next Action above. Reference `MEMORY.md` and `SPEC.md` for all context. Do not make assumptions; surface questions in `NEXT_STEPS.md` under Open Questions.
