# Sparfuchs QA — Quickstart Guide

Run a multi-agent QA review against any git repository. This guide covers installation, your first review, what to expect during execution, permissions, and troubleshooting.

---

## Prerequisites

| Requirement | Check | Install |
|---|---|---|
| **Node.js 20+** | `node --version` | [nodejs.org](https://nodejs.org/) |
| **Claude Code CLI** | `claude --version` | `npm install -g @anthropic-ai/claude-code` |
| **Authenticated Claude** | `claude` (opens session) | Follow the auth prompts on first launch |
| **Git** | `git --version` | Pre-installed on macOS; `brew install git` otherwise |
| **Target repo** | Must be a git repository | `cd /path/to/project && git status` |

---

## Step 1: Clone and Install

```bash
git clone https://github.com/Sparfuchs-Pro/sparfuchs-qa.git
cd sparfuchs-qa
make qa-setup    # runs npm install
```

Verify:
```bash
npx tsx --version    # should print a version number
ls .claude/agents/   # should list 37+ .md agent files
```

---

## Step 2: Choose Your Review Mode

### Option A: Build Check Only (fastest, on-demand)

Runs just the build-verifier agent — checks format, lint, typecheck, and build in one pass. Answers "will CI pass?" without a full QA review.

```bash
make qa-build-check REPO=/path/to/your/project
```

### Option B: Diff Review (fast, targeted)

Reviews only what changed — staged files, unstaged files, or the last commit. Best for pre-commit or pre-PR checks.

```bash
make qa-review REPO=/path/to/your/project
```

### Option C: Full Audit (comprehensive, slower)

Reviews every source file in the repo. Best for first-time onboarding a project or periodic health checks.

```bash
make qa-review REPO=/path/to/your/project FULL=1
```

### Option D: Full Audit with Authenticated Testing

Runs the full audit and also sets up test credentials so agents can generate authenticated E2E tests, API tests, and contract tests.

```bash
make qa-review REPO=/path/to/your/project FULL=1 AUTH=1
```

### Option E: Training Mode

Generates training materials for the target repo, including decision trees and module-specific guidance.

```bash
make qa-training REPO=/path/to/project
make qa-training REPO=/path/to/project MODULE="auth"
make qa-training REPO=/path/to/project JOURNEY="onboarding"
```

### Option F: Documentation Mode

Generates architecture documentation from code analysis.

```bash
make qa-docs REPO=/path/to/project
make qa-docs-all REPO=/path/to/project   # full doc generation
```

### Option G: Stub Detection

Finds stubs, fake implementations, and dead integrations.

```bash
make qa-stubs REPO=/path/to/project
```

### Option H: Selective Agent Run

Run only specific agents by name.

```bash
make qa-review REPO=/path/to/project --agents "security-reviewer,rbac-reviewer"
```

### Optional Metadata

Add context to your reports:

```bash
make qa-review \
  REPO=/path/to/your/project \
  FULL=1 \
  AUTH=1 \
  PROJECT="My App" \
  PERSON="Alice" \
  URL="https://github.com/org/my-app" \
  ENGINE=orchestrated \
  PROVIDER=google
```

**ENGINE and PROVIDER flags** (optional):
- `ENGINE=orchestrated` — Uses multi-LLM Vercel AI SDK engine (defaults to `claude` for Claude Code CLI)
- `PROVIDER` — Can be `xai`, `google`, or `anthropic` (only used with `ENGINE=orchestrated`)

---

## Step 3: What Happens When You Run the Command

Here is the exact sequence, so you know what to expect:

### Phase 1: Pre-launch (your terminal)

```
$ make qa-review REPO=/path/to/project FULL=1 AUTH=1

Running credential setup wizard...          # only if AUTH=1
```

**If `AUTH=1`**: The setup wizard runs interactively in your terminal:
1. Asks: "Does the target project require authentication for testing? (y/n)"
2. Asks you to select an auth strategy (Email+Password, API Token, OAuth, Basic Auth, None)
3. Prompts for the credentials based on your strategy choice
4. Asks for the target environment URL (e.g., `https://staging.myapp.com`)
5. Writes a temporary file to `/tmp/sparfuchs-qa-creds-{runid}.json` (mode 0600, owner-only)
6. Prints confirmation

```
Credentials written to: /tmp/sparfuchs-qa-creds-qa-20260403-1522-a3f1.json
```

### Phase 2: Agent Deployment

```
Note: overriding target repo's code-reviewer.md during review    # if target had its own
Deployed 37 QA agents to /path/to/project/.claude/agents/

=== Sparfuchs QA Review ===
Target repo:  /path/to/project
Reports dir:  /Users/you/sparfuchs-qa/qa-reports
Mode:         --full
Auth:         /tmp/sparfuchs-qa-creds-qa-20260403-1522-a3f1.json
===========================
```

The script copies 37 standard QA agents (plus 2 optional documentation agents) as `.md` files into your target repo's `.claude/agents/` directory. If the target repo already has agents with the same names, they are backed up and restored after the review.

### Phase 3: Claude Session (interactive)

Claude Code launches **inside your target repo** with the QA skill loaded. This is where the actual review happens.

**You will see Claude's permission prompts.** Because Claude is launched with `--permission-mode default`, it will ask your permission before:

- Reading files in the target repo (first time per directory)
- Running bash commands (git commands, file searches)
- Writing report files to the `qa-reports/` directory
- Delegating to specialist agents

You can approve individually or type `a` to allow all for the session.

Claude then executes:
1. **Intake** — Confirms project metadata (may ask clarifying questions)
2. **Discovery** — Reads package.json, scans directories, checks git state
3. **Scope** — Full audit scans all source files; diff mode checks only changes
4. **Risk triage** — Scores the risk level (skipped in full audit mode — all agents run)
5. **Agent delegation** — Runs up to 37 specialist agents one by one:

**Stage 0: Build & Semantic Safety**
| Agent | What It Does |
|---|---|
| `build-verifier` | Runs format, lint, typecheck, compile — all errors grouped by root cause |
| `semantic-diff-reviewer` | Detects automated transforms that change runtime behavior (codemods, unsafe fixes) |

**Stage 1: Risk & Static Quality**
| Agent | What It Does |
|---|---|
| `code-reviewer` | Code quality, correctness, and maintainability |
| `security-reviewer` | Hardcoded secrets, injection risks, auth issues |
| `performance-reviewer` | N+1 queries, memory leaks, bundle size, runtime bottlenecks |
| `risk-analyzer` | Per-file risk scoring — blast radius, sensitivity, complexity |
| `regression-risk-scorer` | Git history analysis — churn rates, revert frequency, co-change coupling |
| `deploy-readiness-reviewer` | Missing env var fallbacks, CI secret gaps, config drift, stub implementations |
| `contract-reviewer` | API contract drift between producers and consumers |
| `rbac-reviewer` | Role/permission consistency across frontend, backend, and DB rules |
| `access-query-validator` | Validates data queries include proper role-based access filtering |
| `permission-chain-checker` | Validates access permission data is populated and synced throughout lifecycle |
| `collection-reference-validator` | Cross-references Firestore/SQL/MongoDB collection strings across services |
| `role-visibility-matrix` | Generates role × module visibility matrix; reports access filtering gaps |
| `a11y-reviewer` | WCAG 2.1 AA analysis — alt text, labels, keyboard traps, contrast |
| `compliance-reviewer` | GDPR, CCPA, PII handling, data retention, consent mechanisms |
| `dead-code-reviewer` | Unused exports, orphaned files, empty stubs, committed node_modules |
| `spec-verifier` | Verifies code against PRD/spec documents |
| `ui-intent-verifier` | Verifies UI element labels match actual code behavior |

**Stage 2: Integrity & Prep**
| Agent | What It Does |
|---|---|
| `schema-migration-reviewer` | Compares DB schema definitions against migration files — catches drift |
| `mock-integrity-checker` | Validates test mocks match real implementation signatures |
| `environment-parity-checker` | Compares configs across local/staging/production/CI environments |
| `iac-reviewer` | Terraform, Docker, CI/CD pipeline issues |
| `dependency-auditor` | Outdated packages, deprecated deps, unmaintained packages |
| `sca-reviewer` | Known CVEs, license risks, supply-chain concerns |
| `api-spec-reviewer` | OpenAPI spec vs implementation drift |
| `doc-reviewer` | Documentation accuracy and completeness |
| `crud-tester` | Generates API CRUD test scripts |
| `e2e-tester` | Generates Playwright E2E test specs |
| `fixture-generator` | Test factory functions from TypeScript types |
| `boundary-fuzzer` | Generates edge-case inputs for exported functions |

**Stage 3: Execution & Live Validation**
| Agent | What It Does |
|---|---|
| `test-runner` | Executes the project's existing test suite, parses pass/fail/skip counts |
| `smoke-test-runner` | Health checks against running environment — auth flow, core CRUD, page loads |
| `api-contract-prober` | Makes real HTTP calls to validate API responses match specs |
| `failure-analyzer` | Root-cause analysis of test failures |
| `stub-detector` | Finds stubs masquerading as real features, fake saves, hardcoded data |

**Stage 4: Synthesis & Gate**
| Agent | What It Does |
|---|---|
| `qa-gap-analyzer` | Identifies coverage gaps across the review |
| `release-gate-synthesizer` | Aggregates findings into Go/No-Go ship decision with risk score |

**Optional Documentation Agents** (deployed only with `--training` or `--docs`)
| Agent | What It Does |
|---|---|
| `training-system-builder` | Multi-phase training content generator with decision trees per module |
| `architecture-doc-builder` | Generates architecture documentation from code analysis |

6. **Report writing** — Compiles all findings into the final reports

### Phase 4: Cleanup (automatic)

When Claude exits (or if you Ctrl+C):

```
Cleaning up...
Credential file deleted: /tmp/sparfuchs-qa-creds-qa-20260403-1522-a3f1.json
Cleanup complete.
```

- All 37 deployed agent files are removed from the target repo by name
- Any backed-up agents are restored
- The temporary credential file is deleted
- The `.claude/agents/` directory is removed if it didn't exist before

**Your target repo is left exactly as it was found.**

---

## Step 4: Find Your Reports

All output goes to `sparfuchs-qa/qa-reports/` — nothing is written to the target repo.

```
sparfuchs-qa/qa-reports/
  2026-04-03_my-app_qa-report.md        # All findings by severity
  2026-04-03_my-app_session-log.md      # Full debug log (every agent's raw output)
  2026-04-03_my-app_spec-report.md      # Spec/PRD verification
  2026-04-03_my-app_qa-gaps.md          # Coverage gap analysis
```

If generator agents ran, test scripts are in:
```
sparfuchs-qa/generated/my-app/
  crud-tests/users.crud.test.ts
  e2e-tests/auth-login-flow.spec.ts
  contract-tests/api-users.contract.test.ts
```

---

## Permissions Deep Dive

### How Claude Accesses the Target Repo

Claude is launched **from inside** the target repo directory (`cd $REPO`). It uses `--permission-mode default`, which means:

- **Read access**: Claude will ask permission the first time it reads files. You approve once and it applies for the session.
- **Bash commands**: Claude asks before running git, grep, find, etc. These are read-only commands used for discovery and analysis.
- **Write access**: Claude only writes to the `qa-reports/` directory (which is added via `--add-dir`). It does NOT write to the target repo.
- **Agent delegation**: Each specialist agent inherits the same permission scope. You may see additional prompts when agents run bash commands.

### What Claude Can See

- All source files in the target repo (it needs this to do the review)
- Git history, branch info, and diff output
- The `qa-reports/` directory in sparfuchs-qa (for writing reports)

### What Claude Cannot See

- Files in deny-listed patterns (`.env`, `.env.*`, `secrets/`, `*.pem`, `*.key`)
- The credential file contents are read by agents via bash but never logged to session output
- Other directories outside the target repo (unless you grant access)

### Granting Broader Access

If Claude asks to read a file and you deny it, the agent will skip that file and note it in the session log. You can:
- Type `a` to allow all remaining reads for the session
- Approve/deny individually per prompt
- Pre-configure permissions in your own `.claude/settings.json`

---

## Auth Strategy Reference

When using `AUTH=1`, the setup wizard supports these strategies:

| Strategy | When to Use | What It Asks For |
|---|---|---|
| **Email + Password** | Firebase auth, standard login forms | Email, password, (Firebase API key if applicable) |
| **API Token** | Bearer token or API key you already have | Token string |
| **OAuth Token** | Pre-obtained OAuth access token | Access token, optional refresh token and expiry |
| **Basic Auth** | HTTP Basic authentication | Username, password |
| **No Auth** | Public APIs, no auth needed | Nothing (creates a no-op credential file) |

The credential file is written to `/tmp/sparfuchs-qa-creds-{runid}.json` with `0600` permissions (owner read/write only) and is automatically deleted when the review ends.

---

## Review Mode Comparison

| | Build Check | Diff Review | Full Audit | Full + Auth | Training | Docs | Selective | Stubs |
|---|---|---|---|---|---|---|---|---|
| **Command** | `make qa-build-check REPO=...` | `make qa-review REPO=...` | `+ FULL=1` | `+ FULL=1 AUTH=1` | `make qa-training REPO=...` | `make qa-docs REPO=...` | `+ --agents "..."` | `make qa-stubs REPO=...` |
| **Scope** | Build pipeline only | Changed files only | All source files | All source files | All source files | All source files | Specified agents | All source files |
| **Agents** | `build-verifier` only | Risk-based subset | All 37 agents | All 37 + auth-aware | 37 + documentation agents | 37 + documentation agents | Selected subset | All 37 agents |
| **Duration** | 2-5 minutes | 5-15 minutes | 30-60+ minutes | 30-60+ minutes | 15-30 minutes | 15-30 minutes | 5-20 minutes | 10-25 minutes |
| **Generated tests** | None | Only if relevant files changed | Full codebase scan | Full scan with login/auth setup | None | None | Varies | None |
| **Output** | Build report | Targeted findings | Comprehensive QA report | QA + auth-aware tests | Training modules | Architecture docs | Custom findings | Stub analysis |
| **Best for** | Pre-push "will CI pass?" | Pre-commit, pre-PR | First-time onboarding, periodic audits | Projects with auth-gated features | Onboarding new team members | Architecture documentation | Focused security/compliance | Finding unmaintained code |

---

## Additional Commands

### Canary Commands

Quick sanity checks for the QA infrastructure:

```bash
make qa-quick      # Run 15 canary checks (stdout)
make qa-push       # Run canaries + push results to Firestore
```

### Supply Chain & Package Verification

Check for security vulnerabilities and unmaintained dependencies:

```bash
make qa-sca             # Full SCA (supply chain attack) check + SBOM generation
make qa-sca-push        # SCA + push results to Firestore
make qa-verify          # SCA dry-run (no writes)
```

### Finding & Delta Analysis

Compare findings across multiple runs and manage historical data:

```bash
make qa-delta PROJECT=my-app        # Compare findings across runs
make qa-cleanup PROJECT=my-app      # Archive old runs (keeps 10 most recent)
```

### Flaky Test Tracking

Identify and report tests that fail intermittently:

```bash
make qa-flaky      # Report flaky tests
```

### Evolution & Adaptation

Analyze historical canary data and recommend threshold adjustments:

```bash
make qa-evolve           # Analyze canary history, suggest threshold changes
make qa-evolve-dry       # Dry-run evolution analysis
make qa-evolve-v2 PROJECT=my-app  # Local evolution (uses qa-data/ instead of Firestore)
```

### Data Sync

Synchronize Firestore data with local analysis:

```bash
make qa-sync PROJECT=my-app    # Sync Firestore data to local qa-data/
```

### Schema & Build Checks

Validate database schemas and verify build viability:

```bash
make qa-schema-check REPO=/path/to/project   # Schema validation
make qa-build-check REPO=/path/to/project    # Build verification only
```

### Cache Management

Manage the file audit cache for faster re-runs:

```bash
make qa-cache-status PROJECT=my-app      # Show file audit cache state
make qa-cache-reset PROJECT=my-app       # Clear file audit cache
```

### API Key Management

Securely manage API keys in your OS keychain:

```bash
make qa-keys-check     # List stored keys in OS keychain
make qa-keys-setup     # Instructions for storing API keys
```

### Agent Integrity

Verify that deployed agents haven't been modified:

```bash
make qa-hashes-update  # Regenerate agent-hashes.json
```

### NPM Script Equivalents

All make commands have corresponding npm scripts:

```bash
npm run canaries               # Run canaries
npm run qa:quick               # Run canaries (same as qa-quick)
npm run qa:report-push         # Push QA report to Firestore
npm run qa:nightly             # Trigger nightly regression
npm run qa:seed-baselines      # Seed AI baselines
npm run qa:sca                 # Full SCA check
npm run qa:verify              # SCA dry-run
npm run qa:flaky               # Flaky test report
npm run qa:flaky-track         # Track flaky tests
npm run qa:cred-setup          # Run credential setup wizard
npm run qa:delta               # Delta report
npm run qa:evolve-v2           # Evolution analysis v2
npm run qa:cleanup             # Archive old runs
npm run qa:sync                # Firestore sync
```

---

## Troubleshooting

### Installation Issues

| Problem | Fix |
|---|---|
| `make qa-setup` fails | Ensure Node 20+ is installed: `node --version` |
| `claude: command not found` | Install CLI: `npm install -g @anthropic-ai/claude-code` |
| `claude` asks to authenticate | Follow the prompts — you need an Anthropic API key or Claude Pro subscription |

### Launch Issues

| Problem | Fix |
|---|---|
| `Error: --repo is required` | You forgot the REPO path: `make qa-review REPO=/path/to/project` |
| `Error: /path is not a git repository` | Target must be a git repo. Run `git init` if needed. |
| `Error: credential setup failed` | The setup wizard crashed. Run standalone to debug: `npx tsx lib/credentials/setup-wizard.ts` |
| `Note: overriding target repo's X` | The target has its own agent with the same name. It's backed up and restored after the review. Safe to proceed. |

### Permission Issues

| Problem | Fix |
|---|---|
| Claude keeps asking permission for reads | Type `a` to allow all for the session, or configure broader permissions in your Claude Code settings |
| Agent can't read files in a subdirectory | Approve when prompted. Agents need read access to analyze code. |
| "Permission denied" on credential file | The file is mode 0600. Only your user can read it. This is intentional. |

### During the Review

| Problem | Fix |
|---|---|
| Review seems stuck | Claude is running agents sequentially. Some agents (security, e2e) take longer on large repos. Wait or check the session log for progress. |
| Agent reports "no files to analyze" | In diff mode, the agent's trigger condition wasn't met (e.g., no frontend files changed for a11y-reviewer). Use `FULL=1` to force all agents. |
| "Script generated but not executed" | A generator agent produced a test script but the required tool isn't installed (e.g., Playwright, k6). Install it and run manually. |
| Claude exits unexpectedly | Check `sparfuchs-qa/qa-reports/` — partial reports may have been written. Re-run the review. |

### Cleanup Issues

| Problem | Fix |
|---|---|
| Agent files left in target repo | The cleanup trap should handle this. If it didn't (e.g., kill -9), manually delete: `rm /path/to/project/.claude/agents/{code-reviewer,security-reviewer,...}.md` |
| Credential file not deleted | Check `/tmp/sparfuchs-qa-creds-*`. Delete manually: `rm /tmp/sparfuchs-qa-creds-*` |
| Target repo's `.claude/` directory was created | If the target didn't have `.claude/` before and it's now empty, remove it: `rmdir /path/to/project/.claude/agents /path/to/project/.claude 2>/dev/null` |

### Credential Issues

| Problem | Fix |
|---|---|
| Firebase sign-in fails | Verify your Firebase Web API key, email, and password. Test manually: `curl -X POST 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=YOUR_KEY' -d '{"email":"...","password":"...","returnSecureToken":true}'` |
| "OAuth token expired" | Re-run with `AUTH=1` and provide a fresh token |
| Generated tests don't have auth setup | Make sure you used `AUTH=1`. Without it, agents generate tests without authentication. |

---

## Running Sparfuchs QA Against Itself

To QA-review the sparfuchs-qa repo itself:

```bash
make qa-review REPO=. FULL=1 PROJECT="sparfuchs-qa" PERSON="Your Name"
```

No `AUTH=1` needed — sparfuchs-qa has no authenticated endpoints.

---

## What's Next

After your first review:

1. **Read the QA report** — Focus on Critical and High findings first
2. **Check generated tests** — Copy useful ones from `generated/` into your project's test suite
3. **Review the gap analysis** — The `_qa-gaps.md` file shows what the review couldn't cover
4. **Schedule periodic audits** — Run `FULL=1` monthly; run diff reviews before each PR
