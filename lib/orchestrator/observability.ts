import type { AgentRunStatus, ProviderName, FallbackEvent, TokenBudget } from './types.js';

const STATUS_ICONS: Record<string, string> = {
  queued: '  ',
  running: '\u25c9 ',
  retrying: '\u21bb ',
  complete: '\u2713 ',
  failed: '\u2717 ',
};

export class ObservabilityTracker {
  private agents = new Map<string, AgentRunStatus>();
  private fallbackEvents: FallbackEvent[] = [];
  private runStartTime = Date.now();
  private isTTY = process.stderr.isTTY ?? false;
  private tableLines = 0; // lines drawn by last renderStatusTable call
  private budget: TokenBudget | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  setBudget(budget: TokenBudget): void {
    this.budget = budget;
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
      error: null,
    };
    this.agents.set(name, status);
    return status;
  }

  startAgent(name: string): void {
    const status = this.agents.get(name)!;
    status.status = 'running';
    status.startedAt = new Date().toISOString();

    this.ensureRefreshLoop();

    if (this.isTTY) {
      this.renderStatusTable();
    } else {
      const idx = [...this.agents.keys()].indexOf(name) + 1;
      const total = this.agents.size;
      process.stderr.write(
        `\n--- Agent ${idx}/${total}: ${name} (${status.provider}/${status.model}) ---\n`
      );
      process.stderr.write(`[${this.timestamp()}] Running...\n`);
    }
  }

  updateAgent(name: string, update: Partial<AgentRunStatus>): void {
    const status = this.agents.get(name)!;
    Object.assign(status, update);

    this.ensureRefreshLoop();

    if (this.isTTY) {
      this.renderStatusTable();
    } else {
      process.stderr.write(
        `\r[${this.timestamp()}] ${name}: ${status.toolCallCount} tool calls | ` +
        `${this.formatTokens(status.tokenUsage)}`
      );
    }
  }

  completeAgent(name: string, findingCount: number, outputSizeBytes: number): void {
    const status = this.agents.get(name)!;
    status.status = 'complete';
    status.completedAt = new Date().toISOString();
    status.durationMs = Date.now() - new Date(status.startedAt!).getTime();
    status.findingCount = findingCount;
    status.outputSizeBytes = outputSizeBytes;

    if (this.isTTY) {
      this.renderStatusTable();
    } else {
      const fallbackNote = status.fallbacksUsed.length > 0
        ? ` | FALLBACK ${status.fallbacksUsed.join('->')}`
        : '';
      process.stderr.write(
        `\n[${this.timestamp()}] Complete: ${findingCount} findings | ` +
        `${this.formatTokens(status.tokenUsage)} | ` +
        `${Math.round(status.durationMs / 1000)}s${fallbackNote}\n`
      );
    }

    this.maybeStopRefreshLoop();
  }

  failAgent(name: string, error: string): void {
    const status = this.agents.get(name)!;
    status.status = 'failed';
    status.error = error;
    status.completedAt = new Date().toISOString();
    if (status.startedAt) {
      status.durationMs = Date.now() - new Date(status.startedAt).getTime();
    }

    if (this.isTTY) {
      this.renderStatusTable();
    } else {
      process.stderr.write(`\n[${this.timestamp()}] FAILED: ${error}\n`);
    }

    this.maybeStopRefreshLoop();
  }

  recordFallback(event: FallbackEvent): void {
    this.fallbackEvents.push(event);
  }

  // --- Live Status Table (TTY only) ---

  private renderStatusTable(): void {
    if (!this.isTTY) return;

    // Clear previous table
    if (this.tableLines > 0) {
      process.stderr.write(`\x1b[${this.tableLines}A\x1b[J`);
    }

    const statuses = [...this.agents.values()];
    const lines: string[] = [];

    // Header
    lines.push('\x1b[1m=== Sparfuchs QA \u2014 Live Status ===\x1b[0m');

    // Budget bar
    if (this.budget && this.budget.cap > 0) {
      const pct = Math.round((this.budget.used / this.budget.cap) * 100);
      const bar = this.progressBar(pct, 30);
      lines.push(`Budget: ${bar} ${this.fmtTokens(this.budget.used)} / ${this.fmtTokens(this.budget.cap)} (${pct}%)`);
    } else if (this.budget) {
      lines.push(`Tokens used: ${this.fmtTokens(this.budget.used)} | No cap`);
    }

    lines.push('');

    // Column header
    const hdr = this.padRight('#', 3)
      + this.padRight('Agent', 30)
      + this.padRight('Status', 10)
      + this.padRight('Provider', 14)
      + this.padRight('Tokens', 14)
      + this.padRight('Findings', 10)
      + 'Duration';
    lines.push(`\x1b[4m${hdr}\x1b[0m`);

    // Agent rows
    let idx = 0;
    for (const s of statuses) {
      idx++;
      const icon = STATUS_ICONS[s.status] ?? '  ';
      const statusStr = s.status === 'complete' && s.error?.startsWith('Skipped')
        ? 'SKIPPED'
        : s.status.toUpperCase();

      const statusColor = s.status === 'complete' ? '\x1b[32m'     // green
        : s.status === 'failed' ? '\x1b[31m'                        // red
        : s.status === 'running' ? '\x1b[33m'                       // yellow
        : s.status === 'retrying' ? '\x1b[35m'                      // magenta
        : '\x1b[90m';                                                // gray (queued)

      const tokens = (s.tokenUsage.input + s.tokenUsage.output) > 0
        ? this.fmtTokens(s.tokenUsage.input + s.tokenUsage.output)
        : '\u2014';

      const findings = s.status === 'complete' && !s.error?.startsWith('Skipped')
        ? String(s.findingCount)
        : '\u2014';

      const duration = s.durationMs > 0
        ? `${Math.round(s.durationMs / 1000)}s`
        : s.status === 'running' && s.startedAt
          ? `${Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000)}s`
          : '\u2014';

      const skipReason = s.error?.startsWith('Skipped') ? ` ${s.error}` : '';

      const row = this.padRight(String(idx), 3)
        + this.padRight(s.agentName, 30)
        + statusColor + icon + this.padRight(statusStr, 8) + '\x1b[0m'
        + this.padRight(s.provider, 14)
        + this.padRight(tokens, 14)
        + this.padRight(findings, 10)
        + duration
        + skipReason;

      lines.push(row);
    }

    // Footer
    const complete = statuses.filter(s => s.status === 'complete').length;
    const running = statuses.filter(s => s.status === 'running').length;
    const retrying = statuses.filter(s => s.status === 'retrying').length;
    const failed = statuses.filter(s => s.status === 'failed').length;
    const elapsed = Math.round((Date.now() - this.runStartTime) / 1000);
    lines.push('');
    lines.push(
      `${complete} complete | ${running} running | ${retrying} retrying | ` +
      `${failed} failed | ${elapsed}s elapsed | refresh 1s`
    );

    const output = lines.join('\n') + '\n';
    process.stderr.write(output);
    this.tableLines = lines.length;
  }

  private progressBar(pct: number, width: number): string {
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;
    const color = pct > 80 ? '\x1b[31m' : pct > 50 ? '\x1b[33m' : '\x1b[32m';
    return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}\x1b[0m`;
  }

  private padRight(str: string, len: number): string {
    return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
  }

  private fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  // --- Summary ---

  printFinalSummary(): void {
    this.stopRefreshLoop();

    // Clear TTY table before printing final summary
    if (this.isTTY && this.tableLines > 0) {
      process.stderr.write(`\x1b[${this.tableLines}A\x1b[J`);
      this.tableLines = 0;
    }

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

    const budgetStr = this.budget
      ? this.budget.cap > 0
        ? ` | Budget: ${this.fmtTokens(this.budget.used)} / ${this.fmtTokens(this.budget.cap)}`
        : ` | Tokens: ${this.fmtTokens(this.budget.used)}`
      : '';

    process.stderr.write(`
=== Orchestrated Run Summary ===
Agents: ${complete}/${statuses.length} complete${failed > 0 ? `, ${failed} failed` : ''}
Findings: ${totalFindings}
Tokens: ${this.formatTokens({ input: totalIn, output: totalOut })}${budgetStr}
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

  private ensureRefreshLoop(): void {
    if (!this.isTTY || this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (!this.hasActiveAgents()) {
        this.stopRefreshLoop();
        return;
      }
      this.renderStatusTable();
    }, 1000);
  }

  private maybeStopRefreshLoop(): void {
    if (!this.hasActiveAgents()) {
      this.stopRefreshLoop();
    }
  }

  private stopRefreshLoop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private hasActiveAgents(): boolean {
    return [...this.agents.values()].some(
      s => s.status === 'running' || s.status === 'retrying'
    );
  }
}
