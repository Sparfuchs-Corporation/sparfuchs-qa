import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import * as readline from 'node:readline';
import type { OrchestrationConfig, ProviderName, AgentDefinition } from './types.js';
import { loadModelsConfig, enforceDataClassification, resolveProviderKeys, resolveModelForAgent } from './config.js';
import { parsePhase1Agents, validateAgentIntegrity } from './agent-parser.js';
import { runAgent } from './agent-runner.js';
import { ObservabilityTracker } from './observability.js';
import { QualityAuditor } from './quality-auditor.js';
import { parseFindingTags, appendFinding } from '../../scripts/qa-findings-manager.js';

export async function runOrchestration(config: OrchestrationConfig): Promise<void> {
  // 1. Load and validate config
  const modelsConfig = loadModelsConfig();
  config.modelsConfig = modelsConfig;
  enforceDataClassification(modelsConfig);
  const { available, disabled } = resolveProviderKeys(modelsConfig);

  // 2. Consent prompt
  await showConsentPrompt(available, config.repoPath);

  // 3. Parse agents and validate integrity
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

  // 4. Initialize output directories
  mkdirSync(config.sessionLogDir, { recursive: true });
  const runDir = join(config.qaDataRoot, config.projectSlug, 'runs', config.runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(config.qaDataRoot, config.projectSlug, 'findings'), { recursive: true });
  const findingsPath = join(runDir, 'findings.jsonl');
  writeFileSync(findingsPath, '');

  // 5. Print run header
  process.stderr.write('\n=== Sparfuchs QA Review (orchestrated engine) ===\n');
  process.stderr.write(`Providers: ${available.join(', ')}`);
  if (disabled.length > 0) {
    process.stderr.write(` | Disabled: ${disabled.join('; ')}`);
  }
  process.stderr.write('\n');
  process.stderr.write(`Agents: ${agents.length} | Mode: ${config.mode} | Repo: ${config.repoPath}\n`);
  process.stderr.write(`Classification: ${modelsConfig.dataClassification} | Redact secrets: ${modelsConfig.redactSecrets}\n`);

  // 6. Run agents sequentially
  const observer = new ObservabilityTracker();
  const auditor = new QualityAuditor(config, modelsConfig);

  for (const agent of agents) {
    const status = observer.registerAgent(agent.name);

    // Resolve model info for display
    const resolved = resolveModelForAgent(
      agent.name, agent.tier, modelsConfig, config.providerOverride,
    );
    status.provider = resolved.provider;
    status.model = resolved.model;

    observer.startAgent(agent.name);

    try {
      const delegationPrompt = buildDelegationPrompt(agent, config);

      const result = await runAgent(
        agent, delegationPrompt, config, status,
        (s) => observer.updateAgent(agent.name, s),
        (e) => observer.recordFallback(e),
      );

      // Write agent output to session log
      const outputPath = join(config.sessionLogDir, `${formatTime()}_${agent.name}.md`);
      writeFileSync(outputPath, result.text);
      status.outputFilePath = outputPath;
      status.outputFileExists = true;
      status.outputSizeBytes = Buffer.byteLength(result.text);

      // Extract and stream findings
      const findings = parseFindingTags(result.text, agent.name);
      for (const finding of findings) {
        appendFinding(config.projectSlug, config.runId, finding);
      }

      observer.completeAgent(agent.name, findings.length, status.outputSizeBytes);

      // Quality audit
      const auditResult = await auditor.check(agent.name, result, findings, status);
      if (!auditResult.passed) {
        process.stderr.write(
          `  QUALITY WARNING: ${auditResult.issues.length} issue(s), score: ${auditResult.score}/100\n`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      observer.failAgent(agent.name, msg);
    }
  }

  // 7. Write quality audit results
  const auditPath = join(runDir, 'quality-audit.json');
  auditor.writeResults(auditPath);

  // 8. Write run meta
  const metaPath = join(runDir, 'meta.json');
  writeFileSync(metaPath, JSON.stringify({
    runId: config.runId,
    projectSlug: config.projectSlug,
    engine: 'orchestrated',
    mode: config.mode,
    repoPath: config.repoPath,
    startedAt: new Date().toISOString(),
    dataClassification: modelsConfig.dataClassification,
    agents: observer.toStatusArray(),
    fallbackEvents: observer.getFallbackEvents(),
    qualityAudit: auditor.getResults(),
  }, null, 2));

  // 9. Print final summary
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
  process.stderr.write(`To these LLM providers: ${providers.join(', ')}\n`);
  process.stderr.write('This includes file contents, grep results, and git diffs.\n\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => {
    rl.question('Continue? (yes/no): ', resolve);
  });
  rl.close();

  if (answer.toLowerCase() !== 'yes') {
    throw new Error('User declined data transmission. Use ENGINE=claude for local-only mode.');
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
