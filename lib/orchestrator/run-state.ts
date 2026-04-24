import type { AgentRunStatus, ProviderName, FallbackEvent, TokenBudget, CoverageStrategy, FilesDisplay } from './types.js';
import type { CoverageBabysitter } from './coverage-babysitter.js';

/**
 * Pure data layer for orchestration run state.
 * No rendering, no ANSI, no process.stderr — just data and snapshots.
 */

export interface RunStateSnapshot {
  runId: string;
  startedAt: string;
  elapsedMs: number;
  lastUpdated: string;

  // Overall progress
  progress: {
    totalChecks: number;
    completedChecks: number;
    percent: number;
    etaMs: number | null;
  };

  // Agent counts
  agents: {
    total: number;
    queued: number;
    awaitingData: number;
    running: number;
    stale: number;
    complete: number;
    failed: number;
    skipped: number;
  };

  // Findings
  findings: { total: number; bySeverity: Record<string, number> };

  // Tokens
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    total: number;
    cacheHitRate: number;
    estimatedSavingsUsd: number;
  };
  budget: { cap: number; used: number; percent: number } | null;

  // Coverage
  coverage: {
    strategy: string;
    targetPercent: number;
    actualPercent: number;
    filesExamined: number;
    filesTotal: number;
  } | null;

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
    // Legacy chunked-style files rendering — kept for backward compat.
    // Prefer `filesDisplay` (category-aware) when present.
    files: { examined: number; assigned: number; percent: number } | null;
    filesDisplay: FilesDisplay | null;
    durationMs: number;
    error: string | null;
  }>;

  // Active agent detail
  activeAgent: {
    name: string;
    assignedFiles: string[];
    examinedFiles: string[];
    toolCallCount: number;
    lastAction: string | null;
  } | null;
}

export class RunState {
  private agents = new Map<string, AgentRunStatus>();
  private fallbackEvents: FallbackEvent[] = [];
  private runStartTime = Date.now();
  private runId = '';
  private budget: TokenBudget | null = null;
  private babysitter: CoverageBabysitter | null = null;
  private completedDurations: number[] = [];
  private pricingPerMillion = 5.0; // default $/1M tokens for savings calc
  private totalFiles = 0;

  setRunId(runId: string): void {
    this.runId = runId;
  }

  setBudget(budget: TokenBudget): void {
    this.budget = budget;
  }

  setBabysitter(babysitter: CoverageBabysitter): void {
    this.babysitter = babysitter;
  }

  setPricing(pricePerMillion: number): void {
    this.pricingPerMillion = pricePerMillion;
  }

  setTotalFiles(count: number): void {
    this.totalFiles = count;
  }

  getRunStartTime(): number {
    return this.runStartTime;
  }

  registerAgent(name: string): AgentRunStatus {
    const status: AgentRunStatus = {
      agentName: name,
      status: 'queued',
      provider: 'xai' as ProviderName,
      model: '',
      startedAt: null,
      completedAt: null,
      lastHeartbeat: null,
      durationMs: 0,
      findingCount: 0,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      retryCount: 0,
      fallbacksUsed: [],
      toolCallCount: 0,
      outputFilePath: null,
      outputFileExists: false,
      outputSizeBytes: 0,
      coveragePercent: null,
      filesAssigned: null,
      filesDisplay: null,
      error: null,
    };
    this.agents.set(name, status);
    return status;
  }

  getAgent(name: string): AgentRunStatus | undefined {
    return this.agents.get(name);
  }

  getAgents(): ReadonlyArray<AgentRunStatus> {
    return [...this.agents.values()];
  }

  getActiveAgents(): ReadonlyArray<AgentRunStatus> {
    return [...this.agents.values()].filter(
      s => s.status === 'running' || s.status === 'retrying',
    );
  }

  recordFallback(event: FallbackEvent): void {
    this.fallbackEvents.push(event);
  }

  getFallbackEvents(): FallbackEvent[] {
    return this.fallbackEvents;
  }

  recordCompletion(durationMs: number): void {
    this.completedDurations.push(durationMs);
  }

