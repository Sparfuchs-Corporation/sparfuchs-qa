import { join, relative } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import * as readline from 'node:readline';
import type {
  OrchestrationConfig, ProviderName, AgentDefinition, ChunkPlan, FileChunk,
  TestabilityReport, CoverageStrategyConfig, ModelsYaml,
} from './types.js';
import type { QaFinding } from '../types.js';
import { isApiProvider } from './types.js';
import { loadModelsConfig, enforceDataClassification, resolveProviderKeys, resolveModelForAgent, resolveProviderConstraint } from './config.js';
import { parseAgentsByNames, parsePhase1Agents, parseAllAgents, validateAgentIntegrity } from './agent-parser.js';
import { runAgent, interruptibleSleep } from './agent-runner.js';
import { RunState } from './run-state.js';
import { TtyRenderer } from './renderers/tty-renderer.js';
import { DashboardController } from './dashboard-controller.js';
import { QualityAuditor } from './quality-auditor.js';
import {
  parseFindingTags, parseAgentDataTags, appendFinding, writeAgentOutputEnvelope,
  finalizeFindingsFromJsonl, computeDelta, writeDelta, updateFindingIndex, loadBaseline,
  readAgentFindingsFile, AgentIngestionError,
} from '../../scripts/qa-findings-manager.js';
import { generateDeltaReport } from '../../scripts/qa-delta-report.js';
import {
  generateQaReport, generateRemediationPlan, generateObservabilityGaps, generateQaGaps,
} from '../../scripts/qa-markdown-reports.js';
import { discoverSourceFiles, buildChunkPlan, isChunkedAgent, buildChunkPromptSuffix, formatChunkPlanSummary } from './chunker.js';
import { scanTestability, writeTestabilityReport, printTestabilitySummary } from './testability-scanner.js';
import { runPreflight, type PreflightReport } from './preflight.js';
import { verifyRun } from './run-verifier.js';
import { getAgentScope } from './agent-scopes.js';
import {
  registerAdapter, resolveCliProviders, printCapabilityReport, getAdapter,
} from './adapters/index.js';
import { estimateTokenCost, printBudgetPrompt, checkBudget, updateBudgetUsage, isAgentInBudget, selectCoverageStrategy } from './token-budget.js';
import { loadRulesCache, composeAgentPrompt } from './prompt-composer.js';
import { deduplicateFindings } from './finding-deduplicator.js';
import { CoverageBabysitter, getStrategyConfig, capToolCallLog } from './coverage-babysitter.js';
import type { TokenBudget, CoverageStrategy, ObservabilityLevel } from './types.js';
import { OBS_RANK } from './types.js';
import { ApiAdapter } from './adapters/api-adapter.js';
import { ClaudeCliAdapter } from './adapters/claude-cli-adapter.js';
import { GeminiCliAdapter } from './adapters/gemini-cli-adapter.js';
import { CodexCliAdapter } from './adapters/codex-cli-adapter.js';
import { OpenClawAdapter } from './adapters/openclaw-adapter.js';
import { ProviderRegistry } from './provider-registry.js';
import type { ApiProviderName } from './types.js';

// --- Register all adapters ---

function initAdapters(registry?: ProviderRegistry): void {
  // API adapters — pass registry for secure key proxy routing
  registerAdapter(new ApiAdapter('xai', registry));
  registerAdapter(new ApiAdapter('google', registry));
  registerAdapter(new ApiAdapter('anthropic', registry));
  registerAdapter(new ApiAdapter('openai', registry));

  // CLI adapters
  registerAdapter(new ClaudeCliAdapter());
  registerAdapter(new GeminiCliAdapter());
  registerAdapter(new CodexCliAdapter());
  registerAdapter(new OpenClawAdapter());
}

