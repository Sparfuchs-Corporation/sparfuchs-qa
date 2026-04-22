# Plan: Coverage Babysitter + v6 Agentic QA Architecture

**Date**: 2026-04-15 | **Status**: Review Draft
**Branch**: `feat/qa-v6-foundation` | **Triggered by**: QA gap analysis (2026-04-14, run `qa-20260414-1844-61d0`)

## Context

A QA gap analysis on a large target repository: 72% of files unexamined, `.claude` directories making reports unusable. Root cause: the orchestrator is a dumb launcher, not a supervisor. This plan fixes the immediate gaps and establishes the foundation for a best-practice multi-AI agentic QA system.

**Mandatory principle**: No agent may ever be tied to a single AI provider. Agents are defined by prompt + tool schema only. Provider selection is the orchestrator's job.

---

## Part 1: This PR

### 1.1 Exclude `.claude` and friends

**`lib/orchestrator/chunker.ts`** line 15-19
- Add `.claude`, `.worktrees`, `generated` to `EXCLUDE_DIRS`
- Defensive: verify `node_modules`, `dist`, `build`, `.git` are still present (they are, but guard against regression)

**`lib/orchestrator/testability-scanner.ts`** lines 111, 260, 287, 297, 307, 329, 386, 396
- Add `-not -path "*/.claude/*" -not -path "*/generated/*"` to all 7 `find` commands
- Line 297 (`findGeneratedFiles`): add `--exclude-dir=.claude` to the `grep -rl` — this is the 8th known `.claude/` leak source

### 1.2 Coverage strategy types

**`lib/orchestrator/types.ts`**

```typescript
export type CoverageStrategy = 'sweep' | 'balanced' | 'thorough' | 'exhaustive';

export interface CoverageStrategyConfig {
  chunkSize: number;
  maxChunkSize: number;
  maxChunksPerAgent: number | null;
  targetCoveragePercent: number;
  retryLowCoverageChunks: boolean;
  lowCoverageThreshold: number;
  maxRetriesPerChunk: number;          // default 2
  retryBackoffMs: number;              // default 0 (exponential later)
  unchunkedScopeHint: boolean;
  requireApiProvider: boolean;
}
```

| Strategy | Chunk | Max/Agent | Target | Retry | Max Retries | API-Only |
|---|---|---|---|---|---|---|
| `sweep` | 80 | 3 | 40% | no | 0 | no |
| `balanced` | 45 | null | 65% | no | 0 | yes |
| `thorough` | 25 | null | 85% | yes (<50%) | 2 | yes |
| `exhaustive` | 18 | null | 95% | yes (<60%) | 2 | yes |

Add to existing interfaces:
- `OrchestrationConfig`: add `coverageStrategy?: CoverageStrategy`
- `ChunkPlan`: add `strategy: CoverageStrategy`
- `ModelsYaml`: add `coverageStrategy?: CoverageStrategy`
- `AgentRunResult`: add `toolCallLog: ToolCallLogEntry[]`
- `AgentRunStatus.tokenUsage`: add `cacheRead: number` and `cacheCreation: number` (per `docs/optimize-agents.md` line 466-470)

### 1.2a Coverage state consolidation

**Single source of truth**: Delete the heuristic coverage computation at `index.ts:278–286` (the inline `filesInOutput` set that checks if output text contains filenames). Replace with:

```typescript
const chunkEval = babysitter.evaluateChunkCoverage(agentLabel, chunk);
status.coveragePercent = chunkEval.coveragePercent;
```

All coverage data flows through the babysitter. No duplicate tracking.

### 1.3 Surface tool call log from adapters

**`lib/orchestrator/adapters/api-adapter.ts`** — add `toolCallLog` to returned `AgentRunResult` (already captured at line 70, not returned)

All CLI adapters — return `toolCallLog: []` (CLI = no observability, correct behavior)

### 1.4 API-only enforcement for babysitting

**`lib/orchestrator/index.ts`** — when `coverageStrategy` is set with `requireApiProvider: true`:
- Filter fallback chain to API-only providers
- If no API provider available, warn and downgrade: `"Coverage babysitting requires API providers for tool call observability. Running in degraded mode."`
- Set `babysittingEnabled` flag

#### 1.4a toolCallLog cap

Bound the tool call log per agent at **5,000 entries**. Beyond that, drop `args` (keep tool name + timestamp only) and increment a `droppedCount`. Prevents unbounded memory growth on very deep agent runs while preserving the coverage signal (tool name alone tells us it was a Read/Grep/Glob; file path data is only needed for the first 5,000).

#### 1.4b CLI-only detection notice

When `requireApiProvider: true` and no API provider is available (CLI-only setup), emit a **one-time persisted warning** to `~/.sparfuchs-qa/coverage-notice.json` recommending `coverageStrategy: sweep` for CLI-only environments. Only shown once per machine.

**Why API-only?** The observability gap is fundamental:

| Capability | API Adapter | CLI Adapter |
|---|---|---|
| `onStepFinish` callback | Per-step, real-time | None |
| `toolCallLog` (Read/Grep/Glob args) | Full file paths | Empty `[]` |
| Token usage tracking | Per-step accumulation | `{ input: 0, output: 0 }` |
| Tool control (disable Bash, etc.) | Per-agent | Not supported |
| Finish reason detection | `length`/`stop`/`error` | Exit code only |

The babysitter needs tool call logs to know which files agents actually examined. CLI adapters can't provide this.

### 1.5 CoverageBabysitter class

**New: `lib/orchestrator/coverage-babysitter.ts`**

The star of this PR. This class turns the orchestrator from a launcher into a supervisor.

Implementation notes:
- `coveredFiles: Set<string>` — normalized repo-relative paths
- Tool extraction handles:
  - `Read` → `args.file_path` matched against `allSourceFiles`
  - `Grep` → `args.path` resolved to files under that path in `allSourceFiles`
  - `Glob` → every path in result intersected with `allSourceFiles`
  - Future tools that return file paths (AST, dependency graph)
- `evaluateChunkCoverage()` returns `{ shouldRetry: boolean; uncoveredInChunk: string[] }`
- `buildRetryPrompt()` generates focused re-run prompt with exact missing files. **Security**: file paths come from `find`; assert no newline/control characters before prompt injection.
- `getUncoveredFilesForHint(maxFiles)` prioritizes by heuristic:
  - In `diff` mode: files touched in recent git diff first
  - Otherwise: files with highest import count (most connected = most impactful)
  - Fallback: alphabetical for determinism

