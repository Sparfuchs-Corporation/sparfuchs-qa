import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import * as readline from 'node:readline';
import type { OrchestrationConfig, ProviderName, AgentDefinition, ChunkPlan, FileChunk } from './types.js';
import { isApiProvider } from './types.js';
import { loadModelsConfig, enforceDataClassification, resolveProviderKeys, resolveModelForAgent, resolveProviderConstraint } from './config.js';
import { parseAgentsByNames, parsePhase1Agents, parseAllAgents, validateAgentIntegrity } from './agent-parser.js';
import { runAgent, interruptibleSleep } from './agent-runner.js';
import { RunState } from './run-state.js';
import { TtyRenderer } from './renderers/tty-renderer.js';
import { DashboardController } from './dashboard-controller.js';
import { QualityAuditor } from './quality-auditor.js';
import { parseFindingTags, parseAgentDataTags, appendFinding, writeAgentOutputEnvelope } from '../../scripts/qa-findings-manager.js';
import { discoverSourceFiles, buildChunkPlan, isChunkedAgent, buildChunkPromptSuffix, formatChunkPlanSummary } from './chunker.js';
import { scanTestability, writeTestabilityReport, printTestabilitySummary } from './testability-scanner.js';
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
      const proxyProviders = await registry.startProxy();
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
      const results = await registry.validateAll(validationEntries);
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
  const findingsPath = join(runDir, 'findings.jsonl');
  writeFileSync(findingsPath, '');

  // 5.5. Testability pre-flight scan
  const testabilityReport = await scanTestability(config.repoPath, config.moduleScope);
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

  const excludedFileSet = new Set([
    ...testabilityReport.uncheckable.minifiedFiles,
    ...testabilityReport.uncheckable.generatedFiles,
    ...testabilityReport.uncheckable.binaryAssets,
    ...testabilityReport.uncheckable.largeFiles,
  ]);

  // 6. Large codebase chunking + coverage strategy
  const allSourceFiles = discoverSourceFiles(config.repoPath, config.moduleScope, excludedFileSet);
  config.sourceFiles = new Set(allSourceFiles);
  const strategy: CoverageStrategy = config.coverageStrategy
    ?? modelsConfig.coverageStrategy
    ?? 'balanced';
  const chunkPlan = buildChunkPlan(allSourceFiles, agents, [...excludedFileSet], strategy);
  const strategyConfig = getStrategyConfig(strategy);
  const babysitter = new CoverageBabysitter(allSourceFiles, strategy, strategyConfig);

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

  // Smart scheduling: light unchunked first, then mid, then heavy/chunked
  const TIER_PRIORITY: Record<string, number> = { light: 0, mid: 1, heavy: 2 };
  jobs.sort((a, b) => {
    const chunkA = a.chunk ? 1 : 0;
    const chunkB = b.chunk ? 1 : 0;
    if (chunkA !== chunkB) return chunkA - chunkB;
    return (TIER_PRIORITY[a.agent.tier] ?? 1) - (TIER_PRIORITY[b.agent.tier] ?? 1);
  });

  // Initialize dashboard (RunState + TtyRenderer + Controller)
  const runState = new RunState();
  const ttyRenderer = new TtyRenderer();
  const dashboard = new DashboardController(runState, ttyRenderer);
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

  // Execute jobs with concurrency
  const tasks = jobs.map(({ agent, chunk, label: agentLabel }) => limit(async () => {
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

      // Inject uncovered files as priority targets for unchunked agents
      if (injectScopeHint) {
        const priorityFiles = babysitter.getUncoveredFilesForHint(50);
        if (priorityFiles.length > 0) {
          const relative = priorityFiles.map(f => f.replace(config.repoPath + '/', ''));
          delegationPrompt +=
            `\n\nPRIORITY FILES — The following files have not been examined by other agents yet. ` +
            `Include them in your analysis where relevant to your domain:\n` +
            relative.map(f => `  ${f}`).join('\n') + '\n';
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

      if (chunk) {
        const chunkEval = babysitter.evaluateChunkCoverage(agentLabel, chunk);
        status.coveragePercent = chunkEval.coveragePercent;
      }

      const findings = parseFindingTags(result.text, agent.name);
      for (const finding of findings) {
        appendFinding(config.projectSlug, config.runId, finding);
      }

      // Write agent output envelope (inter-agent data exchange)
      const agentData = parseAgentDataTags(result.text);
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
    }

    // Inter-agent cooldown — prevents rate limit hammering in sequential mode
    if (cooldownMs > 0 && concurrency <= 2 && !dashboard.isQuitRequested()) {
      status.error = status.error
        ? `${status.error} | cooldown ${cooldownMs / 1000}s`
        : null;
      await interruptibleSleep(cooldownMs, abortController.signal);
    }
  }));

  await Promise.allSettled(tasks);
  clearInterval(checkQuit);
  dashboard.teardown();

  // 8.5. Shut down auth proxy
  await registry.shutdown();

  // 8.6. Post-run finding deduplication
  const dedupResult = deduplicateFindings(findingsPath, runDir);
  if (dedupResult.removed > 0) {
    process.stderr.write(
      `\nDedup: ${dedupResult.original} -> ${dedupResult.deduplicated} findings ` +
      `(${dedupResult.removed} cross-agent duplicates merged)\n`,
    );
  }

  // 8.6. Coverage report
  babysitter.printReport();
  babysitter.writeReport(runDir);

  // 9. Write quality audit results
  const auditPath = join(runDir, 'quality-audit.json');
  auditor.writeResults(auditPath);

  // 10. Write run meta
  const metaPath = join(runDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify({
    runId: config.runId,
    projectSlug: config.projectSlug,
    engine: 'orchestrated',
    mode: config.mode,
    repoPath: config.repoPath,
    moduleScope: config.moduleScope ?? null,
    startedAt: new Date().toISOString(),
    dataClassification: modelsConfig.dataClassification,
    providers: { api: apiAvail, cli: cliAvail, disabled },
    testability: {
      checkabilityScore: testabilityReport.uncheckable.checkabilityScore,
      totalSourceFiles: testabilityReport.repoProfile.totalSourceFiles,
      skippedAgents: [...agentsToSkip],
      recommendations: testabilityReport.recommendations.filter(r => r.priority === 'critical' || r.priority === 'high'),
    },
    chunking: chunkPlan ? {
      totalFiles: chunkPlan.totalFiles,
      checkableFiles: chunkPlan.checkableFiles,
      chunks: chunkPlan.chunks.length,
      excludedFiles: chunkPlan.excludedFiles.length,
    } : null,
    coverage: {
      strategy,
      targetPercent: strategyConfig.targetCoveragePercent,
      actualPercent: babysitter.getCoveragePercent(),
      filesExamined: babysitter.getFilesExamined().size,
      filesTotal: allSourceFiles.length,
      retriesExecuted: babysitter.getRetriesExecuted(),
    },
    agents: runState.getAgents(),
    fallbackEvents: runState.getFallbackEvents(),
    qualityAudit: auditor.getResults(),
  }, null, 2));

  // 11. Print final summary
  ttyRenderer.clear();
  const snap = runState.snapshot();
  const completeCount = snap.agents.complete;
  const failedCount = snap.agents.failed;
  const totalTokens = snap.tokens.total;
  process.stderr.write(`
=== Orchestrated Run Summary ===
Agents: ${completeCount}/${snap.agents.total} complete${failedCount > 0 ? `, ${failedCount} failed` : ''}
Findings: ${snap.findings.total}
Tokens: ${snap.tokens.input > 0 ? `${Math.round(snap.tokens.input / 1000)}k in / ${Math.round(snap.tokens.output / 1000)}k out` : 'N/A (CLI providers)'}
Coverage: ${snap.coverage ? `${snap.coverage.actualPercent}% (${snap.coverage.filesExamined}/${snap.coverage.filesTotal} files)` : 'N/A'}
Duration: ${Math.round(snap.elapsedMs / 1000)}s
================================
`);
}

// --- Helpers ---

function buildDelegationPrompt(agent: AgentDefinition, config: OrchestrationConfig): string {
  const outputPath = join(config.sessionLogDir, `${formatTime()}_${agent.name}.md`);
  let prompt =
    `${config.userPrompt}\n\n` +
    `IMPORTANT — Write your complete output to a file.\n` +
    `At the END of your analysis, use the Write tool to write your ENTIRE response to:\n` +
    `  ${outputPath}\n` +
    `This file must contain everything: every file you read, every grep you ran,\n` +
    `every finding with evidence, every clean check. This IS the forensic record.\n\n` +
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

function formatTime(): string {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join('-');
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
