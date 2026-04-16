import type { AgentRunStatus, ProviderName, FallbackEvent, TokenBudget } from './types.js';

const STATUS_ICONS: Record<string, string> = {
  queued: '  ',
  'awaiting-data': '\u29d7 ',
  running: '\u25c9 ',
  retrying: '\u21bb ',
  complete: '\u2713 ',
  failed: '\u2717 ',
  skipped: '  ',
};

type SortField = 'default' | 'name' | 'status' | 'duration' | 'findings';

export class ObservabilityTracker {
  private agents = new Map<string, AgentRunStatus>();
  private fallbackEvents: FallbackEvent[] = [];
  private runStartTime = Date.now();
  private isTTY = process.stderr.isTTY ?? false;
  private tableLines = 0; // lines drawn by last renderStatusTable call
  private budget: TokenBudget | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  // Keyboard state
  private showDetail = false;
  private showHelp = false;
  private sortField: SortField = 'default';
  private paused = false;
  private quitRequested = false;
  private keyboardSetup = false;

  setBudget(budget: TokenBudget): void {
    this.budget = budget;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isQuitRequested(): boolean {
    return this.quitRequested;
  }

  setupKeyboardInput(): void {
    if (this.keyboardSetup || !this.isTTY || !process.stdin.isTTY) return;
    this.keyboardSetup = true;

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      // Ctrl+C — first press = graceful quit, second = force
      if (key === '\x03') {
        if (this.quitRequested) {
          process.exit(1);
        }
        this.quitRequested = true;
        return;
      }

      switch (key.toLowerCase()) {
        case 'q':
          this.quitRequested = true;
          break;
        case 'p':
          this.paused = true;
          break;
        case 'r':
          this.paused = false;
          break;
        case 's':
          this.cycleSortField();
          break;
        case 'd':
          this.showDetail = !this.showDetail;
          break;
        case '?':
          this.showHelp = !this.showHelp;
          break;
        case '\x1b': // Escape
          this.showHelp = false;
          this.showDetail = false;
          break;
      }

      this.renderStatusTable();
    });
  }

  teardownKeyboardInput(): void {
    if (!this.keyboardSetup) return;
    this.keyboardSetup = false;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }

  private cycleSortField(): void {
    const order: SortField[] = ['default', 'name', 'status', 'duration', 'findings'];
    const idx = order.indexOf(this.sortField);
    this.sortField = order[(idx + 1) % order.length];
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

    if (this.showHelp) {
      this.renderHelpScreen();
      return;
    }

    // Clear previous table
    if (this.tableLines > 0) {
      process.stderr.write(`\x1b[${this.tableLines}A\x1b[J`);
    }

    const statuses = [...this.agents.values()];
    const lines: string[] = [];

    // Header
    const pauseTag = this.paused ? ' \x1b[33m[PAUSED]\x1b[0m' : '';
    const quitTag = this.quitRequested ? ' \x1b[31m[STOPPING...]\x1b[0m' : '';
    lines.push(`\x1b[1m=== Sparfuchs QA \u2014 Live Dashboard ===${pauseTag}${quitTag}\x1b[0m`);

    const elapsed = Math.round((Date.now() - this.runStartTime) / 1000);
    lines.push(`Elapsed: ${this.fmtDuration(elapsed * 1000)} | Sort: ${this.sortField}`);

    // Budget bar
    if (this.budget && this.budget.cap > 0) {
      const pct = Math.round((this.budget.used / this.budget.cap) * 100);
      const bar = this.progressBar(pct, 30);
      lines.push(`Budget:   ${bar} ${this.fmtTokens(this.budget.used)} / ${this.fmtTokens(this.budget.cap)} (${pct}%)`);
    } else if (this.budget) {
      lines.push(`Tokens:   ${this.fmtTokens(this.budget.used)} used | No cap`);
    }

    // Progress bar
    const complete = statuses.filter(s => s.status === 'complete' && !s.error?.startsWith('Skipped')).length;
    const failed = statuses.filter(s => s.status === 'failed').length;
    const skipped = statuses.filter(s => s.error?.startsWith('Skipped')).length;
    const done = complete + failed + skipped;
    const progressPct = statuses.length > 0 ? Math.round((done / statuses.length) * 100) : 0;
    lines.push(`Progress: ${this.progressBar(progressPct, 30)} ${done}/${statuses.length} agents (${progressPct}%)`);

    lines.push('');

    // Column header
    const hdr = this.padRight('#', 3)
      + this.padRight('Agent', 30)
      + this.padRight('Status', 12)
      + this.padRight('Provider', 14)
      + this.padRight('Tokens', 14)
      + this.padRight('Findings', 10)
      + 'Duration';
    lines.push(`\x1b[4m${hdr}\x1b[0m`);

    // Sort agent rows
    const sorted = this.sortAgentRows(statuses);

    // Agent rows
    let idx = 0;
    for (const s of sorted) {
      idx++;
      const icon = STATUS_ICONS[s.status] ?? '  ';
      const statusStr = s.status === 'complete' && s.error?.startsWith('Skipped')
        ? 'SKIPPED'
        : s.status.toUpperCase();

      const statusColor = s.status === 'complete' ? '\x1b[32m'     // green
        : s.status === 'failed' ? '\x1b[31m'                        // red
        : s.status === 'running' ? '\x1b[33m'                       // yellow
        : s.status === 'retrying' ? '\x1b[35m'                      // magenta
        : s.status === 'awaiting-data' ? '\x1b[36m'                 // cyan
        : '\x1b[90m';                                                // gray (queued)

      const tokens = (s.tokenUsage.input + s.tokenUsage.output) > 0
        ? this.fmtTokens(s.tokenUsage.input + s.tokenUsage.output)
        : '\u2014';

      const findings = s.status === 'complete' && !s.error?.startsWith('Skipped')
        ? String(s.findingCount)
        : '\u2014';

      const duration = s.durationMs > 0
        ? this.fmtDuration(s.durationMs)
        : s.status === 'running' && s.startedAt
          ? `${this.fmtDuration(Date.now() - new Date(s.startedAt).getTime())}\u2191`
          : '\u2014';

      const skipReason = s.error?.startsWith('Skipped') ? ` ${s.error}` : '';

      const row = this.padRight(String(idx), 3)
        + this.padRight(s.agentName, 30)
        + statusColor + icon + this.padRight(statusStr, 10) + '\x1b[0m'
        + this.padRight(s.provider, 14)
        + this.padRight(tokens, 14)
        + this.padRight(findings, 10)
        + duration
        + skipReason;

      lines.push(row);
    }

    // Active agent detail panel
    if (this.showDetail) {
      const active = statuses.find(s => s.status === 'running');
      if (active) {
        lines.push('');
        lines.push(`\u2500\u2500 Active: ${active.agentName} \u2500\u2500 ${active.toolCallCount} tool calls`);
        if (active.coveragePercent !== null) {
          lines.push(`  Coverage: ${active.coveragePercent}%`);
        }
      }
    }

    // Footer
    const running = statuses.filter(s => s.status === 'running').length;
    const retrying = statuses.filter(s => s.status === 'retrying').length;
    lines.push('');
    lines.push(
      `${complete} complete | ${running} running | ` +
      `${retrying > 0 ? `${retrying} retrying | ` : ''}` +
      `${failed} failed | ` +
      `\x1b[90m[q]uit [p]ause [r]esume [s]ort [d]etail [?]help\x1b[0m`,
    );

    const output = lines.join('\n') + '\n';
    process.stderr.write(output);
    this.tableLines = lines.length;
  }

  private renderHelpScreen(): void {
    if (this.tableLines > 0) {
      process.stderr.write(`\x1b[${this.tableLines}A\x1b[J`);
    }

    const lines = [
      '\x1b[1m=== Sparfuchs QA \u2014 Keyboard Commands ===\x1b[0m',
      '',
      '  q         Graceful shutdown \u2014 finish current agent, skip remaining,',
      '            write partial results, exit cleanly',
      '  Ctrl+C    Same as q (first press). Force kill (second press).',
      '',
      '  p         Pause \u2014 finish current agent, hold queue',
      '  r         Resume \u2014 continue processing queued agents',
      '',
      '  s         Cycle sort order: default \u2192 name \u2192 status \u2192 duration \u2192 findings',
      '  d         Toggle detail panel: show/hide active agent info',
      '',
      '  ?         Toggle this help screen',
      '  Esc       Close help / close detail panel',
      '',
      '\u2500\u2500\u2500 Status Icons \u2500\u2500\u2500',
      '  \u25c9  RUNNING    Agent is actively executing',
      '  \u29d7  AWAITING   Waiting for upstream agent data',
      '  \u2713  COMPLETE   Agent finished successfully',
      '  \u2717  FAILED     Agent errored (or missing upstream data)',
      '  \u21bb  RETRYING   Agent failed, trying next provider',
      '     QUEUED     Waiting to run',
      '     SKIPPED    Predicted ineffective or incompatible',
      '',
      'Press ? or Esc to return to live view',
    ];

    process.stderr.write(lines.join('\n') + '\n');
    this.tableLines = lines.length;
  }

  private sortAgentRows(statuses: AgentRunStatus[]): AgentRunStatus[] {
    if (this.sortField === 'default') return statuses;

    return [...statuses].sort((a, b) => {
      switch (this.sortField) {
        case 'name':
          return a.agentName.localeCompare(b.agentName);
        case 'status': {
          const order: Record<string, number> = { running: 0, retrying: 1, 'awaiting-data': 2, queued: 3, complete: 4, failed: 5 };
          return (order[a.status] ?? 9) - (order[b.status] ?? 9);
        }
        case 'duration':
          return (b.durationMs || 0) - (a.durationMs || 0);
        case 'findings':
          return b.findingCount - a.findingCount;
        default:
          return 0;
      }
    });
  }

  private fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
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
    this.teardownKeyboardInput();

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