```typescript
class CoverageBabysitter {
  constructor(allSourceFiles: string[], strategy: CoverageStrategy, config: CoverageStrategyConfig)
  recordAgentRun(agentName: string, toolCallLog: ToolCallLogEntry[]): void
  evaluateChunkCoverage(agentName: string, chunk: FileChunk): {
    coveragePercent: number;
    shouldRetry: boolean;
    uncoveredInChunk: string[];
  }
  getUncoveredFilesForHint(maxFiles: number): string[]
  getCoveragePercent(): number
  isTargetMet(): boolean
  getFilesExamined(): ReadonlySet<string>
  buildRetryPrompt(chunk: FileChunk, uncoveredFiles: string[], repoPath: string): string
  buildReport(): CoverageReport
  printReport(): void
  writeReport(runDir: string): void
}
```

### 1.6 Dynamic chunk sizing

**`lib/orchestrator/chunker.ts`**
- Replace hardcoded `DEFAULT_CHUNK_SIZE`/`MAX_CHUNK_SIZE` with strategy config lookup
- Export `STRATEGY_CONFIGS` and `getStrategyConfig()`
- `buildChunkPlan()` accepts `strategy` parameter
- `groupIntoChunks()` receives sizes as arguments
- Add `estimateCoverage()` for pre-run cost/coverage preview

### 1.7 Interactive strategy selection

**`lib/orchestrator/token-budget.ts`**
- Export `AVG_TOKENS_PER_AGENT`
- Add `selectCoverageStrategy()` — interactive menu with cost estimates

### 1.8 Orchestration loop — babysitter integration

**`lib/orchestrator/index.ts`**

#### 1.8.1 Create babysitter

Create babysitter after `buildChunkPlan()` at line 128 — needs both `allSourceFiles` and `strategy`. Must initialize before the agent loop at line 214.

#### 1.8.2 Record agent runs

After each agent completes: `babysitter.recordAgentRun(agentLabel, result.toolCallLog)`

#### 1.8.3 Evaluate chunk coverage + retries

After each chunked agent, call `babysitter.evaluateChunkCoverage()`. If `shouldRetry` and retries < `maxRetriesPerChunk`:

- **1.8.3a Retry scheduling**: Retries execute immediately after the failing chunk, before the next chunk. Retries do not count against `maxChunksPerAgent`. Retries share the same budget bucket.
- **1.8.3b Budget guard**: Retries consult `checkBudget()` before executing. If cumulative projected usage >= 80% of cap, retries are suspended and a `retries-suspended` record is emitted to the run log.
- **1.8.3c Exhausted retries**: When retries are exhausted with coverage still below threshold, emit an explicit finding with `category: "coverage-gap"` and `files: [...]` listing uncovered files. No silent gaps.

#### 1.8.4 Unchunked scope hints

Before each unchunked agent: inject `getUncoveredFilesForHint(50)` as priority files in the delegation prompt.

#### 1.8.5 Apply `maxChunksPerAgent`

For sweep mode, slice chunks array to `maxChunksPerAgent`.

#### 1.8.6 Fix budget break bug

Line 302-304: `break` only exits inner chunk loop. Add `budgetExceeded` flag checked in outer agent loop.

#### 1.8.7 Coverage in `meta.json`

Add coverage schema to `meta.json` (~line 335):
```json
{
  "coverage": {
    "strategy": "balanced",
    "targetPercent": 65,
    "actualPercent": 58,
    "filesExamined": 694,
    "filesUncovered": ["src/deep/untouched.ts", "..."],
    "retriesExecuted": 3
  }
}
```

### 1.9 Live coverage in status table

**`lib/orchestrator/observability.ts`**
- Accept babysitter reference via `setCoverageBabysitter()`
- Footer: `Coverage: 47% → 65% target | 12 complete | 1 running`

#### 1.9a coverage-report.json location

Written to `runDir` (adjacent to `findings.jsonl`, `meta.json`, `quality-audit.json`, `dedup-report.json`).

### 1.10 CLI passthrough

**`scripts/qa-review-orchestrated.ts`** — parse `--coverage` arg
**`scripts/qa-review-remote.sh`** — add `COVERAGE=""`, parse `--coverage` flag, pass through
**`config/models.yaml`** — add `coverageStrategy: balanced`

Precedence: `--coverage` CLI flag wins; `COVERAGE=` env var used only if flag absent.

#### 1.10a moduleScope contract

Babysitter operates on files within `moduleScope` only. `allSourceFiles` is already scoped by `discoverSourceFiles(repoPath, moduleScope)` — no additional filtering needed in the babysitter.

#### 1.10b Feature flag: `COVERAGE=off`

`--coverage off` (or `COVERAGE=off`) short-circuits the babysitter entirely. No strategy selection, no tool call tracking, no retries. Escape hatch for incidents or debugging. Existing behavior preserved exactly.

### 1.11 Provider-Agnostic Agent Rule (mandatory)

**Principle**: Agents are defined only by prompt + tool schema. Provider selection is the orchestrator's job at runtime based on:
- `CoverageStrategyConfig.requireApiProvider`
- Available providers in `config/models.yaml`
- User override (`--provider` or `agentOverrides`)
- Fallback chain

**No agent file may contain**:
- Provider-specific instructions ("use Claude XML tags")
- Model-family assumptions ("you have tool use like GPT-4")
- Hardcoded `cache_control`, conversation IDs, or provider quirks

**All provider-specific behavior lives only in**:
- `lib/orchestrator/adapters/*-adapter.ts`
- `lib/orchestrator/prompt-composer.ts` (`getModelSpecificGuidance()` — already correctly isolated)
- `config/models.yaml` capability flags

The current `agentOverrides` in `models.yaml` set `provider: xai` for some agents. This is a **routing preference**, not an agent coupling — the agent itself is provider-agnostic, the orchestrator routes it. This is correct. The override is in config, not in the agent definition.

### 1.12 Credential Security

**Current state**: Already robust. `credential-store.ts` supports:
- macOS Keychain (`security` CLI)
- Windows Credential Manager (PowerShell `StoredCredential`)
- Linux `secret-tool` (GNOME Keyring / KDE Wallet)
- Env var fallback (for CI/CD)
- API keys: keychain-first, env-var fallback
- Test profiles: JSON serialized into keychain entries

**This PR**: No credential changes needed — existing system is correct.

**Future (noted for v6 roadmap)**:
- 1Password CLI integration (`op read op://vault/item/field`)
- Bitwarden CLI integration (`bw get password`)
- HashiCorp Vault for enterprise deployments
- These would be added as new backends in `credential-store.ts` alongside the existing `readFromKeychain`/`writeToKeychain` functions, selected by a new `credentialBackend` config field

### 1.13 Standardized inter-agent data exchange

Agents need to pass structured data to downstream agents — not just findings, but inventories, matrices, and classifications. This is the contract that makes training, tier-to-tier testing, and the future pipeline DAG work.

#### 1.13.1 Agent output envelope

Every agent produces, alongside its markdown session log, a **structured JSON output** written to `{runDir}/agent-data/{agentName}.json`. The orchestrator reads these and forwards relevant slices to downstream consumers.

