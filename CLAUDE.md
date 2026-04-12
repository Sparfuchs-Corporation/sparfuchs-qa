# Project Instructions

## Commands

```bash
# Typecheck
npx tsc --noEmit

# Run canaries
npm run canaries         # or: make qa-quick
make qa-push             # run + push results to Firestore

# Scripts
npm run qa:report-push   # push QA report to Firestore
npm run qa:nightly       # trigger nightly regression
npm run qa:seed-baselines # seed AI baselines

# QA evolve
make qa-evolve           # evolve canaries
make qa-evolve-dry       # dry run

# Test credential profiles (stored in OS keychain)
make qa-creds-list                    # list saved profiles
make qa-creds-store NAME=staging-admin # store a new profile
make qa-creds-show NAME=staging-admin  # show profile details
make qa-creds-delete NAME=staging-admin # delete a profile

# Setup
make qa-setup            # npm ci
```

## Architecture

- `canaries/` — QA canary checks (code-quality, security, perf, i18n, rbac)
- `scripts/` — Report adapters, nightly triggers, baseline seeding, qa-evolve
- `lib/` — Shared code (Firestore client, types)
- `lib/orchestrator/` — Multi-engine orchestration (API + CLI providers)
- `lib/orchestrator/adapters/` — Provider adapters (api, claude-cli, gemini-cli, codex-cli, openclaw)
- `lib/credentials/` — Test credential management (keychain profiles + temp files)
- `config/models.yaml` — Provider config (API keys, CLI detection, token budgets)
- `docs/` — QA onboarding, testing guide, architecture

## Workflow

- Run typecheck after making a series of code changes
- Prefer fixing the root cause over adding workarounds
- When unsure about approach, use plan mode (`Shift+Tab`) before coding
