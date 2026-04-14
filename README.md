# Sparfuchs QA

Sparfuchs QA is a TypeScript-based multi-agent QA toolkit for running canaries, orchestrated repository reviews, documentation generation, credential-aware authenticated testing, and Firestore-backed reporting workflows.

## Project Status

**Status:** 🔄 In Progress  
**Last Updated:** 2026-04-13  
**Current Focus:** Keep the installer/bootstrap flow safe and repo-relative while maintaining the QA review, canary, and orchestration toolchain.

### Recent Progress
- Replaced the old destructive installer with a safe repo-relative bootstrap script.
- Added a matching uninstaller for local/generated artifacts.
- Initialized root handoff documentation and installed the `@session-cleanup` agent locally for this repo.

### Known Issues
- The newly added handoff docs and `@session-cleanup` agent are internal workflow artifacts and may not belong in the long-term public repo surface.
- If these files remain checked in, they will need active maintenance to avoid drifting from the actual project state.

### Up Next
- Periodically review whether the new handoff docs and local workflow agent should stay in the published repository or be removed before broader/public distribution.

## Internal Distribution Note

The root handoff docs (`SPEC.md`, `MEMORY.md`, `REQUIREMENTS.md`, `PLAN.md`, `NEXT_STEPS.md`) and the local workflow agent `.claude/agents/session-cleanup.agent.md` were added for internal operating context. Review them before any public distribution and remove them if they should not ship as part of the public repository surface.

## Usage

```bash
make qa-setup
make qa-quick
make qa-review REPO=/path/to/target/repo
```

## Key Paths

- `canaries/` — QA canary checks
- `scripts/` — QA orchestration and reporting scripts
- `lib/` — Shared Firestore, orchestration, and credential logic
- `.claude/agents/` — QA specialist agents and local workflow agents
- `docs/` — onboarding, architecture, quickstart, and testing guides