```typescript
export interface AgentOutputEnvelope {
  agent: string;                       // agent name
  runId: string;
  completedAt: string;                 // ISO timestamp
  status: 'complete' | 'failed' | 'partial';

  // Structured data — schema varies by agent
  data: Record<string, unknown>;

  // Standard finding summary (always present)
  findingSummary: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
  };
}
```

#### 1.13.2 Complete agent I/O map

Every agent, its structured data output, its upstream inputs (required/optional), and its downstream consumers.

**Stage 0 — Pre-flight (no upstream deps)**

| Agent | Structured Output (`data` key) | Schema | Downstream Consumers |
|---|---|---|---|
| `build-verifier` | `buildStatus` | `{ passed, errors[], warnings[] }` | release-gate, deploy-readiness |
| `semantic-diff-reviewer` | `diffSummary` | `{ changedFiles[], riskLevel, behaviorChanges[] }` | risk-analyzer, regression-risk-scorer |
| `regression-risk-scorer` | `riskScores` | `Array<{ file, score, churnCount, revertCount }>` | chunker (risk-weighted allocation), risk-analyzer |

**Stage 1 — Independent reviewers (findings-only unless noted)**

| Agent | Structured Output | Upstream Input (optional) | Downstream Consumers |
|---|---|---|---|
| `code-reviewer` | `findingSummary` only | — | release-gate |
| `security-reviewer` | `securityFindings` `Array<{ file, category, cweId? }>` | — | release-gate, compliance-reviewer |
| `performance-reviewer` | `findingSummary` only | — | release-gate |
| `a11y-reviewer` | `a11yFindings` `Array<{ file, wcagRule, level }>` | — | release-gate |
| `observability-auditor` | `observabilityScores` `Record<dimension, score>` | — | release-gate, deploy-readiness |
| `spec-verifier` | `featureInventory` `Array<{ route, component, completeness, personas }>` | — | **training** (required), qa-gap-analyzer |
| `rbac-reviewer` | `roleMatrix` `{ roles[], permissions: Record<role, Record<module, access>> }` | — | **training** (required), access-query-validator, role-visibility-matrix, permission-chain-checker |
| `stub-detector` | `stubs` `Array<{ file, type, severity, description }>` | — | **training** (required), release-gate |
| `ui-intent-verifier` | `handlerTraces` `Array<{ element, chain[], verified }>` | — | **training** (required) |
| `collection-reference-validator` | `collections` `Array<{ name, references[], orphaned }>` | — | **training** (required), schema-migration-reviewer |
| `workflow-extractor` | `workflows` `Array<{ name, steps[], actors[] }>` | — | training (optional), qa-gap-analyzer |
| `contract-reviewer` | `contractDrift` `Array<{ endpoint, field, expected, actual }>` | — | api-spec-reviewer, release-gate |
| `deploy-readiness-reviewer` | `deployChecklist` `Array<{ check, passed, detail }>` | `buildStatus` (opt) | release-gate |
| `risk-analyzer` | `riskAssessment` `{ overallScore, topRisks[] }` | `riskScores` (opt), `diffSummary` (opt) | release-gate |
| `compliance-reviewer` | `complianceStatus` `Array<{ regulation, check, status }>` | `securityFindings` (opt) | release-gate |
| `access-query-validator` | `findingSummary` only | `roleMatrix` (opt) | release-gate |
| `permission-chain-checker` | `findingSummary` only | `roleMatrix` (opt) | release-gate |
| `role-visibility-matrix` | `visibilityMatrix` `Record<role, Record<module, visible>>` | `roleMatrix` (opt) | training (optional) |
| `dead-code-reviewer` | `findingSummary` only | — | release-gate |
| `schema-migration-reviewer` | `migrationStatus` `{ pending[], applied[], drift[] }` | `collections` (opt) | release-gate |
| `mock-integrity-checker` | `findingSummary` only | — | release-gate |
| `environment-parity-checker` | `envDrift` `Array<{ var, env, status }>` | — | deploy-readiness (optional) |
| `iac-reviewer` | `findingSummary` only | — | release-gate |
| `dependency-auditor` | `depStatus` `{ outdated[], deprecated[], vulnerable[] }` | — | sca-reviewer, release-gate |
| `sca-reviewer` | `findingSummary` only | `depStatus` (opt) | release-gate |
| `api-spec-reviewer` | `findingSummary` only | `contractDrift` (opt) | release-gate |
| `doc-reviewer` | `findingSummary` only | — | release-gate |

**Stage 1 — Test execution**

| Agent | Structured Output | Upstream Input | Downstream Consumers |
|---|---|---|---|
| `test-runner` | `testResults` `{ passed, failed, skipped, failures[] }` | — | **failure-analyzer** (required), release-gate |
| `smoke-test-runner` | `smokeResults` `{ endpoints[], passed, failed }` | — | release-gate |
| `api-contract-prober` | `probeResults` `Array<{ endpoint, status, match }>` | — | contract-reviewer (optional), release-gate |
| `crud-tester` | `findingSummary` only | — | release-gate |
| `e2e-tester` | `findingSummary` only | — | release-gate |
| `boundary-fuzzer` | `findingSummary` only | — | release-gate |
| `fixture-generator` | `findingSummary` only | — | — |

**Stage 2 — Synthesis (require upstream data)**

| Agent | Structured Output | Required Upstream | Optional Upstream |
|---|---|---|---|
| `failure-analyzer` | `failureAnalysis` `Array<{ test, rootCause, classification }>` | `testResults` | — |
| `release-gate-synthesizer` | `verdict` `{ decision, riskScore, confidence, actionItems[] }` | all `findingSummary` | all structured data |
| `qa-gap-analyzer` | `gapAnalysis` `{ coverageByDir[], blindSpots[], recommendations[] }` | all `findingSummary` | `featureInventory` |
| `training-system-builder` | `trainingSpec` (markdown output) | `featureInventory`, `roleMatrix`, `stubs`, `handlerTraces`, `collections` | `workflows`, `visibilityMatrix` |
| `architecture-doc-builder` | `architectureDoc` (markdown output) | — | `featureInventory`, `workflows`, `collections` |

**Key**: `(opt)` = uses if available, falls back to self-discovery. **Bold** = hard dependency (agent should not run without it).

#### 1.13.3 How agents emit structured data

Agents emit structured data via a new tag format alongside finding tags:

```html
<!-- agent-data: {"featureInventory": [{"route": "/crm/contacts", "component": "ContactList.tsx", "completeness": "complete"}]} -->
```

The orchestrator's `parseFindingTags` function is extended to also parse `<!-- agent-data: {...} -->` tags. The parsed data is written to `{runDir}/agent-data/{agentName}.json`.

**Why tags, not direct file writes?** Agents already write tags (finding tags). Adding a data tag keeps the output channel consistent — the orchestrator controls all file I/O, and the agent stays sandboxed. The agent doesn't need to know where the data file goes.

