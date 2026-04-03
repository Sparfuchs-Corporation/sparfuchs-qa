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

# Setup
make qa-setup            # npm ci
```

## Architecture

- `canaries/` — QA canary checks (code-quality, security, perf, i18n, rbac)
- `scripts/` — Report adapters, nightly triggers, baseline seeding, qa-evolve
- `lib/` — Shared code (Firestore client, types)
- `docs/` — QA onboarding, testing guide, architecture

## Workflow

- Run typecheck after making a series of code changes
- Prefer fixing the root cause over adding workarounds
- When unsure about approach, use plan mode (`Shift+Tab`) before coding