export async function runOrchestration(config: OrchestrationConfig): Promise<void> {
  // 1. Load and validate config
  const modelsConfig = loadModelsConfig();
  config.modelsConfig = modelsConfig;

  // 1.5. Auto-detect CLI providers
  const cliDetection = resolveCliProviders(modelsConfig);
  if (cliDetection.size > 0) {
    process.stderr.write('\n--- CLI Detection ---\n');
    for (const [name, result] of cliDetection) {
      const status = result.installed
        ? `found at ${result.path}${result.version ? ` (${result.version})` : ''}`
        : 'not found';
      process.stderr.write(`  ${name}: ${status}\n`);
    }
    process.stderr.write('\n');
  }

  // 2. Enforce data classification (now CLI-aware: restricted allows CLIs)
  enforceDataClassification(modelsConfig);
  const { available, disabled } = resolveProviderKeys(modelsConfig);

  // 2.5. Start auth proxy and validate API providers
  // Skip when user explicitly selected a CLI provider — zero API involvement.
  const registry = new ProviderRegistry();
  const providerConstraint = resolveProviderConstraint(config.providerOverride);
  const apiProviders = providerConstraint === 'cli' ? [] : available.filter(p => {
    const cfg = modelsConfig.providers[p];
    return cfg && isApiProvider(cfg);
  });

  if (apiProviders.length > 0) {
    process.stderr.write('\n--- Auth Proxy ---\n');
    try {
      const proxyProviders = await withOrchestratorTimeout(
        registry.startProxy(), 15_000, 'registry.startProxy',
      );
      process.stderr.write(`  Proxy: listening (session-secured, Unix socket)\n`);
      process.stderr.write(`  Keys:  ${proxyProviders.map(p => `${p} (keychain)`).join(', ')}\n`);

      // Pre-flight validation — make a minimal API call per provider
      // Build validation entries for every tier that the available providers serve
      const validationEntries: Array<{ provider: ApiProviderName; model: string; tier: string }> = [];
      const tiers = ['light', 'mid', 'heavy'] as const;
      for (const p of proxyProviders) {
        const ap = p as ApiProviderName;
        for (const tier of tiers) {
          const model = modelsConfig.tiers[tier]?.[ap];
          if (model) {
            validationEntries.push({ provider: ap, model, tier });
          }
        }
      }

      process.stderr.write('\n--- Provider Validation ---\n');
      const results = await withOrchestratorTimeout(
        registry.validateAll(validationEntries), 45_000, 'registry.validateAll',
      );
      for (const r of results) {
        if (r.status === 'ok') {
          process.stderr.write(`  \u2713 ${r.provider}/${r.tier}: ${r.model} responded (${r.latencyMs}ms)\n`);
        } else if (r.status === 'error') {
          process.stderr.write(`  \u2717 ${r.provider}/${r.tier}: ${r.model} \u2014 ${r.error}\n`);
        } else {
          process.stderr.write(`  \u2014 ${r.provider}: skipped (no key)\n`);
        }
      }

      // Disable provider only if ALL tiers fail (not just one)
      for (const p of proxyProviders) {
        const ap = p as ApiProviderName;
        const providerResults = results.filter(r => r.provider === ap);
        const allFailed = providerResults.length > 0 && providerResults.every(r => r.status === 'error');
        if (allFailed) {
          const providerConfig = modelsConfig.providers[ap];
          if (providerConfig) providerConfig.enabled = false;
          process.stderr.write(`  \u26A0 ${ap}: disabled (all tiers failed validation)\n`);
        }
      }
      process.stderr.write('\n');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  Auth proxy failed: ${msg}\n`);
      process.stderr.write(`  API providers will be unavailable — falling back to CLI providers only.\n\n`);
    }
  }

  // 2.6. Initialize adapters with registry
  initAdapters(registry);

  // 3. Consent prompt — only for API providers
  if (apiProviders.length > 0) {
    await showConsentPrompt(apiProviders, config.repoPath);
  }

  // 4. Parse agents and validate integrity
  const agentsDir = join(config.repoPath, '.claude', 'agents');
  const agents = config.selectedAgents?.length
    ? parseAgentsByNames(agentsDir, config.selectedAgents, modelsConfig.agentOverrides)
    : config.mode === 'full'
      ? parseAllAgents(agentsDir, modelsConfig.agentOverrides)
      : parsePhase1Agents(agentsDir, modelsConfig.agentOverrides);
  const hashesPath = join(config.sparfuchsRoot, 'config', 'agent-hashes.json');
  const integrity = validateAgentIntegrity(agents, hashesPath);
  if (!integrity.valid) {
    process.stderr.write('\nWARNING: Agent integrity check failed:\n');
    for (const m of integrity.mismatches) {
      process.stderr.write(`  ${m}\n`);
    }
    process.stderr.write('Run "make qa-hashes-update" to update after reviewing changes.\n\n');
  }

  // 5. Initialize output directories
  mkdirSync(config.sessionLogDir, { recursive: true });
  const runDir = join(config.qaDataRoot, config.projectSlug, 'runs', config.runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(config.qaDataRoot, config.projectSlug, 'findings'), { recursive: true });
  // Per-agent JSON artifact directories — agents write their findings and
  // handoff data to <runDir>/findings/<agent>.json and
  // <runDir>/agent-data/<agent>.output.json
  mkdirSync(join(runDir, 'findings'), { recursive: true });
  mkdirSync(join(runDir, 'agent-data'), { recursive: true });
  const findingsPath = join(runDir, 'findings.jsonl');
  writeFileSync(findingsPath, '');
  const metaPath = join(runDir, 'meta.json');

  // Pre-seed meta.json so the run directory always has a readable stub.
  // Overwritten by the finalizer with status "succeeded" / "partial" / "errored".
  writePreSeedMeta(metaPath, config);

  // Bag of state populated as the run progresses. The finalizer reads whatever
  // is available so partial failures still produce a final report.
  const bag: FinalizerBag = {
    runDir,
    findingsPath,
    metaPath,
    sessionLogDir: config.sessionLogDir,
    config,
    modelsConfig,
    available,
    disabled,
    apiAvail: [],
    cliAvail: [],
  };

  let caughtError: unknown;
  try {

  // 5.5. Testability pre-flight scan
  const testabilityReport = await scanTestability(config.repoPath, config.moduleScope);
  bag.testabilityReport = testabilityReport;
  writeTestabilityReport(testabilityReport, runDir);
  printTestabilitySummary(testabilityReport);

  // 5.6. Load rules cache for prompt composition (only when COMPOSE_RULES is enabled)
  const rulesDir = join(config.sparfuchsRoot, 'rules');
  const rulesCache = config.composeRules ? loadRulesCache(rulesDir) : new Map<string, string>();

  if (config.composeRules) {
    process.stderr.write(`\nPrompt composition: ON (${rulesCache.size} rules loaded)\n`);
  }

  const agentsToSkip = new Set(
    testabilityReport.agentPredictions
      .filter(p => !p.effective)
      .map(p => p.agentName),
  );
  bag.agentsToSkip = agentsToSkip;

  const excludedFileSet = new Set([
    ...testabilityReport.uncheckable.minifiedFiles,
    ...testabilityReport.uncheckable.generatedFiles,
    ...testabilityReport.uncheckable.binaryAssets,
    ...testabilityReport.uncheckable.largeFiles,
  ]);

  // 6. Large codebase chunking + coverage strategy
  const allSourceFiles = discoverSourceFiles(config.repoPath, config.moduleScope, excludedFileSet);
  config.sourceFiles = new Set(allSourceFiles);
  bag.allSourceFiles = allSourceFiles;
  // mode=full implies "audit this repo thoroughly," not "this exact
  // percentage of files." If the operator didn't explicitly pick a
  // coverage strategy, upgrade the default from `balanced` (65%) to
  // `thorough` (85%) so full mode actually audits most of the source.
  // Explicit --coverage or QA_COVERAGE_STRATEGY wins over this default.
  const defaultStrategy: CoverageStrategy = config.mode === 'full' ? 'thorough' : 'balanced';
  const strategy: CoverageStrategy = config.coverageStrategy
    ?? modelsConfig.coverageStrategy
    ?? defaultStrategy;
  bag.strategy = strategy;
  const chunkPlan = buildChunkPlan(allSourceFiles, agents, [...excludedFileSet], strategy);
  bag.chunkPlan = chunkPlan;
  const strategyConfig = getStrategyConfig(strategy);
  bag.strategyConfig = strategyConfig;
  const babysitter = new CoverageBabysitter(allSourceFiles, strategy, strategyConfig, config.repoPath);
  bag.babysitter = babysitter;

  // 6.0. Preflight gate — repo census, plan preview, scale-derived success
  // criteria, prior-run gap detection, and the 3-way gap-healing choice
  // (auto-heal / report / fail+script). Runs interactively unless
  // QA_PREFLIGHT=skip is set. Produces preflight.json for Phase 3's
  // run-verifier to grade the actual run against.
  const preflightReport = await runPreflight({
    config,
    agents,
    allSourceFiles,
    chunkPlan,
    strategy,
    targetCoveragePercent: strategyConfig.targetCoveragePercent,
    runDir,
    testabilityCheckabilityPercent: testabilityReport.uncheckable.checkabilityScore,
    testabilityUncheckableCount: testabilityReport.uncheckable.totalUncheckable,
    agentsToSkip,
  });
  bag.preflightReport = preflightReport;
  if (!preflightReport.proceed) {
    process.stderr.write('\n[preflight] aborted by user — no agents dispatched.\n');
    return;
  }

  // 6.1. Observability-level check for babysitting
  // Find the best observability level across all available providers.
  let babysittingEnabled = true;
  let bestObsLevel: ObservabilityLevel = 'none';
  for (const p of available) {
    const adapter = getAdapter(p);
    const level = adapter.getCapabilities().observabilityLevel;
    if (OBS_RANK[level] > OBS_RANK[bestObsLevel]) {
      bestObsLevel = level;
    }
  }

  if (OBS_RANK[bestObsLevel] < OBS_RANK[strategyConfig.minimumObservability]) {
    process.stderr.write(
      `\nNOTICE: Coverage strategy "${strategy}" recommends ${strategyConfig.minimumObservability} observability,\n` +
      `but best available provider offers ${bestObsLevel}.\n` +
      `Babysitting will run at reduced fidelity (retries and scope hints may be limited).\n\n`,
    );
    // Still enable babysitting — partial data is better than none
  }

  // 6.5. Capability report for the selected provider when overridden,
  // otherwise the first available provider in the fallback order.
  const primaryProvider = (
    config.providerOverride && available.includes(config.providerOverride)
      ? config.providerOverride
      : available[0]
  );
  if (primaryProvider) {
    const primaryAdapter = getAdapter(primaryProvider);
    if (primaryAdapter.type === 'cli') {
      printCapabilityReport(primaryProvider, agents, config);

      // Pre-flight auth check — fail fast with setup instructions when the
      // selected CLI cannot run non-interactively. This replaces the old
      // failure mode where every agent exited 0 after hitting an interactive
      // auth prompt, producing 80 fake "successes" and no findings.
      if (typeof primaryAdapter.checkAuth === 'function') {
        const auth = primaryAdapter.checkAuth();
        if (!auth.authenticated) {
          process.stderr.write(
            `\n=== ${primaryProvider}: authentication required ===\n` +
            `${auth.suggestion ?? 'Adapter reported no credentials; see provider docs.'}\n` +
            `===\n\n`,
          );
          throw new Error(
            `${primaryProvider} is not authenticated for non-interactive use. ` +
            `See instructions above, then re-run.`,
          );
        }
        process.stderr.write(
          `Auth: ${primaryProvider} ready (${auth.method ?? 'unspecified'})\n`,
        );
      }

      // Collect CLI-incompatible agents for skip
      for (const agent of agents) {
        const compat = primaryAdapter.checkCompatibility(agent, config);
        if (compat.status === 'skipped') {
          agentsToSkip.add(agent.name);
        }
      }
    }
  }

  // 7. Token budget prompt
  const estimate = estimateTokenCost(agents, modelsConfig, primaryProvider);
  const budget = await printBudgetPrompt(estimate, agents, modelsConfig);

  // forceAll: clear all skip reasons — run every agent regardless
  if (budget.forceAll) {
    agentsToSkip.clear();
  }

  // Filter agents by budget preset (only when not forcing all)
  if (!budget.forceAll) {
    for (const agent of agents) {
      if (!isAgentInBudget(agent.name, budget)) {
        agentsToSkip.add(agent.name);
      }
    }
  }

  // 7.5. Baseline mode — resolve previous findings
  if (config.baseline) {
    const previousRunDir = findLatestRun(
      join(config.qaDataRoot, config.projectSlug, 'runs'),
      config.runId,
    );
    if (previousRunDir) {
      const prevFindingsPath = join(previousRunDir, 'findings.jsonl');
      if (existsSync(prevFindingsPath)) {
        config.previousFindingsPath = prevFindingsPath;
        process.stderr.write(`Baseline: comparing against ${previousRunDir}\n`);
      }
    }
    if (!config.previousFindingsPath) {
      process.stderr.write('Baseline: no previous run found, running full scan\n');
    }
  }

  // 8. Print run header
  const apiAvail = available.filter(p => isApiProvider(config.modelsConfig.providers[p]));
  const cliAvail = available.filter(p => !isApiProvider(config.modelsConfig.providers[p]));
  bag.apiAvail = apiAvail;
  bag.cliAvail = cliAvail;

  process.stderr.write('\n=== Sparfuchs QA Review (orchestrated engine) ===\n');
  if (apiAvail.length > 0) {
    process.stderr.write(`API providers: ${apiAvail.join(', ')}\n`);
  }
  if (cliAvail.length > 0) {
    process.stderr.write(`CLI providers: ${cliAvail.join(', ')}\n`);
  }
  if (disabled.length > 0) {
    process.stderr.write(`Disabled: ${disabled.join('; ')}\n`);
  }
  process.stderr.write(`Agents: ${agents.length} | Mode: ${config.mode} | Repo: ${config.repoPath}\n`);
  process.stderr.write(`Classification: ${modelsConfig.dataClassification} | Redact secrets: ${modelsConfig.redactSecrets}\n`);
  process.stderr.write(`Compose: ${config.composeRules ? 'ON' : 'OFF'} | Auto-complete: ${config.autoComplete ? 'ON' : 'OFF'} | Baseline: ${config.baseline ? 'ON' : 'OFF'}\n`);
  process.stderr.write(`Coverage: ${strategy} (target: ${strategyConfig.targetCoveragePercent}%) | Files: ${allSourceFiles.length}\n`);
  if (config.moduleScope) {
    process.stderr.write(`Module scope: ${config.moduleScope}\n`);
  }
  if (chunkPlan) {
    process.stderr.write(`\n## Chunking\n${formatChunkPlanSummary(chunkPlan)}\n`);
  }
  if (agentsToSkip.size > 0) {
    process.stderr.write(`Skipping agents: ${[...agentsToSkip].join(', ')}\n`);
  }

  // 8. Build job list and pre-register all agents
  type AgentJob = { agent: AgentDefinition; chunk: FileChunk | null; label: string };
  const jobs: AgentJob[] = [];

  for (const agent of agents) {
    if (agentsToSkip.has(agent.name)) continue; // handled separately below

    const shouldChunk = chunkPlan && isChunkedAgent(agent.name);
    let chunks: Array<FileChunk | null> = shouldChunk ? [...chunkPlan.chunks] : [null];

    if (shouldChunk && strategyConfig.maxChunksPerAgent !== null) {
      chunks = chunks.slice(0, strategyConfig.maxChunksPerAgent);
    }

    for (const chunk of chunks) {
      const label = chunk ? `${agent.name}-chunk-${chunk.id}` : agent.name;
      jobs.push({ agent, chunk, label });
    }
  }

  // 8.5. Gap-healing jobs (preflight option 1 — auto-heal). Runs alongside
  // the main wave with a `-heal` label suffix so findings and session logs
  // don't clobber the primary agent's output. Tier escalation comes from
  // config/models.yaml.agentOverrides (doc-reviewer / sca-reviewer →
  // heavy) so no extra plumbing is needed here.
  if (preflightReport.healJobs.length > 0) {
    for (const healJob of preflightReport.healJobs) {
      const agent = agents.find(a => a.name === healJob.agentName);
      if (!agent) continue;
      jobs.push({ agent, chunk: null, label: `${agent.name}-heal` });
    }
    process.stderr.write(
      `\n[preflight] injected ${preflightReport.healJobs.length} heal job(s): ` +
      `${preflightReport.healJobs.map(j => j.agentName).join(', ')}\n`,
    );
  }

  // Scheduling: primary key is stage (upstream-data dependencies between
  // agents), secondary is unchunked-before-chunked, tertiary is tier.
  // Stage-gated dispatch (below) means a stage-N+1 job never starts until
  // every stage-≤N job has reached a terminal status. This prevents the
  // deadlock where e.g. release-gate-synthesizer (stage 4) claims a
  // concurrency slot while still waiting on test-runner (stage 3) output.
  const TIER_PRIORITY: Record<string, number> = { light: 0, mid: 1, heavy: 2 };
  jobs.sort((a, b) => {
    const stageA = getAgentStage(a.agent.name);
    const stageB = getAgentStage(b.agent.name);
    if (stageA !== stageB) return stageA - stageB;
    const chunkA = a.chunk ? 1 : 0;
    const chunkB = b.chunk ? 1 : 0;
    if (chunkA !== chunkB) return chunkA - chunkB;
    return (TIER_PRIORITY[a.agent.tier] ?? 1) - (TIER_PRIORITY[b.agent.tier] ?? 1);
  });

  // Initialize dashboard (RunState + TtyRenderer + Controller)
  const runState = new RunState();
  bag.runState = runState;
  const ttyRenderer = new TtyRenderer();
  bag.ttyRenderer = ttyRenderer;
  const dashboard = new DashboardController(runState, ttyRenderer);
  bag.dashboard = dashboard;
  runState.setRunId(config.runId);
  runState.setBudget(budget);
  runState.setBabysitter(babysitter);
  runState.setTotalFiles(allSourceFiles.length);

  // Pre-register skipped agents
  for (const agent of agents) {
    if (!agentsToSkip.has(agent.name)) continue;
    const prediction = testabilityReport.agentPredictions.find(p => p.agentName === agent.name);
    const status = runState.registerAgent(agent.name);
    const resolved = resolveModelForAgent(agent.name, agent.tier, modelsConfig, config.providerOverride);
    status.provider = resolved.provider;
    status.model = resolved.model;
    status.status = 'complete';
    status.error = `Skipped: ${prediction?.reason ?? 'predicted ineffective or CLI-incompatible'}`;
    status.completedAt = new Date().toISOString();
  }

  // Pre-register all jobs so dashboard shows total from the start
  for (const job of jobs) {
    const status = runState.registerAgent(job.label);
    const resolved = resolveModelForAgent(job.agent.name, job.agent.tier, modelsConfig, config.providerOverride);
    status.provider = resolved.provider;
    status.model = resolved.model;
    if (job.chunk) {
      status.filesAssigned = job.chunk.files.length;
    }
  }

  dashboard.start();

  const auditor = new QualityAuditor(config, modelsConfig, registry);
  bag.auditor = auditor;

  // Wire proxy telemetry into RunState for live dashboard token tracking
  registry.onTelemetry((event) => {
    const status = runState.getAgent(event.agentId);
    if (status) {
      status.lastHeartbeat = Date.now();
    }
  });
  let budgetExceeded = false;

  // Concurrency limiter — smart defaults based on provider mix
  const apiProviderCount = registry.getAvailableProviders().length;
  const cliProviderCount = available.filter(p => !isApiProvider(modelsConfig.providers[p])).length;
  const isAnthropicOnly = apiProviderCount === 1
    && available.some(p => p === 'anthropic' && isApiProvider(modelsConfig.providers[p]));

  let defaultConcurrency: number;
  if (apiProviderCount === 0 && cliProviderCount > 0) {
    // CLI-only: concurrent dispatch, no rate limits
    defaultConcurrency = Math.max(cliProviderCount, 1);
  } else if (isAnthropicOnly && cliProviderCount === 0) {
    // Single Anthropic API key: sequential to stay within 50K tokens/min
    defaultConcurrency = 1;
  } else if (apiProviderCount <= 1) {
    defaultConcurrency = 3;
  } else {
    // Multi-API or mixed: scale with provider count
    defaultConcurrency = apiProviderCount + cliProviderCount;
  }
  const concurrency = config.concurrency ?? defaultConcurrency;

  // Inter-agent cooldown for rate-limit-sensitive setups
  let cooldownMs = config.interAgentCooldownMs ?? 0;
  if (cooldownMs === 0 && isAnthropicOnly && concurrency <= 2) {
    cooldownMs = 30_000; // 30s auto-cooldown for Anthropic single-key sequential
    process.stderr.write(
      `Sequential mode: 30s inter-agent cooldown enabled for Anthropic rate limits.\n`,
    );
  }
  function createLimiter(max: number) {
    let active = 0;
    const queue: Array<() => void> = [];
    return <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const run = () => {
          active++;
          fn().then(resolve, reject).finally(() => {
            active--;
            if (queue.length) queue.shift()!();
          });
        };
        active < max ? run() : queue.push(run);
      });
  }
  const limit = createLimiter(concurrency);

  // Abort controller — triggered by quit request, interrupts agent retries and sleeps
  const abortController = new AbortController();
  const checkQuit = setInterval(() => {
    if (dashboard.isQuitRequested() && !abortController.signal.aborted) {
      abortController.abort();
    }
  }, 500);

  // Execute jobs stage-by-stage, each stage bounded by the concurrency
  // limiter. Stage-gated dispatch means a stage-N+1 agent never acquires a
  // limiter slot while any stage-≤N agent is still outstanding, preventing
  // the deadlock where late-stage aggregators (qa-gap-analyzer,
  // release-gate-synthesizer) block slots that their upstream agents need.
  const dispatchJob = ({ agent, chunk, label: agentLabel }: AgentJob) => limit(async () => {
    // Check stop conditions before starting
    if (budgetExceeded || dashboard.isQuitRequested()) return;

    // Pause — wait until resumed
    while (dashboard.isPaused() && !dashboard.isQuitRequested()) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (dashboard.isQuitRequested()) return;

    const status = runState.getAgent(agentLabel)!;
    status.status = 'running';
    status.startedAt = new Date().toISOString();

    const shouldChunk = chunk !== null;
    const injectScopeHint = babysittingEnabled
      && !shouldChunk
      && strategyConfig.unchunkedScopeHint
      && allSourceFiles.length > 50;

    try {
      const resolved = resolveModelForAgent(agent.name, agent.tier, modelsConfig, config.providerOverride);

      // Compose agent prompt when COMPOSE_RULES is enabled
      const agentToRun = config.composeRules && rulesCache.size > 0
        ? { ...agent, systemPrompt: composeAgentPrompt(agent.systemPrompt, rulesCache, resolved.model) }
        : agent;

      let delegationPrompt = buildDelegationPrompt(agentToRun, config);

      if (chunk && chunkPlan) {
        delegationPrompt += buildChunkPromptSuffix(chunk, chunkPlan.chunks.length, config.repoPath);
      }
      if (config.moduleScope) {
        delegationPrompt += `\nTarget module: ${config.moduleScope}. Only analyze files under this directory.\n`;
      }
      if (config.claimsManifestPath && REFDOC_AWARE_AGENTS.has(agent.name)) {
        delegationPrompt += buildRefDocPromptSuffix(config.claimsManifestPath);
      }

      // Inject uncovered files as priority targets for unchunked agents.
      // Use path.relative so trailing-slash / canonicalization quirks can't
      // leak absolute paths into the prompt (which then look ridiculous to
      // the agent and add noise to its context).
      if (injectScopeHint) {
        const priorityFiles = babysitter.getUncoveredFilesForHint(50);
        if (priorityFiles.length > 0) {
          const relativePaths = priorityFiles
            .map(f => relative(config.repoPath, f))
            .filter(f => !f.startsWith('..') && f.length > 0);
          if (relativePaths.length > 0) {
            delegationPrompt +=
              `\n\nPRIORITY FILES — The following files have not been examined by other agents yet. ` +
              `Include them in your analysis where relevant to your domain:\n` +
              relativePaths.map(f => `  ${f}`).join('\n') + '\n';
          }
        }
      }

      const result = await runAgent(
        agentToRun, delegationPrompt, config, status,
        () => { /* status updates happen via RunState refresh */ },
        (e) => runState.recordFallback(e),
        abortController.signal,
      );

      const outputPath = join(config.sessionLogDir, `${formatTime()}_${agentLabel}.md`);
      writeFileSync(outputPath, result.text);
      status.outputFilePath = outputPath;
      status.outputFileExists = true;
      status.outputSizeBytes = Buffer.byteLength(result.text);

      // Record coverage via babysitter (single source of truth)
      const { capped: cappedLog, droppedCount } = capToolCallLog(result.toolCallLog);
      if (droppedCount > 0) {
        status.error = `toolCallLog capped: ${droppedCount} entries had args dropped`;
      }
      if (babysittingEnabled) {
        babysitter.recordAgentRun(agentLabel, cappedLog);
      }

      // Category-aware Files column population. The previous "examined /
      // 1297 source files" for every agent misled the operator when
      // build-verifier (a shell-driven agent) looked like it examined 0%
      // of the repo. Now each category renders appropriately.
      if (babysittingEnabled) {
        const examined = babysitter.getFilesExaminedByAgent(agentLabel);
        const scope = agent.scopeCategory ?? getAgentScope(agent.name).category;

        if (chunk) {
          // Chunked agents keep chunk-scoped rendering.
          const chunkEval = babysitter.evaluateChunkCoverage(agentLabel, chunk);
          status.coveragePercent = chunkEval.coveragePercent;
          status.filesAssigned = chunk.files.length;
          status.filesDisplay = {
            kind: 'chunked',
            examined: Math.round((chunkEval.coveragePercent / 100) * chunk.files.length),
            assigned: chunk.files.length,
            percent: chunkEval.coveragePercent,
          };
        } else if (scope === 'pattern') {
          // Pattern agents: denominator = files matching their glob set.
          const agentScope = getAgentScope(agent.name);
          const assigned = countPatternMatches(allSourceFiles, agentScope.patterns ?? []);
          status.filesAssigned = assigned;
          status.coveragePercent = assigned > 0 ? Math.round((examined / assigned) * 100) : 0;
          status.filesDisplay = {
            kind: 'pattern',
            examined,
            assigned,
            percent: status.coveragePercent,
          };
        } else if (scope === 'synthesis') {
          const readCount = babysitter.getFindingsReadByAgent(agentLabel);
          status.filesDisplay = { kind: 'synthesis', readCount };
        } else if (scope === 'probe') {
          const probeCount = babysitter.getProbeCountByAgent(agentLabel);
          const label = getAgentScope(agent.name).probeLabel ?? 'probes';
          status.filesDisplay = { kind: 'probe', probeCount, label };
        } else if (scope === 'command') {
          status.filesDisplay = { kind: 'command', examined };
        } else {
          // hybrid (or anything unclassified)
          status.filesDisplay = { kind: 'hybrid', examined };
        }
      }

      // Prefer the canonical JSON file contract: findings/<agent>.json.
      // Fall back to legacy <!-- finding: {...} --> tags when the agent has
      // not migrated. Malformed JSON throws AgentIngestionError — caught below
      // and recorded against the agent status so it surfaces in the report.
      let findings: QaFinding[];
      const findingsJsonPath = join(runDir, 'findings', `${agent.name}.json`);
      if (existsSync(findingsJsonPath)) {
        findings = readAgentFindingsFile(runDir, agent.name, config.runId);
      } else {
        findings = parseFindingTags(result.text, agent.name, config.runId);
      }
      for (const finding of findings) {
        appendFinding(config.projectSlug, config.runId, finding);
      }

      // Write agent output envelope (inter-agent data exchange summary).
      // Handoff data: prefer agent-data/<agent>.output.json, fall back to tags.
      let agentData: Record<string, unknown>;
      const agentDataJsonPath = join(runDir, 'agent-data', `${agent.name}.output.json`);
      if (existsSync(agentDataJsonPath)) {
        try {
          const raw = readFileSync(agentDataJsonPath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
          }
          agentData = parsed as Record<string, unknown>;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new AgentIngestionError(
            agent.name, config.runId, 'agent-data-json', msg,
          );
        }
      } else {
        agentData = parseAgentDataTags(result.text, agent.name, config.runId);
      }
      writeAgentOutputEnvelope(runDir, agent.name, config.runId, 'complete', agentData, findings);

      status.status = 'complete';
      status.completedAt = new Date().toISOString();
      status.durationMs = Date.now() - new Date(status.startedAt!).getTime();
      status.findingCount = findings.length;
      runState.recordCompletion(status.durationMs);

      // Track budget
      const agentTokens = status.tokenUsage.input + status.tokenUsage.output;
      updateBudgetUsage(budget, agentTokens);
      const budgetCheck = checkBudget(budget, 0);
      if (!budgetCheck.ok) {
        budgetExceeded = true;
      }

      const auditResult = await auditor.check(agentLabel, result, findings, status);
      if (!auditResult.passed) {
        status.error = `Quality: ${auditResult.issues.length} issue(s), score: ${auditResult.score}/100`;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      status.status = 'failed';
      status.error = msg;
      status.completedAt = new Date().toISOString();
      if (status.startedAt) {
        status.durationMs = Date.now() - new Date(status.startedAt).getTime();
      }
      // Stub-write the expected JSON artifacts so finalization can tell
      // "agent timed out" from "agent was never invoked." Without these
      // files, run-verifier's per-agent checks can't distinguish the two,
      // and the agent gets credited with zero-by-omission instead of
      // zero-by-failure. Skip if a prior attempt already wrote findings.
      const isTimeout = /exceeded \d+s hard timeout/.test(msg);
      writeStubAgentArtifacts(runDir, agent.name, {
        status: isTimeout ? 'timeout' : 'error',
        error: msg.slice(0, 500),
        provider: status.provider ?? 'unknown',
      });
      // Surface the real failure reason immediately — don't make the operator
      // wait for meta.json finalization to find out why an agent died. The
      // dashboard only shows "FAILED" without the message.
      process.stderr.write(
        `\n[AGENT FAILED] ${agentLabel} — ${msg.slice(0, 500)}\n`,
      );
    }

    // Inter-agent cooldown — prevents rate limit hammering in sequential mode
    if (cooldownMs > 0 && concurrency <= 2 && !dashboard.isQuitRequested()) {
      status.error = status.error
        ? `${status.error} | cooldown ${cooldownMs / 1000}s`
        : null;
      await interruptibleSleep(cooldownMs, abortController.signal);
    }
  });

  // Partition jobs into two waves:
  //   Wave A — all independent reviewers (stages 0-3). No agent in this wave
  //            reads another agent's output, so they all run concurrently,
  //            bounded only by the concurrency limiter. One stuck agent does
  //            not block any other.
  //   Wave B — synthesis-only agents (stage 4+: qa-gap-analyzer,
  //            release-gate-synthesizer). These genuinely read every prior
  //            agent's findings / session-log output, so they wait for Wave A
  //            to drain before dispatching. This is the deadlock-prevention
  //            guarantee: synthesis agents NEVER claim a limiter slot while
  //            any independent reviewer is still queued or running.
  const SYNTHESIS_STAGE_THRESHOLD = 4;
  const waveA: AgentJob[] = [];
  const waveB: AgentJob[] = [];
  for (const job of jobs) {
    (getAgentStage(job.agent.name) >= SYNTHESIS_STAGE_THRESHOLD ? waveB : waveA).push(job);
  }

  if (waveA.length > 0) {
    process.stderr.write(
      `\n--- Wave A (reviewers): dispatching ${waveA.length} job(s) concurrently ---\n`,
    );
    await Promise.allSettled(waveA.map(dispatchJob));
  }

  if (waveB.length > 0 && !budgetExceeded && !dashboard.isQuitRequested()) {
    process.stderr.write(
      `\n--- Wave B (synthesis): dispatching ${waveB.length} job(s) after reviewers drained ---\n`,
    );
    await Promise.allSettled(waveB.map(dispatchJob));
  }
  clearInterval(checkQuit);

  } catch (err: unknown) {
    caughtError = err;
  } finally {
    await finalizeRun(bag, registry, caughtError);
  }

  if (caughtError) throw caughtError;
}