#### 1.13.4 Downstream injection

Before launching a downstream agent, the orchestrator:
1. Reads `agent-data/*.json` for all completed upstream agents
2. Builds an `UPSTREAM DATA` prompt block with relevant slices:

```
UPSTREAM DATA (from completed agents — machine-readable, use directly):

@spec-verifier featureInventory:
[{"route":"/crm/contacts","component":"ContactList.tsx","completeness":"complete"}, ...]

@rbac-reviewer roleMatrix:
{"roles":["admin","manager","user"],"permissions":{"admin":{"crm":"full","hr":"full"},...}}

@stub-detector stubs:
[{"file":"src/crm/reports.tsx","type":"SAVE_THEATER","severity":"high"}, ...]
```

3. Downstream agents receive structured JSON, not session log markdown to parse

This replaces the current approach where training-system-builder reads raw session log files and tries to extract data from prose.

#### 1.13.5 Tier-to-tier testing

The standardized format enables tier testing:
- **Stage 0 → Stage 1**: `regression-risk-scorer.data.riskScores` feeds into chunk allocation (risk-weighted `maxSteps`)
- **Stage 1 → Stage 2**: `spec-verifier.data.featureInventory` + `stub-detector.data.stubs` feed into training
- **Stage 1 → Stage 2**: `build-verifier.data.buildStatus` + `test-runner.data.testResults` feed into release-gate-synthesizer

Each tier boundary is a defined JSON contract. If the upstream schema changes, the downstream consumer breaks loudly (schema validation) rather than silently producing degraded output.

#### 1.13.6 Agent status: `awaiting-data`

New agent status for downstream agents whose upstream dependencies haven't completed yet:

```typescript
// Add to AgentRunStatus.status:
type AgentStatus = 'queued' | 'awaiting-data' | 'running' | 'retrying' | 'complete' | 'failed';
```

**Behavior**:
- When the orchestrator reaches a downstream agent (e.g., `training-system-builder`), it checks `agent-data/` for required upstream envelopes
- If any required upstream agent hasn't completed: set status to `awaiting-data`, display in dashboard as `⧗ AWAITING` with the missing dependency names
- If a required upstream agent failed or was skipped: set status to `failed` with error `"Missing upstream data: rbac-reviewer (failed), stub-detector (skipped)"`. The agent does NOT run — there's no point running training with missing dependency data that would produce degraded output.
- If all upstream data is present: proceed to `running`

**Dashboard display**:
```
9  training-system-builder     ⧗ AWAITING  —          —       —      —     — [waiting: rbac-reviewer, stub-detector]
```

**Status icon additions**:
```typescript
const STATUS_ICONS = {
  // ...existing
  'awaiting-data': '⧗ ',  // hourglass
};
```

This makes dependency state visible — the operator immediately sees WHY an agent isn't running, not just that it's queued.

### 1.14 Training agents as pipeline consumers (mandatory)

Training agents (`training-system-builder`, `architecture-doc-builder`) are **not optional add-ons** — they produce core output whose quality is directly gated by coverage completeness and upstream agent success.

#### 1.14.1 Upstream dependency model

The `training-system-builder` agent already declares its upstream consumers (agent lines 24-38):

| Upstream Agent | What Training Consumes | Impact if Missing |
|---|---|---|
| `spec-verifier` | Feature inventory, completeness classification | Training re-discovers routes from scratch — slower, less accurate |
| `ui-intent-verifier` | Handler chain traces (onClick → service → DB) | Training re-traces handlers — duplicated work, may miss paths |
| `rbac-reviewer` | Role definitions, permission matrix | Training re-discovers roles — may miss role-specific variations |
| `stub-detector` | Stub classifications (VIBE_CODED, SAVE_THEATER) | Training documents fake features as real — unusable output |
| `collection-reference-validator` | Collection names, cross-references | Training seed data spec has wrong field names |

**Current problem**: The orchestrator has no concept of these dependencies. If `rbac-reviewer` gets budget-killed or fails, the training agent silently degrades to standalone discovery mode (line 36). The operator gets no warning that training quality is compromised.

#### 1.14.2 Babysitter enforcement for training mode

When `--training` is active (standalone or integrated):

1. **Dependency check**: Before launching training agents, babysitter verifies all 5 upstream agents completed successfully. If any failed or were skipped:
   - Emit a `training-dependency-missing` finding listing which upstream agents are absent
   - Log warning: `"Training quality degraded: {agent} output unavailable. Training will fall back to standalone discovery for {data type}."`

2. **Coverage floor**: When training is requested, enforce a minimum coverage strategy of `balanced` (65%). Training from a `sweep` run (40% coverage) produces documentation with known gaps. If `--coverage sweep --training` is passed, warn: `"Coverage strategy 'sweep' is insufficient for training output. Upgrading to 'balanced'."`

3. **Training agents run last**: Training agents must execute after all their upstream dependencies. In the current sequential loop, this means they must be ordered after spec-verifier, rbac-reviewer, etc. In the future parallel pipeline (Phase 2B), they are explicit Stage 2 consumers.

#### 1.14.3 Shared data forwarding via agent output envelopes

Uses the standardized inter-agent data exchange from 1.13. After all Stage 1 agents complete and before training agents launch, the orchestrator:

1. Reads `{runDir}/agent-data/*.json` for all completed upstream agents
2. Extracts the relevant `data` slices per the schema table in 1.13.2
3. Injects them into the training agent's delegation prompt as an `UPSTREAM DATA` block (per 1.13.4)

This replaces the current approach where `training-system-builder` reads raw session log markdown and tries to grep for structured data. The training agent receives machine-readable JSON — feature inventories, role matrices, stub lists — directly.

#### 1.14.4 Training coverage in `meta.json`

Add to the coverage schema:
```json
{
  "coverage": {
    "trainingMode": true,
    "upstreamDependencies": {
      "spec-verifier": "complete",
      "rbac-reviewer": "complete",
      "ui-intent-verifier": "failed",
      "stub-detector": "complete",
      "collection-reference-validator": "skipped"
    },
    "trainingQualityGrade": "degraded"
  }
}
```

`trainingQualityGrade`: `"full"` (all deps met + coverage >= thorough), `"adequate"` (all deps met + coverage >= balanced), `"degraded"` (missing deps or low coverage).

### 1.15 Operator dashboard (`sparfuchs top`)

The orchestrator currently has no operator controls and mixes data with rendering. This section adds a `top`-style live dashboard with a clean data/renderer separation to support future web UI migration.

#### 1.15.1 Architecture: data layer + renderer

Split the current `ObservabilityTracker` into two layers:

**`lib/orchestrator/run-state.ts`** — Pure data. No ANSI, no `process.stderr`, no TTY detection.

