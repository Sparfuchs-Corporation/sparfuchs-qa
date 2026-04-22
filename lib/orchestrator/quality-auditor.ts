import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { generateText } from 'ai';
import type {
  AgentRunResult, AgentRunStatus, QualityAuditResult, QualityIssue,
  ModelsYaml, ProviderName, ApiProviderName, OrchestrationConfig,
} from './types.js';
import { isApiProvider } from './types.js';
import type { QaFinding } from '../types.js';
import type { ProviderRegistry } from './provider-registry.js';

const API_PROVIDER_NAMES = new Set<string>(['xai', 'google', 'anthropic', 'openai']);

// --- Deterministic Checks ---

function checkOutputSize(result: AgentRunResult): QualityIssue | null {
  if (result.text.length < 500) {
    return {
      type: 'give-up',
      severity: 'error',
      description: `Output is only ${result.text.length} chars (expected >500 for heavy-tier agent)`,
      evidence: result.text.slice(0, 200),
    };
  }
  return null;
}

function checkConcatenation(result: AgentRunResult): QualityIssue | null {
  const signals = ['In summary', 'To conclude', 'In conclusion', 'To summarize'];
  const duplicated = signals.filter(
    s => (result.text.match(new RegExp(s, 'gi')) ?? []).length > 1,
  );
  if (duplicated.length > 0) {
    return {
      type: 'concatenation',
      severity: 'warning',
      description: `Found ${duplicated.length} repeated summary phrases (possible concatenation)`,
      evidence: duplicated.join(', '),
    };
  }
  return null;
}

function checkHallucination(findings: QaFinding[], repoRoot: string): QualityIssue[] {
  const issues: QualityIssue[] = [];
  for (const f of findings) {
    if (!f.file) continue;
    const filePath = f.file.startsWith('/') ? f.file : `${repoRoot}/${f.file}`;
    if (!existsSync(filePath)) {
      issues.push({
        type: 'hallucination',
        severity: 'error',
        description: `Finding references non-existent file: ${f.file}`,
        evidence: `Finding: ${f.title} (${f.agent})`,
      });
      continue;
    }
    if (f.line && f.line > 0) {
      const lineCount = readFileSync(filePath, 'utf8').split('\n').length;
      if (f.line > lineCount) {
        issues.push({
          type: 'hallucination',
          severity: 'warning',
          description: `Finding line ${f.line} exceeds file length (${lineCount} lines): ${f.file}`,
          evidence: `Finding: ${f.title} (${f.agent})`,
        });
      }
    }
  }
  return issues;
}

function checkBatchedFindings(result: AgentRunResult): QualityIssue | null {
  const patterns = [
    /\+ \d+ more/i,
    /\d+[-\u2013]\d+\.\s/,
    /and \d+ (?:similar|others|more)/i,
    /Multiple (?:routes|files|components)/i,
  ];
  for (const pat of patterns) {
    const match = result.text.match(pat);
    if (match) {
      const idx = result.text.indexOf(match[0]);
      return {
        type: 'batched-findings',
        severity: 'error',
        description: `Found batched finding pattern: "${match[0]}"`,
        evidence: result.text.slice(Math.max(0, idx - 50), idx + 100),
      };
    }
  }
  return null;
}

function checkGiveUp(result: AgentRunResult): QualityIssue | null {
  const giveUpPhrases = ['I was unable to', 'I could not', 'I cannot analyze', 'No issues found'];
  const hasGiveUp = giveUpPhrases.some(p => result.text.includes(p));
  const hasToolCalls = result.steps.some(s => s.toolCalls.length > 0);
  if (hasGiveUp && !hasToolCalls) {
    return {
      type: 'give-up',
      severity: 'error',
      description: 'Agent reported inability with zero tool calls (gave up without trying)',
      evidence: giveUpPhrases.filter(p => result.text.includes(p)).join(', '),
    };
  }
  return null;
}

// --- Cross-Provider Semantic Check ---

