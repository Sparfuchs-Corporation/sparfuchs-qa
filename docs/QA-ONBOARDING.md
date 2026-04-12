# QA Onboarding — Sparfuchs QA

This guide gets you running QA checks locally in under five minutes.
For detailed test-type reference, see [TESTING-GUIDE.md](./TESTING-GUIDE.md).
For architecture details, see [QA-ARCHITECTURE.md](./QA-ARCHITECTURE.md).

---

## Quick Start

```bash
# 1. Install dependencies + Playwright browser
make qa-setup

# 2. Run the 15 canary checks (fast, no browser needed)
make qa-quick
```

That is it. If all canaries pass you are good to push.

---

## What Gets Tested

| Type | Where | Trigger | Duration |
|------|-------|---------|----------|
| **Sparfuchs QA Canaries** | `canaries/` | `make qa-quick` | ~10 s |
| **BDD Smoke** | `testing/bdd/` | `npx playwright test --project=bdd` | ~30 s |
| **Repo Unit Tests** | `libs/*/tests/`, `apps/*/tests/` | `npm run test` | ~60 s |
| **Platform Tests** | `tests/platform/vitest/`, `tests/platform/playwright/` | Synced from GCS | varies |

Canaries are the minimum gate. They run in every Cloud Build pipeline and block
the deploy if any canary fails.

---

## Common Commands

```bash
# --- Quick Checks ---
make qa-quick                    # Run 15 canary checks (stdout)
make qa-push                     # Run canaries + push to Firestore

# --- Full QA Reviews ---
make qa-review REPO=/path FULL=1          # Full audit
make qa-review REPO=/path                 # Diff review (changed files only)
make qa-build-check REPO=/path            # Build verification only
make qa-schema-check REPO=/path           # Schema validation only

# --- Training & Documentation ---
make qa-training REPO=/path               # Generate training materials
make qa-training REPO=/path MODULE="auth" # Training for specific module
make qa-docs REPO=/path                   # Architecture documentation
make qa-docs-all REPO=/path               # Full doc generation
make qa-stubs REPO=/path                  # Stub/fake detection

# --- Supply Chain & Package Verification ---
make qa-sca                      # Full SCA check + SBOM
make qa-sca-push                 # SCA + push results
make qa-verify                   # SCA dry-run

# --- Finding Analysis ---
make qa-delta PROJECT=my-app     # Compare findings across runs
make qa-cleanup PROJECT=my-app   # Archive old runs (keep 10)
make qa-flaky                    # Report flaky tests

# --- Evolution & Adaptation ---
make qa-evolve                   # Analyze canary history, suggest changes
make qa-evolve-dry               # Dry-run evolution
make qa-evolve-v2 PROJECT=my-app # Local evolution (uses qa-data/)

# --- Data & Cache ---
make qa-sync PROJECT=my-app      # Sync Firestore to local qa-data/
make qa-cache-status PROJECT=my-app  # Show file audit cache state
make qa-cache-reset PROJECT=my-app   # Clear file audit cache

# --- API Keys ---
make qa-keys-check               # List keys in OS keychain
make qa-keys-setup               # Instructions for key storage

# --- Agent Integrity ---
make qa-hashes-update            # Regenerate agent-hashes.json

# --- Seed baselines (one-time setup) ---
npm run qa:seed-baselines
```

---

## How the Feedback Loop Works

1. **Finding** — QA Platform detects a gap (missing test, flaky behavior, coverage hole)
2. **Test generation** — Platform drafts a test and writes it to GCS as a Draft
3. **Review** — A human approves or rejects the draft via the Anvil QA dashboard
4. **Activation** — Approved tests sync into the repo via `make qa-sync`
5. **Graduation** — Once a test passes consistently for 5+ builds, it graduates to the permanent suite
6. **Evolution** — `make qa-evolve` analyzes canary history and suggests threshold tightening for stable canaries or investigation for unstable ones

Tests flow one direction: Platform -> GCS -> Repo. Developers never push tests
back to GCS manually.

---

## Adding a New Canary

Canaries are lightweight assertion functions that verify critical invariants.

### Step 1 — Create the canary file

```
canaries/my-check.canary.ts
```

Export a default async function that returns:

```typescript
{ pass: boolean; severity: string; hint: string; value: number; threshold: number; trend?: string }
```

### Step 2 — Auto-discovery

Sparfuchs QA canaries are auto-discovered — any `*.canary.ts` file in `canaries/` is loaded automatically. No manual registration needed.

### Step 3 — Test locally

```bash
make qa-quick
```

If the canary fails, you will see its name, severity, hint, and value in the output.

---

## Prerequisites

- Node 20+
- npm (workspace-aware)
- Playwright (installed via `make qa-setup`)
- `gcloud` CLI authenticated (only needed for `make qa-sync` and AI baseline seeding)
- Firebase project access for the dev environment

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `make qa-quick` fails to find canaries | Run `make qa-setup` first or check you are in the repo root |
| `make qa-sync` fails with permission denied | Run `gcloud auth login` and ensure you have Storage Object Viewer on the QA bucket |
| Canary passes locally but fails in Cloud Build | Check that the canary does not depend on local env vars or files outside the repo |
| Playwright tests time out | Run `npx playwright install chromium --with-deps` to ensure the browser is installed |

---

## Next Steps

- Read [TESTING-GUIDE.md](./TESTING-GUIDE.md) for detailed test-type reference
- Read [QA-ARCHITECTURE.md](./QA-ARCHITECTURE.md) for system design and Firestore schema
- Check the Anvil QA dashboard for current findings and test status
