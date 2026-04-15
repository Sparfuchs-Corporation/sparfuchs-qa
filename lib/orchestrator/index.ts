import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import * as readline from 'node:readline';
import type { OrchestrationConfig, ProviderName, AgentDefinition, ChunkPlan, FileChunk } from './types.js';
import { isApiProvider } from './types.js';
import { loadModelsConfig, enforceDataClassification, resolveProviderKeys, resolveModelForAgent } from './config.js';
import { parseAgentsByNames, parsePhase1Agents, parseAllAgents, validateAgentIntegrity } from './agent-parser.js';
import { runAgent } from './agent-runner.js';
import { ObservabilityTracker } from './observability.js';
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
import type { TokenBudget, CoverageStrategy } from './types.js';
import { ApiAdapter } from './adapters/api-adapter.js';
import { ClaudeCliAdapter } from './adapters/claude-cli-adapter.js';
import { GeminiCliAdapter } from './adapters/gemini-cli-adapter.js';
import { CodexCliAdapter } from './adapters/codex-cli-adapter.js';
import { OpenClawAdapter } from './adapters/openclaw-adapter.js';

// --- Register all adapters ---

function initAdapters(): void {
  // API adapters
  registerAdapter(new ApiAdapter('xai'));
  registerAdapter(new ApiAdapter('google'));
  registerAdapter(new ApiAdapter('anthropic'));
  registerAdapter(new ApiAdapter('openai'));

  // CLI adapters
  registerAdapter(new ClaudeCliAdapter());
  registerAdapter(new GeminiCliAdapter());
  registerAdapter(new CodexCliAdapter());
  registerAdapter(new OpenClawAdapter());
}