```typescript
export class RunState {
  // --- Agents ---
  getAgents(): ReadonlyArray<AgentRunStatus>
  getAgent(name: string): AgentRunStatus | undefined
  getActiveAgents(): ReadonlyArray<AgentRunStatus>

  // --- Aggregates (computed, not rendered) ---
  snapshot(): RunStateSnapshot  // single object a renderer can consume
}

export interface RunStateSnapshot {
  runId: string;
  startedAt: string;
  elapsedMs: number;

  // Overall progress
  progress: {
    totalChecks: number;               // total agent invocations expected (incl. chunks)
    completedChecks: number;           // agents finished (complete + failed + skipped)
    percent: number;
    etaMs: number | null;              // estimated time remaining based on avg agent duration
  };

  // Run health
  lastUpdated: string;                   // ISO timestamp — for stale detection

  // Agent counts
  agents: { total: number; queued: number; awaitingData: number; running: number; stale: number; complete: number; failed: number; skipped: number };

  // Findings
  findings: { total: number; bySeverity: Record<string, number> };

  // Tokens (includes cache metrics per docs/optimize-agents.md)
  tokens: {
    input: number;
    output: number;
    cacheRead: number;                 // tokens served from cache (~10% cost)
    cacheCreation: number;             // tokens written to cache
    total: number;
    cacheHitRate: number;              // cacheRead / (input + cacheRead)
    estimatedSavingsUsd: number;       // vs. no caching
  };
  budget: { cap: number; used: number; percent: number } | null;

  // Coverage (from babysitter)
  coverage: { strategy: string; targetPercent: number; actualPercent: number; filesExamined: number; filesTotal: number } | null;

  // Training (from babysitter)
  training: { mode: boolean; qualityGrade: string; upstreamStatus: Record<string, string> } | null;

  // Providers
  providers: Array<{ name: string; agentCount: number }>;
  fallbacks: number;

  // Per-agent detail
  agentRows: Array<{
    index: number;
    name: string;
    status: string;
    provider: string;
    model: string;
    tokens: number;
    findings: number;
    files: { examined: number; assigned: number; percent: number } | null;  // chunked agents
    durationMs: number;
    error: string | null;
  }>;

  // Active agent detail (for the currently running agent)
  activeAgent: {
    name: string;
    assignedFiles: string[];           // full list of files in chunk
    examinedFiles: string[];           // files touched so far (from toolCallLog)
    toolCallCount: number;
    lastAction: string | null;         // e.g. "Read src/auth/middleware.ts"
  } | null;
}
```

**`lib/orchestrator/renderers/tty-renderer.ts`** — Takes a `RunStateSnapshot`, outputs ANSI to stderr. This is the current `renderStatusTable()` logic extracted. Refresh loop stays here.

**`lib/orchestrator/renderers/json-renderer.ts`** — Takes a `RunStateSnapshot`, writes JSON to a file or stdout. For CI/piped mode and future web polling.

**`lib/orchestrator/renderers/log-renderer.ts`** — Takes a `RunStateSnapshot`, outputs sequential log lines. Replaces current non-TTY fallback.

The existing `ObservabilityTracker` becomes a thin wrapper: it owns a `RunState`, selects a renderer based on TTY/environment, and drives the refresh loop.

#### 1.15.2 Operator controls (SIGINT/keyboard)