// --- Helpers ---

function buildDelegationPrompt(agent: AgentDefinition, config: OrchestrationConfig): string {
  const outputPath = join(config.sessionLogDir, `${formatTime()}_${agent.name}.md`);
  const runDir = join(config.qaDataRoot, config.projectSlug, 'runs', config.runId);
  const findingsJsonPath = join(runDir, 'findings', `${agent.name}.json`);
  const agentDataJsonPath = join(runDir, 'agent-data', `${agent.name}.output.json`);
  let prompt =
    `${config.userPrompt}\n\n` +
    `IMPORTANT — Write your complete narrative output (markdown) to:\n` +
    `  ${outputPath}\n` +
    `This file must contain everything: every file you read, every grep you ran,\n` +
    `every finding with evidence, every clean check. This IS the forensic record.\n\n` +
    `IMPORTANT — Emit structured findings as JSON. The orchestrator and downstream\n` +
    `agents consume JSON, not markdown. At the END of your analysis:\n` +
    `  1. Write an array of finding objects to:\n` +
    `       ${findingsJsonPath}\n` +
    `     Each object must include: severity, category, rule, file, title,\n` +
    `     description, fix. Optional: line (number).\n` +
    `     If you found no findings, write an empty array: []\n` +
    `  2. Write any inter-agent handoff data (facts, summaries, references for\n` +
    `     downstream agents) as a JSON object to:\n` +
    `       ${agentDataJsonPath}\n` +
    `     If you have no handoff data, skip this file or write: {}\n` +
    `Malformed JSON in these files will abort the run with a loud error —\n` +
    `prefer an empty array/object over guessed-at shapes.\n\n` +
    `IMPORTANT — Do NOT invoke other AI CLIs or nested agents from Bash.\n` +
    `Never run commands such as codex, claude, gemini, openclaw, aider, or similar.\n` +
    `Perform the analysis yourself using only the tools already available in this session.\n\n` +
    `Target repo: ${config.repoPath}\n` +
    `Run ID: ${config.runId}\n` +
    `Project: ${config.projectSlug}`;

  // Baseline mode: inject previous findings for comparison
  if (config.previousFindingsPath && existsSync(config.previousFindingsPath)) {
    const previousContent = readFileSync(config.previousFindingsPath, 'utf8');
    const truncated = previousContent.split('\n').slice(-200).join('\n');
    prompt +=
      `\n\nBASELINE MODE — Previous findings from the last run are provided below.\n` +
      `Only report NEW or WORSENED findings compared to this baseline.\n` +
      `Do not re-report findings that appear below unless the fix introduced a new issue.\n` +
      `If a previous finding is now fixed, you may note it as "resolved" but do not count it.\n\n` +
      `Previous findings:\n${truncated}\n`;
  }

  return prompt;
}