  /**
   * Produce an immutable snapshot of the current run state.
   * Renderers work from snapshots, never from live state — prevents torn reads.
   */
  snapshot(): RunStateSnapshot {
    const statuses = [...this.agents.values()];
    const now = Date.now();
    const refreshMs = 1000; // for stale detection

    // Agent counts
    let queued = 0, awaitingData = 0, running = 0, stale = 0;
    let complete = 0, failed = 0, skipped = 0;

    for (const s of statuses) {
      if (s.status === 'queued') queued++;
      else if (s.status === 'awaiting-data') awaitingData++;
      else if (s.status === 'running' || s.status === 'retrying') {
        if (s.lastHeartbeat && now - s.lastHeartbeat > refreshMs * 2) {
          stale++;
        } else {
          running++;
        }
      }
      else if (s.status === 'complete') {
        if (s.error?.startsWith('Skipped')) skipped++;
        else complete++;
      }
      else if (s.status === 'failed') failed++;
    }

    const completedChecks = complete + failed + skipped;
    const totalChecks = statuses.length;

    // ETA based on average completed duration
    let etaMs: number | null = null;
    if (this.completedDurations.length > 0 && completedChecks < totalChecks) {
      const avgDuration = this.completedDurations.reduce((a, b) => a + b, 0) / this.completedDurations.length;
      etaMs = Math.round(avgDuration * (totalChecks - completedChecks));
    }

    // Token aggregates
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0;
    let totalFindings = 0;
    const providerCounts = new Map<string, number>();
    const bySeverity: Record<string, number> = {};

    for (const s of statuses) {
      totalInput += s.tokenUsage.input;
      totalOutput += s.tokenUsage.output;
      totalCacheRead += s.tokenUsage.cacheRead;
      totalCacheCreation += s.tokenUsage.cacheCreation;
      totalFindings += s.findingCount;

      if (s.status === 'complete' || s.status === 'failed') {
        providerCounts.set(s.provider, (providerCounts.get(s.provider) ?? 0) + 1);
      }
    }

    const totalTokens = totalInput + totalOutput;
    const cacheHitRate = (totalInput + totalCacheRead) > 0
      ? totalCacheRead / (totalInput + totalCacheRead)
      : 0;
    const savingsPerToken = this.pricingPerMillion / 1_000_000 * 0.9; // cache saves 90%
    const estimatedSavingsUsd = totalCacheRead * savingsPerToken;

    // Agent rows
    const agentRows = statuses.map((s, i) => ({
      index: i + 1,
      name: s.agentName,
      status: s.status === 'complete' && s.error?.startsWith('Skipped') ? 'skipped' : s.status,
      provider: s.provider,
      model: s.model,
      tokens: s.tokenUsage.input + s.tokenUsage.output,
      findings: s.findingCount,
      files: s.coveragePercent !== null && s.filesAssigned !== null ? {
        examined: Math.round((s.coveragePercent / 100) * s.filesAssigned),
        assigned: s.filesAssigned,
        percent: s.coveragePercent,
      } : null,
      filesDisplay: s.filesDisplay,
      durationMs: s.durationMs > 0 ? s.durationMs
        : s.startedAt ? now - new Date(s.startedAt).getTime()
        : 0,
      error: s.error,
    }));

    // Active agent
    let activeAgent: RunStateSnapshot['activeAgent'] = null;
    const runningAgent = statuses.find(s => s.status === 'running');
    if (runningAgent) {
      activeAgent = {
        name: runningAgent.agentName,
        assignedFiles: [],
        examinedFiles: [],
        toolCallCount: runningAgent.toolCallCount,
        lastAction: null,
      };
    }

    return {
      runId: this.runId,
      startedAt: new Date(this.runStartTime).toISOString(),
      elapsedMs: now - this.runStartTime,
      lastUpdated: new Date().toISOString(),
      progress: {
        totalChecks,
        completedChecks,
        percent: totalChecks > 0 ? Math.round((completedChecks / totalChecks) * 100) : 0,
        etaMs,
      },
      agents: { total: totalChecks, queued, awaitingData, running, stale, complete, failed, skipped },
      findings: { total: totalFindings, bySeverity },
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheCreation: totalCacheCreation,
        total: totalTokens,
        cacheHitRate: Math.round(cacheHitRate * 100) / 100,
        estimatedSavingsUsd: Math.round(estimatedSavingsUsd * 100) / 100,
      },
      budget: this.budget ? {
        cap: this.budget.cap,
        used: this.budget.used,
        percent: this.budget.cap > 0 ? Math.round((this.budget.used / this.budget.cap) * 100) : 0,
      } : null,
      coverage: this.babysitter ? {
        strategy: this.babysitter.getStrategy(),
        targetPercent: this.babysitter.getTargetPercent(),
        actualPercent: this.babysitter.getCoveragePercent(),
        filesExamined: this.babysitter.getFilesExamined().size,
        filesTotal: this.totalFiles,
      } : null,
      providers: [...providerCounts.entries()].map(([name, agentCount]) => ({ name, agentCount })),
      fallbacks: this.fallbackEvents.length,
      agentRows,
      activeAgent,
    };
  }
}