**Graceful shutdown** — Register SIGINT handler. On first Ctrl+C:
- Set `shuttingDown` flag
- Let current agent finish (don't kill mid-execution)
- Skip remaining queued agents
- Write partial results (meta.json, coverage-report.json, findings.jsonl)
- Print final summary with `(interrupted)` annotation
- Exit cleanly

On second Ctrl+C: force kill.

**Keyboard commands** (when TTY, read stdin in raw mode):
- `q` — graceful shutdown (same as Ctrl+C first press)
- `s` — toggle sort order (by name, by status, by duration, by findings)
- `d` — toggle detail level (compact table / expanded with active agent file checklist)
- `p` — pause queue (finish current agent, don't start next)
- `r` — resume queue
- `?` — show/hide help overlay

This is the `top` experience: live-updating table with keyboard navigation.

**Keyboard implementation** in `tty-renderer.ts`:

```typescript
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key.ctrl && key.name === 'c') { shutdown(); }
    else if (key.name === 'q') { shutdown(); }
    else if (key.name === 'p') { runState.pause(); render(); }
    else if (key.name === 'r') { runState.resume(); render(); }
    else if (key.name === 's') { cycleSort(); render(); }
    else if (key.name === 'd') { toggleDetail(); render(); }
    else if (str === '?') { toggleHelp(); render(); }
  });
}
```

**Terminal cleanup** — `shutdown()` function restores terminal state before exit:
- `process.stdin.setRawMode(false)`
- Show cursor: `process.stderr.write('\x1b[?25h')`
- Clear status table lines
- Called from both SIGINT handler and `q` key
- Prevents leaving terminal in raw mode after exit

**Help overlay** — Pressing `?` replaces the dashboard with a help screen. Press `?` again or `Esc` to return to the live view:

```
=== Sparfuchs QA — Keyboard Commands ===

  q         Graceful shutdown — finish current agent, skip remaining,
            write partial results, exit cleanly
  Ctrl+C    Same as q (first press). Force kill (second press).

  s         Cycle sort order: name → status → duration → findings → coverage
  d         Toggle detail panel: show/hide active agent file checklist
  p         Pause — finish current agent, hold queue
  r         Resume — continue processing queued agents

  ?         Toggle this help screen
  Esc       Close help / close detail panel

─── Status Icons ───────────────────────
  ◉  RUNNING    Agent is actively executing
  ⧗  AWAITING   Waiting for upstream agent data (dependencies not yet met)
  ✓  COMPLETE   Agent finished successfully
  ✗  FAILED     Agent errored on all providers (or missing required upstream data)
  ↻  RETRYING   Agent failed, trying next provider
     QUEUED     Waiting to run
     SKIPPED    Predicted ineffective or incompatible

─── Files Column ───────────────────────
  9/25 36%↑   9 of 25 assigned files examined, still climbing
  22/25 88%   Final coverage for completed agent
  —           Unchunked agent (no file assignment)

─── Dependencies ────────────────────────
  ⧗ AWAITING    Agent blocked on upstream data — names shown in brackets
  [needs: 5↑]   Agent waiting on 5 upstream agents to complete
  [waiting: X]   Specific agents whose data is not yet available

  Tip: run `sparfuchs status --watch` in a second pane for external monitoring

Press ? or Esc to return to live view
```

#### 1.15.3 Run state file (enables `sparfuchs status`)

During a run, write `~/.sparfuchs-qa/active-run.json` containing the current `RunStateSnapshot` (updated every refresh cycle). Delete on completion.

This enables:
- **`sparfuchs status`** — CLI command that reads `active-run.json` and renders it (no need to be in the same terminal). If `lastUpdated` > 30s ago, display `(stale — run may have crashed)` in red.
- **`sparfuchs status --watch`** — runs its own 1s polling loop + clears screen. Open in a second terminal pane for a live external monitor without touching the running process.
- **Future web dashboard** — polls this file or a WebSocket
- **Crash recovery awareness** — if `active-run.json` exists on startup, a previous run didn't complete cleanly

Implementation: tiny new script `scripts/sparfuchs-status.ts` (or add a `--status` mode to `qa-review-orchestrated.ts`).

#### 1.15.4 `top` display layout

```
=== Sparfuchs QA — Live Dashboard ===
Run: qa-20260415-1432-a3f1 | Repo: sample-project | Strategy: balanced
Elapsed: 4m 32s | ETA: ~6m remaining

Progress:  ████████████████░░░░░░░░░░░░░░ 12/38 agents (32%)
Budget:    ██████████░░░░░░░░░░           960k / 2.0M tokens (48%)
Coverage:  ████████████░░░░░░░░           694 / 1200 files (58% → 65% target)
Cache:     ██████████████░░░░░░           71% hit rate | saved ~$4.20
Training:  adequate (4/5 upstream deps met)

#  Agent                         Status     Provider       Tokens    Findings  Files          Duration
── ──────────────────────────── ────────── ────────────── ───────── ───────── ────────────── ────────
1  build-verifier               ✓ COMPLETE  xai            12.4k     2        —              18s
2  security-reviewer-chunk-1    ✓ COMPLETE  xai            84.2k     7        18/25  72%     142s
3  security-reviewer-chunk-2    ◉ RUNNING   xai            31.0k     —        9/25   36%↑    67s
4  code-reviewer-chunk-1        ✓ COMPLETE  anthropic      62.1k     4        22/25  88%     95s
5  a11y-reviewer-chunk-1          QUEUED    —              —         —        0/25   —       —
6  rbac-reviewer                  QUEUED    —              —         —        —              —
...
9  training-system-builder        QUEUED    —              —         —        —              — [needs: 5↑]

── Active Agent Detail ──────────────────────────────────────────────────────
  security-reviewer-chunk-2 (xai/grok-4.20-reasoning) — 67s running
  Assigned: 25 files | Examined: 9 (36%) | Tool calls: 24
  Last action: Read src/auth/middleware.ts
  ✓ src/api/routes/users.ts        ✓ src/api/routes/auth.ts
  ✓ src/auth/middleware.ts          ✓ src/auth/jwt-utils.ts
  ✓ src/db/queries/user.ts         ✓ src/services/email.ts
  ✓ src/config/cors.ts             ✓ src/config/session.ts
  ✓ src/utils/crypto.ts
  · src/api/routes/billing.ts      · src/api/routes/webhooks.ts    (16 more...)
──────────────────────────────────────────────────────────────────────────────

3 complete | 1 running | 5 queued | 0 failed | [q]uit [p]ause [s]ort [d]etail [?]help
```

Key additions vs. current display:
- **Progress bar** — `12/38 agents (32%)` with ETA based on average agent duration
- **Four aligned progress bars** — progress, budget, coverage, and cache hit rate
- **Cache line** — hit rate + estimated dollar savings vs. no caching (per `docs/optimize-agents.md`: cache reads at ~10% of input cost, ~28-30K tokens saved/run)
- **Files column** — `examined/assigned` with percentage for chunked agents, updated live from babysitter tool call tracking
- **`↑` indicator** — files count is actively climbing (agent is still examining)
- **Active agent detail panel** — shows the currently running agent's real-time progress:
  - Assigned file count, examined count, tool call count
  - Last tool action (what the agent just did)
  - Checklist of assigned files: `✓` examined, `·` not yet touched
  - Scrolls if file list is long (shows count of remaining)
- **Coverage progress bar** with target
- **Training status line** with upstream dep count
- **Dependency indicator** (`[needs: 5↑]`) for Stage 2 agents waiting on upstream
- **Keyboard hint footer**

The active detail panel updates in real-time as `onStepFinish` fires — the operator sees the agent working through its assigned files live. Toggle with `d` key (compact = table only, detail = table + active panel).

#### 1.15.5 Refresh rate and data integrity

**Current state**: Fixed 1s `setInterval`, zero data verification. `AgentRunStatus` objects are mutated by reference from two unsynchronized sources (`onStepFinish` callback + orchestration loop). No heartbeat, no staleness detection.

**Refresh rate — event-driven + timer hybrid**:
- **Timer**: 1 second `setInterval` (configurable via `SPARFUCHS_REFRESH_MS`, min 200ms, max 5000ms)
- **Event-driven**: force immediate re-render on any state change — agent complete, coverage tick, new tool call, fallback event. This feels snappier than timer-only; the operator sees updates the instant they happen.
- JSON renderer: writes to `active-run.json` every **2 seconds** via atomic write (`fs.writeFileSync(tmpPath)` + `fs.renameSync(tmpPath, targetPath)`) — prevents partial reads by `sparfuchs status`
- Log renderer: event-driven only (no polling — writes on status change)

**Data integrity guarantees**:

1. **Snapshot isolation**: The renderer never reads the live `RunState` directly. Instead, `RunState.snapshot()` produces an immutable `RunStateSnapshot` copy. The renderer works from the snapshot. This prevents torn reads where token count updated but finding count hasn't yet.

2. **Heartbeat for running agents**: Each `onStepFinish` callback updates a `lastHeartbeat: number` timestamp on the agent status. Staleness is defined as **2 missed refresh cycles** (not a fixed duration) — if `Date.now() - lastHeartbeat > refreshIntervalMs * 2`, show status as `◉ STALE` instead of `◉ RUNNING`. At the default 1s refresh, that's 2s of silence. This catches hung agents — provider timeouts, network drops, or silent failures — quickly and proportionally to the configured refresh rate.

   Dashboard display for stale agents includes a countdown showing when the status may change:
   ```
   3  security-reviewer-chunk-2    ◉ STALE    xai    31.0k  —  9/25 36%  67s  (no heartbeat 4s — waiting for step)
   ```
   The `(no heartbeat Ns — waiting for step)` annotation updates every refresh cycle, giving the operator a clear signal that the system is aware and monitoring, not frozen.

3. **Cross-check on completion**: When the final summary is printed and `meta.json` is written, compare dashboard-tracked totals (token sum, finding count, agent count) against the JSONL/meta actuals. If they diverge > 1%, log a warning: `"Dashboard drift detected: dashboard showed {n} findings, meta.json has {m}."` This catches accumulation bugs.

4. **Coverage consistency**: The babysitter's `getCoveragePercent()` is the single source of truth. The dashboard reads from the babysitter snapshot, not from any independent computation. The deleted heuristic at `index.ts:278-286` (section 1.2a) eliminates the only other coverage computation path.

5. **Stale run detection**: `active-run.json` includes a `lastUpdated` ISO timestamp. If a `sparfuchs status` command reads it and `Date.now() - lastUpdated > 30_000`, display `(stale — run may have crashed)` instead of live data.

#### 1.15.6 Rendering approach

- **Progress bars**: Simple ANSI blocks (`█░`) — no heavy dependencies. Four bars aligned in header.
- **Agent table**: Manual column padding with fixed widths + truncation for long names. No table library.
- **Active detail panel**: Bordered box with `┌─┐│└─┘` characters.
- **Files column `↑` indicator**: Show only while agent is `running` AND examined count increased in the last refresh cycle.
- **`sparfuchs status` header**: Include `Last updated: Xs ago` so the operator knows data freshness.
- **Cache savings USD**: Based on `tokenBudget.pricing` from `models.yaml` (already per-provider $/1M tokens). Compute: `savings = cacheRead * (normalPrice - cachePrice) / 1M` where `cachePrice = normalPrice * 0.1`.

#### 1.15.7 Dashboard implementation checklist

| Step | File | What |
|---|---|---|
| 1 | `lib/orchestrator/run-state.ts` | **New** — `RunState` class + `RunStateSnapshot` interface, pure data |
| 2 | `lib/orchestrator/renderers/tty-renderer.ts` | **New** — ANSI top-style display, keyboard handler, SIGINT |
| 3 | `lib/orchestrator/renderers/json-renderer.ts` | **New** — atomic `active-run.json` write every 2s |
| 4 | `lib/orchestrator/renderers/log-renderer.ts` | **New** — sequential log lines for non-TTY/CI |
| 5 | `lib/orchestrator/observability.ts` | **Refactor** — thin wrapper: owns `RunState`, picks renderer, drives hybrid refresh |
| 6 | `lib/orchestrator/index.ts` | Wire babysitter → `RunState` on every `recordAgentRun`/`evaluateChunkCoverage` |
| 7 | `lib/orchestrator/coverage-babysitter.ts` | Already exposes everything the dashboard needs (`getCoveragePercent`, `getFilesExamined`, active chunk state) |
| 8 | `scripts/sparfuchs-status.ts` | **New** — `sparfuchs status` and `sparfuchs status --watch` (reads `active-run.json`) |

### 1.16 CoverageBabysitter tests

Required behavior tests for `coverage-babysitter.test.ts`:

- **Tool extraction — Read**: `recordAgentRun` with Read tool calls → `coveredFiles` includes matched paths
- **Tool extraction — Grep**: Grep with `path` arg → all `allSourceFiles` under that path marked covered
- **Tool extraction — Glob**: Glob results intersected with `allSourceFiles` → correct coverage
- **evaluateChunkCoverage — under threshold**: Chunk with 20% coverage on `thorough` strategy → `shouldRetry: true`
- **evaluateChunkCoverage — over threshold**: Chunk with 80% coverage → `shouldRetry: false`
- **buildRetryPrompt contents**: Output includes only uncovered file paths, chunk ID, and "RETRY" instruction
- **buildRetryPrompt — path sanitization**: File paths with newlines/control chars → rejected with error
- **getUncoveredFilesForHint — diff mode**: In diff mode, recently changed files prioritized first
- **getUncoveredFilesForHint — default mode**: Files returned in deterministic order (alphabetical fallback)
- **getCoveragePercent**: Correct percentage calculation across multiple agent runs
- **isTargetMet**: Returns true only when `coveragePercent >= targetCoveragePercent`
- **toolCallLog cap**: More than 5,000 entries → args dropped beyond cap, count preserved

---

## Part 2: v6 Architecture Roadmap

### Phase 2A: Parallel Execution + Prompt Caching (highest ROI, do next)

**Parallel agent execution** — `Promise.all` on Stage 1 agents. Group into dependency stages:
- Stage 0: testability scanner, regression-risk-scorer (pre-flight)
- Stage 1: all independent reviewers in parallel
- Stage 2: agents depending on Stage 1 (release-gate-synthesizer, qa-gap-analyzer)

`ObservabilityTracker` already supports concurrent agents. Wall-clock: 27min → ~4min.

**Prerequisite**: Before parallel agent execution lands, `CoverageBabysitter` must be made concurrency-safe — either mutex on `coveredFiles` or per-agent shards unioned post-run.

**Prompt caching** — Full implementation plan in `docs/optimize-agents.md` (~28-30K tokens saved/run, ~$4-6 savings per full audit). Priority: Anthropic (`cache_control` with ephemeral markers), xAI (conversation IDs via `x-grok-conv-id`), Gemini (context caching with TTL), OpenAI (automatic prefix caching). Universal prompt structure: static content at top (safety, rubric, rules) → semi-static (model guidance, templates) → dynamic at bottom (delegation, baseline, chunks). All caching logic lives in adapters — agents remain provider-agnostic. Cache metrics (`cacheRead`, `cacheCreation`, `cacheHitRate`) tracked in `AgentRunStatus` and displayed in dashboard.

### Phase 2B: Pipeline DAG + Shared Context (critical for training)

**Pipeline topology** — DAG in config. Training agents are the primary motivator: they depend on 5 upstream agents' structured output. The minimal forwarding in 1.13.3 is a bridge — this phase replaces it with first-class pipeline support.

```yaml
pipeline:
  - stage: 0
    agents: [build-verifier, regression-risk-scorer]
  - stage: 1
    agents: [code-reviewer, security-reviewer, spec-verifier, rbac-reviewer, stub-detector, ui-intent-verifier, collection-reference-validator, ...]
    dependsOn: [regression-risk-scorer]
  - stage: 2
    agents: [training-system-builder, architecture-doc-builder, release-gate-synthesizer, qa-gap-analyzer]
    dependsOn: [stage-1]
    requires: [spec-verifier, rbac-reviewer, stub-detector]  # hard deps for training
```

**Shared context store** — `RunContext` object. As agents complete, key findings summarized and injected into subsequent agents. No agent reads another agent's full output. Training agents receive structured upstream data instead of parsing session logs.

**Agent handoff annotations** — `<!-- finding: {..., "handoff": "security-reviewer: examine auth bypass"} -->`. Orchestrator queues targeted follow-up.

### Phase 2C: Smart Chunking

**Import-graph chunking** — Parse imports (`ts-morph` or regex), build dependency graph. Chunks become semantic modules: file + its imports. `buildDependencyAwareChunks()` in chunker.ts.

**Risk-weighted step allocation** — `regression-risk-scorer` as Stage 0 pre-flight. High-churn files → `maxSteps: 100`; stable → `maxSteps: 30`.

**Blast-radius in diff mode** — Transitive dependents of changed files auto-included.

**Audit cache integration** — `file-audit-cache.ts` fed into chunk planning. Unchanged files since last audit → lighter review.

### Phase 2D: Quality + Trust

**Confidence scoring** — Per-finding score: tool call count, specific line citation, cited line matches pattern, cross-agent concordance, canary match. `confidence: number` on `QaFinding`.

**Finding provenance** — Link tool call log entries to findings by timestamp proximity. `provenance: ToolCallLogEntry[]` on finding.

**Ensemble verification** — Critical agents run on two providers simultaneously. Concordant = high confidence, discordant = human review.

**Adversarial red-team agent** — Reads "clean" verdicts, tries to disprove them.

### Phase 2E: MCP + RAG

**MCP server (orchestrator → agents)**:
- `coverage_status` resource — agents query what's been covered
- `priority_files` tool — agents ask "what should I look at?"
- `previous_findings` resource — context from prior runs
- `dependency_graph` tool — "what imports this file?"

Agents become self-directing. Babysitter becomes a service, not a controller.

**RAG context** — Vector store of past findings. Agents query history without bloating prompts.

**AST-aware tools** — `QueryAST` via `ts-morph`/`tree-sitter`. Structural queries instead of text grep.

### Phase 2F: Cost Optimization

**Two-pass progressive disclosure** — Pass 1: all agents at `light` tier, `maxSteps: 15`. Pass 2: re-run only agents with critical/high findings at full tier. 80% coverage at 40% cost for clean codebases.

### Phase 2G: Agent Autonomy

**Step budget extension** — `<!-- extend-steps: 25 reason="complex auth" -->`. Babysitter parses on `onStepFinish`, increases `maxSteps`.

**Sub-task delegation** — `<!-- delegate: security-reviewer target="src/auth/" -->`. Babysitter queues follow-up.

**Per-project agent memory** — `memory.json` per project per agent. Files reviewed, patterns found, confirmed areas.

### Phase 2H: Multi-Model Strategy (strengthened by 1.11)

**Empirical model routing** — Track per-agent per-provider: findings, hallucination rate, cost, duration. Auto-populate `agentOverrides` from data. Every agent already provider-agnostic → instant swappability.

**A/B testing** — `--ab-test` runs each agent on two providers, compares concordance.

### Phase 2I: Observability + Self-Evolution

**Agent performance registry** — `qa-data/{project}/agent-performance.json`: avg duration, findings/run, hallucination rate, token efficiency.

**Auto-evolution** — `qa-evolve-v2.ts` produces `auto-adjustments.json`. Orchestrator reads before run.

**Webhook notifications** — POST to Slack/Teams when `verdict === 'BLOCKED'`.

### Phase 2J: Credential Store Extensions (future)

- 1Password CLI (`op read`)
- Bitwarden CLI (`bw get password`)
- HashiCorp Vault (enterprise)
- New backends in `credential-store.ts` alongside existing keychain functions
- Config: `credentialBackend: keychain | 1password | bitwarden | vault`

---

## Files to modify (this PR)

| File | Changes |
|---|---|
| `lib/orchestrator/coverage-babysitter.ts` | **New** — track, evaluate, intervene, report |
| `lib/orchestrator/run-state.ts` | **New** — pure data layer (`RunState`, `RunStateSnapshot`) |
| `lib/orchestrator/renderers/tty-renderer.ts` | **New** — ANSI `top`-style display (extracted from observability.ts) |
| `lib/orchestrator/renderers/json-renderer.ts` | **New** — JSON output for CI/web |
| `lib/orchestrator/renderers/log-renderer.ts` | **New** — sequential log lines for non-TTY |
| `lib/orchestrator/coverage-babysitter.test.ts` | **New** — behavior tests per 1.16 |
| `lib/orchestrator/chunker.ts` | `.claude` exclusion, strategy configs, dynamic sizing |
| `lib/orchestrator/types.ts` | `CoverageStrategy` types, `toolCallLog` on result |
| `lib/orchestrator/adapters/api-adapter.ts` | Surface `toolCallLog` in return value |
| `lib/orchestrator/adapters/claude-cli-adapter.ts` | Return empty `toolCallLog` |
| `lib/orchestrator/adapters/gemini-cli-adapter.ts` | Return empty `toolCallLog` |
| `lib/orchestrator/adapters/codex-cli-adapter.ts` | Return empty `toolCallLog` |
| `lib/orchestrator/adapters/openclaw-adapter.ts` | Return empty `toolCallLog` |
| `lib/orchestrator/index.ts` | Babysitter integration, API enforcement, budget fix, retries |
| `lib/orchestrator/token-budget.ts` | `selectCoverageStrategy()`, export constants |
| `lib/orchestrator/observability.ts` | Refactor: thin wrapper over RunState + renderer selection |
| `lib/orchestrator/testability-scanner.ts` | `.claude` exclusion in 7 `find` commands |
| `scripts/qa-review-orchestrated.ts` | `--coverage` arg |
| `scripts/qa-review-remote.sh` | `--coverage` flag |
| `config/models.yaml` | `coverageStrategy: balanced` |

## Verification

### Pre-merge gates

1. `npx tsc --noEmit` — typecheck passes
2. `coverage-babysitter.test.ts` — all behavior tests from 1.16 pass
3. Lint passes (no new warnings)
4. `COVERAGE=off` — babysitter short-circuited, existing behavior preserved

### Manual smoke tests

5. `.claude/` and `generated/` excluded from chunk plans and testability scans
6. `toolCallLog` flows API adapter → result → babysitter (inspect `coverage-report.json`)
7. CLI provider + coverage strategy → degraded mode warning + persisted notice
8. `COVERAGE=sweep` → 3 chunks/agent, `COVERAGE=exhaustive` → retries with `maxRetriesPerChunk: 2`
9. Unchunked agents receive real gap data prioritized by heuristic
10. Low-coverage chunks re-run with focused `buildRetryPrompt`; exhausted retries emit `coverage-gap` finding
11. `coverage-report.json` written to runDir, `meta.json` includes coverage schema
12. Live status shows `Coverage: X% → Y% target`
13. Budget break stops both inner and outer loops
14. Run with `COVERAGE=balanced` on a repo that previously had `.claude` pollution → confirm no `.claude` files in any chunk or report
15. Run full QA forcing different providers (`--provider xai`, `--provider anthropic`, `--provider google`, `--provider openai`) → every agent executes successfully on each backend
16. `--training --coverage sweep` → warning emitted, strategy auto-upgraded to `balanced`
17. Kill `rbac-reviewer` mid-run + `--training` → `training-dependency-missing` finding emitted, `trainingQualityGrade: "degraded"` in meta.json
18. Ctrl+C during run → current agent finishes, remaining skipped, partial results written with `(interrupted)`
19. `q` key during run → same graceful shutdown as Ctrl+C
20. `active-run.json` written during run, deleted on completion
21. `RunStateSnapshot` contains all data needed for display (no ANSI in data layer)

### Post-merge

22. Update `tasks/lessons.md` with any implementation surprises
