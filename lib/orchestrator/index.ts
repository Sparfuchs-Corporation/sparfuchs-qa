import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as readline from 'node:readline';
import type { OrchestrationConfig, ProviderName, AgentDefinition, ChunkPlan, FileChunk } from './types.js';
import { isApiProvider } from './types.js';
import { loadModelsConfig, enforceDataClassification, resolveProviderKeys, resolveModelForAgent } from './config.js';
import { parsePhase1Agents, validateAgentIntegrity } from './agent-parser.js';
import { runAgent } from './agent-runner.js';
import { ObservabilityTracker } from './observability.js';
import { QualityAuditor } from './quality-auditor.js';
import { parseFindingTags, appendFinding } from '../../scripts/qa-findings-manager.js';
import { discoverSourceFiles, buildChunkPlan, isChunkedAgent, buildChunkPromptSuffix, formatChunkPlanSummary } from './chunker.js';
import { scanTestability, writeTestabilityReport, printTestabilitySummary } from './testability-scanner.js';
import {
  registerAdapter, resolveCliProviders, printCapabilityReport, getAdapter,
} from './adapters/index.js';
import { estimateTokenCost, printBudgetPrompt, checkBudget, updateBudgetUsage, isAgentInBudget } from './token-budget.js';
import type { TokenBudget } from './types.js';
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
  const agents = parsePhase1Agents(agentsDir, modelsConfig.agentOverrides);
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

  // 6. Large codebase chunking
  const allSourceFiles = discoverSourceFiles(config.repoPath, config.moduleScope, excludedFileSet);
  const chunkPlan = buildChunkPlan(allSourceFiles, agents, [...excludedFileSet]);

  // 6.5. Capability report for the primary provider
  const primaryProvider = available[0];
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

  // Filter agents by budget preset
  const budgetAgentSet = new Set(budget.agentSet);
  for (const agent of agents) {
    if (!isAgentInBudget(agent.name, budget)) {
      agentsToSkip.add(agent.name);
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
  const auditor = new QualityAuditor(config, modelsConfig);

  for (const agent of agents) {
    if (agentsToSkip.has(agent.name)) {
      const prediction = testabilityReport.agentPredictions.find(p => p.agentName === agent.name);
      const status = observer.registerAgent(agent.name);
      status.status = 'complete';
      status.error = `Skipped: ${prediction?.reason ?? 'predicted ineffective or CLI-incompatible'}`;
      status.completedAt = new Date().toISOString();
      process.stderr.write(`\n--- Skipping ${agent.name}: ${status.error} ---\n`);
      continue;
    }

    const shouldChunk = chunkPlan && isChunkedAgent(agent.name);
    const chunks = shouldChunk ? chunkPlan.chunks : [null];

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
        let delegationPrompt = buildDelegationPrompt(agent, config);

        if (chunk && chunkPlan) {
          delegationPrompt += buildChunkPromptSuffix(chunk, chunkPlan.chunks.length, config.repoPath);
        }
        if (config.moduleScope) {
          delegationPrompt += `\nTarget module: ${config.moduleScope}. Only analyze files under this directory.\n`;
        }
        if (config.claimsManifestPath && REFDOC_AWARE_AGENTS.has(agent.name)) {
          delegationPrompt += buildRefDocPromptSuffix(config.claimsManifestPath);
        }

        const result = await runAgent(
          agent, delegationPrompt, config, status,
          (s) => observer.updateAgent(agentLabel, s),
          (e) => observer.recordFallback(e),
        );

        const outputPath = join(config.sessionLogDir, `${formatTime()}_${agentLabel}.md`);
        writeFileSync(outputPath, result.text);
        status.outputFilePath = outputPath;
        status.outputFileExists = true;
        status.outputSizeBytes = Buffer.byteLength(result.text);

        if (chunk) {
          const filesInOutput = new Set<string>();
          for (const file of chunk.files) {
            if (result.text.includes(file) || result.text.includes(file.split('/').pop()!)) {
              filesInOutput.add(file);
            }
          }
          status.coveragePercent = Math.round((filesInOutput.size / chunk.files.length) * 100);
        }

        const findings = parseFindingTags(result.text, agent.name);
        for (const finding of findings) {
          appendFinding(config.projectSlug, config.runId, finding);
        }

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
  return (
    `${config.userPrompt}\n\n` +
    `IMPORTANT — Write your complete output to a file.\n` +
    `At the END of your analysis, use the Write tool to write your ENTIRE response to:\n` +
    `  ${outputPath}\n` +
    `This file must contain everything: every file you read, every grep you ran,\n` +
    `every finding with evidence, every clean check. This IS the forensic record.\n\n` +
    `Target repo: ${config.repoPath}\n` +
    `Run ID: ${config.runId}\n` +
    `Project: ${config.projectSlug}`
  );
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