async function showConsentPrompt(providers: ProviderName[], repoPath: string): Promise<void> {
  const consentDir = join(process.env.HOME ?? '/tmp', '.sparfuchs-qa');
  const consentFile = join(consentDir, 'consent.json');

  if (existsSync(consentFile)) {
    try {
      const consent = JSON.parse(readFileSync(consentFile, 'utf8'));
      if (consent.repos?.includes(repoPath)) return;
    } catch { /* corrupted file — re-prompt */ }
  }

  process.stderr.write('\n*** DATA TRANSMISSION NOTICE ***\n');
  process.stderr.write(`The orchestrated engine will send code from:\n  ${repoPath}\n`);
  process.stderr.write(`To these API providers: ${providers.join(', ')}\n`);
  process.stderr.write('This includes file contents, grep results, and git diffs.\n');
  process.stderr.write('(CLI providers keep all data local — no transmission.)\n\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => {
    rl.question('Continue? (yes/no): ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'yes') {
    throw new Error('User declined data transmission. Use ENGINE=claude for local-only mode, or use a CLI provider.');
  }

  mkdirSync(consentDir, { recursive: true });
  const existing = existsSync(consentFile)
    ? (() => { try { return JSON.parse(readFileSync(consentFile, 'utf8')); } catch { return { repos: [] }; } })()
    : { repos: [] };
  existing.repos.push(repoPath);
  writeFileSync(consentFile, JSON.stringify(existing, null, 2));
}

// Count files from `allSourceFiles` that match any pattern in the given
// list. Patterns are glob-ish: `**` matches any path segment, `*` matches
// within one segment, and a trailing `/**` matches a directory subtree.
// Used by Phase 8 to compute the Files-column denominator for
// pattern-scoped agents (rbac-reviewer, api-spec-reviewer, etc.).
function countPatternMatches(allFiles: readonly string[], patterns: readonly string[]): number {
  if (patterns.length === 0) return 0;
  const regexes = patterns.map(patternToRegex);
  let count = 0;
  for (const f of allFiles) {
    for (const r of regexes) {
      if (r.test(f)) { count++; break; }
    }
  }
  return count;
}

function patternToRegex(pattern: string): RegExp {
  // Escape regex specials except glob markers, then translate glob tokens.
  // The character class MUST include `\\` — without it, a backslash in a
  // glob pattern (e.g. Windows-style `apps\src\*.py`) leaks through and
  // becomes a regex meta-character at compile time (e.g. `\s` → whitespace
  // token). CodeQL js/incomplete-sanitization flagged the missing \\.
  const escaped = pattern
    .replace(/[\\.+^$()|[\]{}]/g, '\\$&')
    .replace(/\*\*/g, '\x00')                    // placeholder
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${escaped}$`);
}

function formatTime(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join('-');
}

// Human-readable local timestamp: 'YYYY-MM-DD HH:MM:SS TZ' (e.g., '2026-04-23 16:17:31 PDT').
// Falls back to an abbreviation-less string if the JS runtime cannot resolve one.
function formatLocalTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  let tzAbbrev = '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d);
    tzAbbrev = parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    tzAbbrev = '';
  }
  return `${y}-${mo}-${da} ${h}:${mi}:${s}${tzAbbrev ? ` ${tzAbbrev}` : ''}`;
}

// Read startedAt from an existing meta.json on disk. Used by the finalizer to
// preserve the true run-start time that the pre-seed writer captured, rather
// than clobbering it with `new Date()` at finalize time.
function readStartedAtFromMeta(metaPath: string): string | null {
  try {
    if (!existsSync(metaPath)) return null;
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.startedAt === 'string') {
      return parsed.startedAt;
    }
  } catch {
    // Corrupt or unreadable pre-seed meta.json — fall through to RunState fallback.
  }
  return null;
}

// --- Agent staging (upstream-data dependencies) ---
//
// Agents are grouped into stages. A stage-N+1 agent may read findings /
// agent-data produced by stage-≤N agents, so dispatch is gated: no stage-N+1
// job starts until every stage-≤N job has reached a terminal status.
//
// Stage definitions mirror the documented stages in scripts/qa-review-remote.sh:
//   0 — Build & Semantic Safety (no upstream deps; run first)
//   1 — Risk & Static Quality    (independent reviewers)
//   2 — Integrity & Prep         (may consult stage-1 outputs)
//   3 — Execution & Live Validation (depends on build/integrity signals)
//   4 — Synthesis & Gate         (reads every prior agent's output)
//
// An agent not listed here defaults to DEFAULT_AGENT_STAGE.
const DEFAULT_AGENT_STAGE = 1;

const AGENT_STAGES: Record<string, number> = {
  // Stage 0
  'build-verifier': 0,
  'semantic-diff-reviewer': 0,
  // Stage 1
  'code-reviewer': 1,
  'security-reviewer': 1,
  'observability-auditor': 1,
  'workflow-extractor': 1,
  'performance-reviewer': 1,
  'risk-analyzer': 1,
  'regression-risk-scorer': 1,
  'deploy-readiness-reviewer': 1,
  'contract-reviewer': 1,
  'rbac-reviewer': 1,
  'access-query-validator': 1,
  'permission-chain-checker': 1,
  'collection-reference-validator': 1,
  'role-visibility-matrix': 1,
  'a11y-reviewer': 1,
  'compliance-reviewer': 1,
  'dead-code-reviewer': 1,
  'spec-verifier': 1,
  'ui-intent-verifier': 1,
  'stub-detector': 1,
  'python-linter': 1,          // project Python static analysis — independent
  'cost-analyzer': 1,          // infra cost surface — independent
  // Stage 2
  'iam-drift-auditor': 2,      // reads IAM from every layer; benefits from other stage-1 outputs
  'schema-migration-reviewer': 2,
  'mock-integrity-checker': 2,
  'environment-parity-checker': 2,
  'iac-reviewer': 2,
  'dependency-auditor': 2,
  'sca-reviewer': 2,
  'api-spec-reviewer': 2,
  'doc-reviewer': 2,
  'crud-tester': 2,
  'e2e-tester': 2,
  'fixture-generator': 2,
  'boundary-fuzzer': 2,
  // Stage 3
  'test-runner': 3,
  'smoke-test-runner': 3,
  'api-contract-prober': 3,
  'failure-analyzer': 3,
  // Stage 4 — synthesis, depends on EVERY prior agent's output
  'qa-gap-analyzer': 4,
  'release-gate-synthesizer': 4,
  // Documentation agents (standalone runs) — treat as stage 1
  'training-system-builder': 1,
  'architecture-doc-builder': 1,
};

function getAgentStage(agentName: string): number {
  // Strip chunk suffix (label form `agent-name-chunk-3`) before lookup.
  const base = agentName.replace(/-chunk-\d+$/, '');
  return AGENT_STAGES[base] ?? DEFAULT_AGENT_STAGE;
}

const REFDOC_AWARE_AGENTS = new Set([
  'ref-doc-verifier',
  'spec-verifier',
  'security-reviewer',
  'contract-reviewer',
  'compliance-reviewer',
  'deploy-readiness-reviewer',
  'rbac-reviewer',
  'workflow-extractor',
]);

function findLatestRun(runsDir: string, currentRunId: string): string | null {
  if (!existsSync(runsDir)) return null;
  try {
    const entries = readdirSync(runsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== currentRunId)
      .map(e => e.name)
      .sort()
      .reverse();
    return entries.length > 0 ? join(runsDir, entries[0]) : null;
  } catch {
    return null;
  }
}

// Agents that produce verbose output — should not run on providers with low output caps (e.g. Llama 16K)
const VERBOSE_AGENTS = new Set([
  'observability-auditor',
  'workflow-extractor',
  'ref-doc-verifier',
  'training-system-builder',
  'architecture-doc-builder',
  'qa-gap-analyzer',
  'release-gate-synthesizer',
]);

/**
 * Wrap a promise in a hard timeout. Used to guarantee the orchestrator can
 * never stall on external I/O — auth proxy startup, provider validation,
 * proxy shutdown, etc. The underlying operation may continue in the
 * background; we simply stop waiting for it. Callers are responsible for
 * handling the rejection (try/catch, runStep wrapper, etc.).
 */
function withOrchestratorTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${Math.round(timeoutMs / 1000)}s hard timeout`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildRefDocPromptSuffix(claimsManifestPath: string): string {
  return (
    `\n\nREFERENCE DOCUMENT VERIFICATION MODE\n` +
    `A claims manifest extracted from reference documents is available at:\n` +
    `  ${claimsManifestPath}\n` +
    `Read this file. Each line is a JSON object with a verifiable claim from the reference docs.\n` +
    `Cross-reference these claims against the codebase as part of your analysis.\n` +
    `For claims in your domain that are contradicted or stale, emit findings with category "ref-doc".\n`
  );
}

// --- Finalization ---

interface FinalizerBag {
  runDir: string;
  findingsPath: string;
  metaPath: string;
  sessionLogDir: string;
  config: OrchestrationConfig;
  modelsConfig: ModelsYaml;
  available: ProviderName[];
  disabled: string[];
  apiAvail: ProviderName[];
  cliAvail: ProviderName[];
  testabilityReport?: TestabilityReport;
  agentsToSkip?: Set<string>;
  chunkPlan?: ChunkPlan | null;
  strategy?: CoverageStrategy;
  strategyConfig?: CoverageStrategyConfig;
  allSourceFiles?: string[];
  babysitter?: CoverageBabysitter;
  runState?: RunState;
  dashboard?: DashboardController;
  ttyRenderer?: TtyRenderer;
  auditor?: QualityAuditor;
  preflightReport?: PreflightReport;
}

// Write stub findings + handoff JSON for an agent that failed (timeout or
// error) before it could emit its own artifacts. The finalizer reads these
// files; without them, the agent shows up as "never invoked" rather than
// "ran and failed," and run-verifier can't credit it in per-agent tables.
function writeStubAgentArtifacts(
  runDir: string,
  agentName: string,
  meta: { status: 'timeout' | 'error'; error: string; provider: string },
): void {
  const findingsDir = join(runDir, 'findings');
  const agentDataDir = join(runDir, 'agent-data');
  try { mkdirSync(findingsDir, { recursive: true }); } catch { /* exists */ }
  try { mkdirSync(agentDataDir, { recursive: true }); } catch { /* exists */ }

  const findingsPath = join(findingsDir, `${agentName}.json`);
  const handoffPath = join(agentDataDir, `${agentName}.output.json`);

  // Don't clobber real output from a prior successful attempt in the same run.
  if (!existsSync(findingsPath)) {
    try {
      writeFileSync(findingsPath, JSON.stringify({
        findings: [],
        _meta: { status: meta.status, error: meta.error, provider: meta.provider, agent: agentName },
      }, null, 2));
    } catch { /* best-effort; finalizer will log if needed */ }
  }
  if (!existsSync(handoffPath)) {
    try {
      writeFileSync(handoffPath, '{}');
    } catch { /* best-effort */ }
  }
}

function writePreSeedMeta(metaPath: string, config: OrchestrationConfig): void {
  try {
    writeFileSync(metaPath, JSON.stringify({
      runId: config.runId,
      projectSlug: config.projectSlug,
      engine: 'orchestrated',
      mode: config.mode,
      repoPath: config.repoPath,
      moduleScope: config.moduleScope ?? null,
      isGitRepo: config.isGitRepo ?? true,
      status: 'in-progress',
      startedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nFinalizer: failed to pre-seed meta.json: ${msg}\n`);
  }
}

/**
 * Run finalization — always runs regardless of whether the main body succeeded.
 * Each step is wrapped in its own try/catch so one failure does not skip the rest.
 * Accumulates finalizationErrors and records a status of 'succeeded' | 'partial' | 'errored'
 * in meta.json.
 *
 * Never throws — callers must check bag.finalizationErrors (or re-throw caughtError after).
 */
async function finalizeRun(
  bag: FinalizerBag,
  registry: ProviderRegistry,
  caughtError: unknown,
): Promise<void> {
  const { runDir, findingsPath, metaPath, sessionLogDir, config, modelsConfig } = bag;
  const finalizationErrors: Array<{ step: string; error: string }> = [];

  const runStep = async (step: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\nFinalizer: step "${step}" failed: ${msg}\n`);
      finalizationErrors.push({ step, error: msg });
    }
  };

  // 1. Dashboard teardown (idempotent in controller; safe to always call)
  await runStep('dashboard.teardown', () => {
    bag.dashboard?.teardown();
  });

  // 2. Auth proxy shutdown — hard timeout so a stuck subprocess kill never
  // blocks finalization. If it times out, the orchestrator process exiting
  // will let the OS reap the proxy anyway.
  await runStep('registry.shutdown', async () => {
    await withOrchestratorTimeout(registry.shutdown(), 10_000, 'registry.shutdown');
  });

  // 3. Dedup findings.jsonl
  await runStep('deduplicateFindings', () => {
    const dedupResult = deduplicateFindings(findingsPath, runDir);
    if (dedupResult.removed > 0) {
      process.stderr.write(
        `\nDedup: ${dedupResult.original} -> ${dedupResult.deduplicated} findings ` +
        `(${dedupResult.removed} cross-agent duplicates merged)\n`,
      );
    }
  });

  // 4. findings-final.json — deduplicated, severity-resolved array
  let finalFindings: ReturnType<typeof finalizeFindingsFromJsonl> = [];
  await runStep('finalizeFindingsFromJsonl', () => {
    finalFindings = finalizeFindingsFromJsonl(config.projectSlug, config.runId);
  });

  // 5. delta.json — new vs recurring vs remediated against previous run
  let delta: ReturnType<typeof computeDelta> | null = null;
  await runStep('computeDelta+writeDelta', () => {
    const previousRunsDir = join(config.qaDataRoot, config.projectSlug, 'runs');
    const previousRunDir = findLatestRun(previousRunsDir, config.runId);
    const previousRunId = previousRunDir ? previousRunDir.split('/').pop() : undefined;
    // Previous findings come from the baseline file (if it exists) — that is the
    // canonical "last successful set" maintained by evolve/delta flows.
    const previousFindings = loadBaseline(config.projectSlug);
    delta = computeDelta(finalFindings, previousFindings, config.runId, previousRunId);
    writeDelta(config.projectSlug, config.runId, delta);
  });

  // 6. Update project-level lifecycle index
  await runStep('updateFindingIndex', () => {
    if (delta) {
      updateFindingIndex(config.projectSlug, config.runId, finalFindings, delta);
    }
  });

  // 7. Coverage report
  await runStep('babysitter.writeReport', () => {
    if (bag.babysitter) {
      bag.babysitter.printReport();
      bag.babysitter.writeReport(runDir);
    }
  });

  // 8. Quality audit results
  await runStep('auditor.writeResults', () => {
    if (bag.auditor) {
      const auditPath = join(runDir, 'quality-audit.json');
      bag.auditor.writeResults(auditPath);
    }
  });

  // 9. meta.json — final status + full metadata
  const status = caughtError
    ? 'errored'
    : finalizationErrors.length > 0
      ? 'partial'
      : 'succeeded';

  await runStep('writeMeta', () => {
    const errorMessage = caughtError
      ? (caughtError instanceof Error ? caughtError.message : String(caughtError))
      : undefined;

    // Preserve the true run-start time. The pre-seed meta.json written at
    // run start holds the authoritative startedAt; carry it forward so
    // duration-based analysis has real numbers instead of (completedAt === now).
    const completedAtDate = new Date();
    const startedAtIso = readStartedAtFromMeta(metaPath)
      ?? (bag.runState ? new Date(bag.runState.getRunStartTime()).toISOString() : completedAtDate.toISOString());
    const startedAtDate = new Date(startedAtIso);

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    writeFileSync(metaPath, JSON.stringify({
      runId: config.runId,
      projectSlug: config.projectSlug,
      engine: 'orchestrated',
      mode: config.mode,
      repoPath: config.repoPath,
      moduleScope: config.moduleScope ?? null,
      isGitRepo: config.isGitRepo ?? true,
      status,
      error: errorMessage,
      finalizationErrors: finalizationErrors.length > 0 ? finalizationErrors : undefined,
      startedAt: startedAtIso,
      completedAt: completedAtDate.toISOString(),
      startedAtLocal: formatLocalTimestamp(startedAtDate),
      completedAtLocal: formatLocalTimestamp(completedAtDate),
      tz,
      dataClassification: modelsConfig.dataClassification,
      providers: { api: bag.apiAvail, cli: bag.cliAvail, disabled: bag.disabled },
      testability: bag.testabilityReport ? {
        checkabilityScore: bag.testabilityReport.uncheckable.checkabilityScore,
        totalSourceFiles: bag.testabilityReport.repoProfile.totalSourceFiles,
        skippedAgents: bag.agentsToSkip ? [...bag.agentsToSkip] : [],
        recommendations: bag.testabilityReport.recommendations.filter(r => r.priority === 'critical' || r.priority === 'high'),
      } : null,
      chunking: bag.chunkPlan ? {
        totalFiles: bag.chunkPlan.totalFiles,
        checkableFiles: bag.chunkPlan.checkableFiles,
        chunks: bag.chunkPlan.chunks.length,
        excludedFiles: bag.chunkPlan.excludedFiles.length,
      } : null,
      coverage: bag.strategy && bag.strategyConfig && bag.babysitter && bag.allSourceFiles ? {
        strategy: bag.strategy,
        targetPercent: bag.strategyConfig.targetCoveragePercent,
        actualPercent: bag.babysitter.getCoveragePercent(),
        filesExamined: bag.babysitter.getFilesExamined().size,
        filesTotal: bag.allSourceFiles.length,
        retriesExecuted: bag.babysitter.getRetriesExecuted(),
      } : null,
      agents: bag.runState?.getAgents() ?? [],
      fallbackEvents: bag.runState?.getFallbackEvents() ?? [],
      qualityAudit: bag.auditor?.getResults() ?? [],
    }, null, 2));
  });

  // 9.5. Run quality verification — grade actual run artifacts against the
  //      preflight's scale-adaptive expectations. Produces run-quality.json.
  //      Phase 3 partial-run labeling in qa-report.md and qa-gaps.md reads
  //      this file. Does not override the release-gate verdict.
  await runStep('verifyRun', () => {
    verifyRun({
      runDir,
      projectSlug: config.projectSlug,
      runId: config.runId,
    });
  });

  // 10. Human-facing markdown reports — documented exception to the JSON-only
  //     rule. Each is deterministic from JSON artifacts; agent-authored narratives
  //     are folded in where available.
  await runStep('generateDeltaReport', () => {
    generateDeltaReport({
      projectSlug: config.projectSlug,
      runId: config.runId,
      outPath: join(runDir, 'delta-report.md'),
      qaDataRoot: config.qaDataRoot,
    });
  });

  await runStep('generateQaReport', () => {
    generateQaReport({
      runDir,
      sessionLogDir,
      projectSlug: config.projectSlug,
      runId: config.runId,
      outPath: join(runDir, 'qa-report.md'),
    });
  });

  await runStep('generateRemediationPlan', () => {
    generateRemediationPlan({
      runDir,
      projectSlug: config.projectSlug,
      runId: config.runId,
      outPath: join(runDir, 'remediation-plan.md'),
    });
  });

  await runStep('generateObservabilityGaps', () => {
    generateObservabilityGaps({
      runDir,
      sessionLogDir,
      projectSlug: config.projectSlug,
      runId: config.runId,
      outPath: join(runDir, 'observability-gaps.md'),
    });
  });

  await runStep('generateQaGaps', () => {
    const failedAgents = (bag.runState?.getAgents() ?? [])
      .filter(a => a.status === 'failed')
      .map(a => ({ name: a.agentName, error: a.error }));
    const skippedAgents = (bag.runState?.getAgents() ?? [])
      .filter(a => a.status === 'complete' && a.error?.startsWith('Skipped'))
      .map(a => ({ name: a.agentName, reason: a.error }));
    generateQaGaps({
      runDir,
      sessionLogDir,
      projectSlug: config.projectSlug,
      runId: config.runId,
      outPath: join(runDir, 'qa-gaps.md'),
      failedAgents,
      skippedAgents,
    });
  });

  // 11. Print final summary (best-effort; never blocks finalization)
  await runStep('summary', () => {
    if (bag.ttyRenderer && bag.runState) {
      bag.ttyRenderer.clear();
      const snap = bag.runState.snapshot();
      const completeCount = snap.agents.complete;
      const failedCount = snap.agents.failed;
      process.stderr.write(`
=== Orchestrated Run Summary ===
Status: ${status}${caughtError ? ` — ${caughtError instanceof Error ? caughtError.message : String(caughtError)}` : ''}
Agents: ${completeCount}/${snap.agents.total} complete${failedCount > 0 ? `, ${failedCount} failed` : ''}
Findings: ${snap.findings.total}
Tokens: ${snap.tokens.input > 0 ? `${Math.round(snap.tokens.input / 1000)}k in / ${Math.round(snap.tokens.output / 1000)}k out` : 'N/A (CLI providers)'}
Coverage: ${snap.coverage ? `${snap.coverage.actualPercent}% (${snap.coverage.filesExamined}/${snap.coverage.filesTotal} files)` : 'N/A'}
Duration: ${Math.round(snap.elapsedMs / 1000)}s
================================
`);
    }
  });
}
