# Project Instructions

## Commands

```bash
# Typecheck
npx tsc --noEmit

# Run canaries (local-only; external report push has been removed)
npm run canaries         # or: make qa-quick

# QA review (orchestrated engine)
make qa-review REPO=/path/to/target                          # git-backed target
make qa-review REPO=/path/to/target ACCEPT_NO_GIT=1          # non-git target (prompt/flag required)

# Deltas and cleanup from local qa-data
npm run qa:delta         # markdown delta report
npm run qa:evolve-v2     # local-data evolution (replaces qa-evolve)
npm run qa:cleanup       # prune old runs

# Test credential profiles (stored in OS keychain)
make qa-creds-list                    # list saved profiles
make qa-creds-store NAME=staging-admin # store a new profile
make qa-creds-show NAME=staging-admin  # show profile details
make qa-creds-delete NAME=staging-admin # delete a profile

# Provider API keys + Gemini CLI auth (stored in OS keychain)
make qa-keys-check       # list keys already in the keychain
make qa-keys-setup       # print platform-specific add/update/delete commands

# Setup
make qa-setup            # npm ci
```

## Credential storage (OS keychain)

Service name is always `sparfuchs-qa`. Account names are the credential identifiers below.

| Account | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API provider (orchestrator) |
| `OPENAI_API_KEY` | OpenAI API provider |
| `XAI_API_KEY` | xAI API provider |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Generative AI provider (Gemini API) |
| `GEMINI_API_KEY` | Gemini **CLI** auth (adapter injects it into the CLI's env at spawn) |

**macOS — add / update / delete / verify:**
```bash
# Add (or run to overwrite an existing entry after deleting)
security add-generic-password -s sparfuchs-qa -a GEMINI_API_KEY -w 'AIza...'

# Update (delete + re-add)
security delete-generic-password -s sparfuchs-qa -a GEMINI_API_KEY
security add-generic-password    -s sparfuchs-qa -a GEMINI_API_KEY -w 'new-value'

# Verify (prints the stored value to stdout — for confirmation only)
security find-generic-password   -s sparfuchs-qa -a GEMINI_API_KEY -w
```

**Linux (libsecret / secret-tool):**
```bash
echo 'AIza...' | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key GEMINI_API_KEY
secret-tool lookup service sparfuchs-qa key GEMINI_API_KEY   # verify
secret-tool clear  service sparfuchs-qa key GEMINI_API_KEY   # delete
```

**Windows (PowerShell, CredentialManager module):**
```powershell
$s = ConvertTo-SecureString 'AIza...' -AsPlainText -Force
New-StoredCredential -Target 'sparfuchs-qa-GEMINI_API_KEY' -Password $s -Type Generic -Persist LocalMachine
```

**Fallbacks (not persisted across shells):**
```bash
export GEMINI_API_KEY=AIza...
```

**Gemini CLI — alternative one-time OAuth instead of an API key:**
```bash
gemini   # complete browser login once; creds cached at ~/.gemini/oauth_creds.json
```

Resolution priority (highest first): keychain → shell env var → `~/.gemini/oauth_creds.json` (Gemini CLI only). `make qa-keys-check` reports which keychain entries exist.

## Architecture

- `canaries/` — QA canary checks (code-quality, security, perf, i18n, rbac)
- `scripts/` — Delta/evolution/cleanup scripts + markdown report generators
- `lib/` — Shared code (types)
- `lib/orchestrator/` — Multi-engine orchestration (API + CLI providers)
- `lib/orchestrator/adapters/` — Provider adapters (api, claude-cli, gemini-cli, codex-cli, openclaw)
- `lib/credentials/` — Test credential management (keychain profiles + temp files)
- `config/models.yaml` — Provider config (API keys, CLI detection, token budgets)
- `docs/` — QA onboarding, testing guide, architecture

## Run artifacts

Every orchestrated run guarantees this set of artifacts in `qa-data/<project>/runs/<runId>/`, even on partial failure. A `status` field in `meta.json` records `succeeded` / `partial` / `errored`.

- `meta.json` — run metadata (status, agents, coverage, quality audit, `isGitRepo`)
- `findings.jsonl` — streamed per-agent findings (intermediate)
- `findings-final.json` — deduplicated findings array (canonical structured output)
- `delta.json` — new/recurring/remediated vs. previous run
- `coverage-report.json`, `quality-audit.json` — supporting structured data
- `agent-data/<agent>.json` — inter-agent handoff envelopes (JSON)
- Human-facing markdown reports:
  - `qa-report.md` — run synthesis (folds in release-gate verdict when present)
  - `remediation-plan.md` — open findings grouped by file + severity with fix guidance
  - `observability-gaps.md` — observability dimensions coverage
  - `qa-gaps.md` — coverage gaps (promoted from the `qa-gap-analyzer` agent)
  - `delta-report.md` — human-readable delta

## JSON handoff contract (agent I/O)

Environment→agent ingestion is JSON-only:

- Agents emit findings to `findings/<agent>.json` (array of QaFinding).
- Agents emit handoff data to `agent-data/<agent>.output.json` (object).
- Malformed JSON aborts the run with a loud `AgentIngestionError` naming the agent + run id. No silent-skip.
- Legacy `<!-- finding: {...} -->` and `<!-- agent-data: {...} -->` HTML-comment tags remain as a fallback but also fail loudly on parse errors.

## Workflow

- Run typecheck after making a series of code changes
- Prefer fixing the root cause over adding workarounds
- When unsure about approach, use plan mode (`Shift+Tab`) before coding
