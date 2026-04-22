# Requirements

## Functional Requirements

| ID | Requirement | Status | Notes |
|----|-------------|--------|-------|
| FR-01 | Run all QA canaries from a single command entrypoint. | ✅ Done | Implemented via `canaries/index.ts`, npm scripts, and `make qa-quick`. |
| FR-02 | Run remote QA reviews against arbitrary git repositories with optional full, auth, docs, training, and selective-agent modes. | ✅ Done | Implemented through `scripts/qa-review-remote.sh` and related Make targets. |
| FR-03 | Support report, delta, cleanup, and evolution workflows from the local toolkit. | ✅ Done | Covered by `scripts/qa-delta-report.ts`, `qa-markdown-reports.ts`, `qa-cleanup.ts`, and `qa-evolve-v2.ts`. External report push / Firestore sync has been removed; all artifacts are local. |
| FR-04 | Support credential-aware testing profiles for authenticated review runs. | ✅ Done | Implemented under `lib/credentials/` and Make helpers. |
| FR-05 | Provide a safe repository bootstrap script for local setup. | ✅ Done | `setup-qa-complete.sh` now validates repo state, fixes hook permissions, and optionally runs `npm ci`. |
| FR-06 | Provide a safe uninstaller for local/generated artifacts. | ✅ Done | Added `uninstall-qa-complete.sh` during this session. |
| FR-07 | Preserve project context across sessions with root handoff docs and a reusable cleanup agent. | ✅ Done | Docs and local agent were added; they include an explicit note to review/remove them before public distribution if needed. |

## Non-Functional Requirements

| ID | Requirement | Status | Notes |
|----|-------------|--------|-------|
| NFR-01 | Installer and uninstaller flows must avoid destructive rewrites of tracked files. | ✅ Done | Replaced destructive installer behavior and scoped uninstall targets to local artifacts only. |
| NFR-02 | The toolkit should remain runnable from a local checkout with documented Node.js requirements. | ✅ Done | `package.json` specifies Node 22+, and local commands are documented in `CLAUDE.md` and `README.md`. |
| NFR-03 | Multi-provider orchestration should remain adapter-based rather than tied to one AI backend. | ✅ Done | Existing `lib/orchestrator/adapters/` structure supports this. |
| NFR-04 | Project handoff state should be understandable without replaying chat history. | ✅ Done | Root handoff docs now exist in the working tree. |
| NFR-05 | Internal-only workflow artifacts should be clearly marked for review before public distribution. | ✅ Done | README, SPEC, and memory/handoff docs call this out explicitly. |

## Out of Scope

- Deploying this repository itself as a hosted application
- Automatically authenticating external CLIs or cloud providers on behalf of the operator
- Removing tracked repo files during uninstall

## Last Updated

2026-04-13 by session-cleanup agent