export async function runOrchestration(config: OrchestrationConfig): Promise<void> {
  // 0. Initialize adapters
  initAdapters();

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

  // 3. Consent prompt — only for API providers
  const apiProviders = available.filter(p => {
    const cfg = modelsConfig.providers[p];
    return cfg && isApiProvider(cfg);
  });
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
  const strategy: CoverageStrategy = config.coverageStrategy
    ?? modelsConfig.coverageStrategy
    ?? 'balanced';
  const chunkPlan = buildChunkPlan(allSourceFiles, agents, [...excludedFileSet], strategy);
  const strategyConfig = getStrategyConfig(strategy);
  const babysitter = new CoverageBabysitter(allSourceFiles, strategy, strategyConfig);

  // 6.1. API-only enforcement for babysitting
  let babysittingEnabled = true;
  if (strategyConfig.requireApiProvider) {
    const hasApiProvider = available.some(p => {
      const cfg = modelsConfig.providers[p];
      return cfg && isApiProvider(cfg);
    });
    if (!hasApiProvider) {
      process.stderr.write(
        '\nWARNING: Coverage babysitting requires API providers for tool call observability.\n' +
        'No API provider available — running in degraded mode (no retry, no scope hints).\n' +
        `Consider using --coverage sweep for CLI-only setups.\n\n`,
      );
      babysittingEnabled = false;

      // One-time persisted notice
      const noticeDir = join(process.env.HOME ?? '/tmp', '.sparfuchs-qa');
      const noticePath = join(noticeDir, 'coverage-notice.json');
      if (!existsSync(noticePath)) {
        mkdirSync(noticeDir, { recursive: true });
        writeFileSync(noticePath, JSON.stringify({
          notice: 'CLI-only setup detected. Coverage babysitting requires API providers.',
          recommendation: 'Use --coverage sweep for CLI-only environments.',
          timestamp: new Date().toISOString(),
        }, null, 2));
      }
    }
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

  // 8. Run agents (with chunking support)
  const observer = new ObservabilityTracker();
  observer.setBudget(budget);
  observer.setupKeyboardInput();
  const auditor = new QualityAuditor(config, modelsConfig);
  let budgetExceeded = false;

  for (const agent of agents) {
    if (budgetExceeded) break;

    // Graceful quit — finish loop, write partial results
    if (observer.isQuitRequested()) {
      process.stderr.write('\nGraceful shutdown requested — skipping remaining agents.\n');
      break;
    }

    // Pause — wait until resumed
    while (observer.isPaused() && !observer.isQuitRequested()) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (observer.isQuitRequested()) {
      process.stderr.write('\nGraceful shutdown requested — skipping remaining agents.\n');
      break;
    }
    if (agentsToSkip.has(agent.name)) {
      const prediction = testabilityReport.agentPredictions.find(p => p.agentName === agent.name);
      const status = observer.registerAgent(agent.name);
      const resolved = resolveModelForAgent(
        agent.name, agent.tier, modelsConfig, config.providerOverride,
      );
      status.provider = resolved.provider;
      status.model = resolved.model;
      status.status = 'complete';
      status.error = `Skipped: ${prediction?.reason ?? 'predicted ineffective or CLI-incompatible'}`;
      status.completedAt = new Date().toISOString();
      process.stderr.write(`\n--- Skipping ${agent.name}: ${status.error} ---\n`);
      continue;
    }

    const shouldChunk = chunkPlan && isChunkedAgent(agent.name);
    let chunks: Array<FileChunk | null> = shouldChunk ? [...chunkPlan.chunks] : [null];

    // Apply maxChunksPerAgent for sweep mode
    if (shouldChunk && strategyConfig.maxChunksPerAgent !== null) {
      chunks = chunks.slice(0, strategyConfig.maxChunksPerAgent);
    }

    // Unchunked scope hints — inject priority files from babysitter gap data
    const injectScopeHint = babysittingEnabled
      && !shouldChunk
      && strategyConfig.unchunkedScopeHint
      && allSourceFiles.length > 50;

    for (const chunk of chunks) {
      const agentLabel = chunk
        ? `${agent.name}-chunk-${chunk.id}`
        : agent.name;

      const status = observer.registerAgent(agentLabel);

      const resolved = resolveModelForAgent(
        agent.name, agent.tier, modelsConfig, config.providerOverride,
      );
      status.provider = resolved.provider;
      status.model = resolved.model;

      observer.startAgent(agentLabel);

      try {
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
          (s) => observer.updateAgent(agentLabel, s),
          (e) => observer.recordFallback(e),
        );

        const outputPath = join(config.sessionLogDir, `${formatTime()}_${agentLabel}.md`);
        writeFileSync(outputPath, result.text);
        status.outputFilePath = outputPath;
        status.outputFileExists = true;
        status.outputSizeBytes = Buffer.byteLength(result.text);

        // Record coverage via babysitter (single source of truth)
        const { capped: cappedLog, droppedCount } = capToolCallLog(result.toolCallLog);
        if (droppedCount > 0) {
          process.stderr.write(`  toolCallLog capped: ${droppedCount} entries had args dropped\n`);
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

        observer.completeAgent(agentLabel, findings.length, status.outputSizeBytes);

        // Track budget
        const agentTokens = status.tokenUsage.input + status.tokenUsage.output;
        updateBudgetUsage(budget, agentTokens);
        const budgetCheck = checkBudget(budget, 0);
        if (budgetCheck.warning) {
          process.stderr.write(`  BUDGET: ${budgetCheck.warning}\n`);
        }
        if (!budgetCheck.ok) {
          process.stderr.write('  Token budget exceeded — stopping remaining agents.\n');
          budgetExceeded = true;
          break;
        }

        const auditResult = await auditor.check(agentLabel, result, findings, status);
        if (!auditResult.passed) {
          process.stderr.write(
            `  QUALITY WARNING: ${auditResult.issues.length} issue(s), score: ${auditResult.score}/100\n`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        observer.failAgent(agentLabel, msg);
      }
    }
  }

  // 8.5. Post-run finding deduplication
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
    agents: observer.toStatusArray(),
    fallbackEvents: observer.getFallbackEvents(),
    qualityAudit: auditor.getResults(),
  }, null, 2));

  // 11. Print final summary
  observer.printFinalSummary();
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
