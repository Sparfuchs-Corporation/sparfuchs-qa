import type { AgentRunStatus, ProviderName, FallbackEvent } from './types.js';

export class ObservabilityTracker {
  private agents = new Map<string, AgentRunStatus>();
  private fallbackEvents: FallbackEvent[] = [];
  private runStartTime = Date.now();

  registerAgent(name: string): AgentRunStatus {
    const status: AgentRunStatus = {
      agentName: name,
      status: 'queued',
      provider: 'xai' as ProviderName,
      model: '',
      startedAt: null,
      completedAt: null,
      durationMs: 0,
      findingCount: 0,
      tokenUsage: { input: 0, output: 0 },
      retryCount: 0,
      fallbacksUsed: [],
      toolCallCount: 0,
      outputFilePath: null,
      outputFileExists: false,
      outputSizeBytes: 0,
      coveragePercent: null,
      error: null,
    };
    this.agents.set(name, status);
    return status;
  }

  startAgent(name: string): void {
    const status = this.agents.get(name)!;
    status.status = 'running';
    status.startedAt = new Date().toISOString();
    const idx = [...this.agents.keys()].indexOf(name) + 1;
    const total = this.agents.size;
    process.stderr.write(
      `\n--- Agent ${idx}/${total}: ${name} (${status.provider}/${status.model}) ---\n`
    );
    process.stderr.write(`[${this.timestamp()}] Running...\n`);
  }

  updateAgent(name: string, update: Partial<AgentRunStatus>): void {
    const status = this.agents.get(name)!;
    Object.assign(status, update);
    process.stderr.write(
      `\r[${this.timestamp()}] ${name}: ${status.toolCallCount} tool calls | ` +
      `${this.formatTokens(status.tokenUsage)}`
    );
  }

  completeAgent(name: string, findingCount: number, outputSizeBytes: number): void {
    const status = this.agents.get(name)!;
    status.status = 'complete';
    status.completedAt = new Date().toISOString();
    status.durationMs = Date.now() - new Date(status.startedAt!).getTime();
    status.findingCount = findingCount;
    status.outputSizeBytes = outputSizeBytes;
    const fallbackNote = status.fallbacksUsed.length > 0
      ? ` | FALLBACK ${status.fallbacksUsed.join('->')}`
      : '';
    process.stderr.write(
      `\n[${this.timestamp()}] Complete: ${findingCount} findings | ` +
      `${this.formatTokens(status.tokenUsage)} | ` +
      `${Math.round(status.durationMs / 1000)}s${fallbackNote}\n`
    );
  }

  failAgent(name: string, error: string): void {
    const status = this.agents.get(name)!;
    status.status = 'failed';
    status.error = error;
    status.completedAt = new Date().toISOString();
    if (status.startedAt) {
      status.durationMs = Date.now() - new Date(status.startedAt).getTime();
    }
    process.stderr.write(`\n[${this.timestamp()}] FAILED: ${error}\n`);
  }

  recordFallback(event: FallbackEvent): void {
    this.fallbackEvents.push(event);
  }

  printFinalSummary(): void {
    const statuses = [...this.agents.values()];
    const complete = statuses.filter(s => s.status === 'complete').length;
    const failed = statuses.filter(s => s.status === 'failed').length;
    const totalFindings = statuses.reduce((sum, s) => sum + s.findingCount, 0);
    const totalIn = statuses.reduce((sum, s) => sum + s.tokenUsage.input, 0);
    const totalOut = statuses.reduce((sum, s) => sum + s.tokenUsage.output, 0);
    const totalDuration = Date.now() - this.runStartTime;

    const providers = new Map<ProviderName, number>();
    for (const s of statuses) {
      if (s.status === 'complete' || s.status === 'failed') {
        providers.set(s.provider, (providers.get(s.provider) ?? 0) + 1);
      }
    }
    const providerStr = [...providers.entries()].map(([p, n]) => `${p} (${n})`).join(', ');
    const fallbackStr = this.fallbackEvents.length > 0
      ? `${this.fallbackEvents.length} fallback(s)` : 'none';

    process.stderr.write(`
=== Orchestrated Run Summary ===
Agents: ${complete}/${statuses.length} complete${failed > 0 ? `, ${failed} failed` : ''}
Findings: ${totalFindings}
Tokens: ${this.formatTokens({ input: totalIn, output: totalOut })}
Providers: ${providerStr} | Fallbacks: ${fallbackStr}
Duration: ${Math.round(totalDuration / 1000)}s
================================
`);
  }

  toStatusArray(): AgentRunStatus[] {
    return [...this.agents.values()];
  }

  getFallbackEvents(): FallbackEvent[] {
    return this.fallbackEvents;
  }

  private timestamp(): string {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  private formatTokens(t: { input: number; output: number }): string {
    const fmt = (n: number) => n > 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
    return `${fmt(t.input)} in / ${fmt(t.output)} out`;
  }
}