async function semanticAudit(
  agentName: string,
  result: AgentRunResult,
  config: ModelsYaml,
  agentProvider: ProviderName,
  registry: ProviderRegistry | null,
): Promise<{ issue: QualityIssue | null; auditProvider: ProviderName | undefined }> {
  if (!registry) return { issue: null, auditProvider: undefined };

  // Pick a DIFFERENT provider
  // Quality audit requires an API provider (calls generateText directly)
  const auditProvider = config.fallbackChain.find(
    p => p !== agentProvider && config.providers[p]?.enabled && API_PROVIDER_NAMES.has(p),
  );
  if (!auditProvider) return { issue: null, auditProvider: undefined };

  // Hard timeout. Without this, a hung Anthropic API call (rate limit,
  // transient network issue, proxy stall) blocks the dispatchJob promise
  // from resolving — which in turn prevents the current stage's
  // Promise.allSettled from resolving, which prevents the next stage from
  // ever dispatching. The entire orchestrator freezes silently.
  const SEMANTIC_AUDIT_TIMEOUT_MS = 30_000;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SEMANTIC_AUDIT_TIMEOUT_MS);

  try {
    const modelName = config.tiers.light[auditProvider as ApiProviderName];
    const model = registry.createModel(auditProvider as ApiProviderName, modelName, `audit-${agentName}`);
    const audit = await generateText({
      model,
      prompt:
        `You are a QA audit checker. Review this agent output and answer: ` +
        `Does it show evidence of thorough analysis? List any signs of incomplete work, ` +
        `truncation, or lazy responses. Be concise (under 100 words).\n\n` +
        `Agent: ${agentName}\n` +
        `Output length: ${result.text.length} chars\n` +
        `Tool calls: ${result.steps.flatMap(s => s.toolCalls).length}\n` +
        `First 2000 chars:\n${result.text.slice(0, 2000)}`,
      maxOutputTokens: 200,
      abortSignal: abortController.signal,
    });

    const hasIssues = /incomplete|truncated|lazy|superficial|missing|skipped/i.test(audit.text);
    if (hasIssues) {
      return {
        issue: {
          type: 'give-up',
          severity: 'warning',
          description: 'Cross-provider audit flagged potential quality issues',
          evidence: audit.text.slice(0, 500),
        },
        auditProvider,
      };
    }
    return { issue: null, auditProvider };
  } catch (err) {
    // Timeout or API error — swallow so a failing audit never blocks the run.
    // Surface it as an advisory issue so it still shows up in the report.
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = abortController.signal.aborted;
    return {
      issue: isTimeout
        ? {
            type: 'give-up',
            severity: 'warning',
            description: `Semantic audit timed out after ${SEMANTIC_AUDIT_TIMEOUT_MS / 1000}s`,
            evidence: `Audit via ${auditProvider} did not respond in time: ${msg}`,
          }
        : null,
      auditProvider,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- Public API ---

export class QualityAuditor {
  private results: QualityAuditResult[] = [];
  private config: OrchestrationConfig;
  private modelsConfig: ModelsYaml;
  private registry: ProviderRegistry | null;

  constructor(config: OrchestrationConfig, modelsConfig: ModelsYaml, registry?: ProviderRegistry) {
    this.config = config;
    this.modelsConfig = modelsConfig;
    this.registry = registry ?? null;
  }

  async check(
    agentName: string,
    result: AgentRunResult,
    findings: QaFinding[],
    status: AgentRunStatus,
  ): Promise<QualityAuditResult> {
    const issues: QualityIssue[] = [];

    const sizeIssue = checkOutputSize(result);
    if (sizeIssue) issues.push(sizeIssue);

    const concatIssue = checkConcatenation(result);
    if (concatIssue) issues.push(concatIssue);

    issues.push(...checkHallucination(findings, this.config.repoPath));

    const batchIssue = checkBatchedFindings(result);
    if (batchIssue) issues.push(batchIssue);

    const giveUpIssue = checkGiveUp(result);
    if (giveUpIssue) issues.push(giveUpIssue);

    const { issue: semanticIssue, auditProvider } = await semanticAudit(
      agentName, result, this.modelsConfig, status.provider, this.registry,
    );
    if (semanticIssue) issues.push(semanticIssue);

    const errorCount = issues.filter(i => i.severity === 'error').length;
    const score = Math.max(0, 100 - (errorCount * 20) - ((issues.length - errorCount) * 5));

    const audit: QualityAuditResult = {
      agentName,
      issues,
      score,
      passed: score >= 70,
      auditProvider,
    };
    this.results.push(audit);
    return audit;
  }

  getResults(): QualityAuditResult[] {
    return this.results;
  }

  writeResults(outputPath: string): void {
    writeFileSync(outputPath, JSON.stringify(this.results, null, 2));
  }
}
