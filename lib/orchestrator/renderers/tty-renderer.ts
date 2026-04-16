import type { RunStateSnapshot } from '../run-state.js';

const STATUS_ICONS: Record<string, string> = {
  queued: '  ',
  'awaiting-data': '\u29D7 ',
  running: '\u25C9 ',
  retrying: '\u21BB ',
  complete: '\u2713 ',
  failed: '\u2717 ',
  skipped: '  ',
};

export class TtyRenderer {
  private tableLines = 0;
  private showDetail = false;
  private showHelp = false;
  private scrollOffset = 0;

  render(snapshot: RunStateSnapshot): void {
    if (this.showHelp) {
      this.renderHelp();
      return;
    }

    // Clear previous table
    if (this.tableLines > 0) {
      process.stderr.write(`\x1b[${this.tableLines}A\x1b[J`);
    }

    const lines: string[] = [];

    // Header
    lines.push('\x1b[1m=== Sparfuchs QA \u2014 Live Dashboard ===\x1b[0m');
    lines.push(
      `Run: ${snapshot.runId} | Elapsed: ${this.fmtDuration(snapshot.elapsedMs)}` +
      (snapshot.progress.etaMs ? ` | ETA: ~${this.fmtDuration(snapshot.progress.etaMs)}` : ''),
    );
    lines.push('');

    // Progress bars
    lines.push(
      `Progress:  ${this.progressBar(snapshot.progress.percent, 30)} ` +
      `${snapshot.progress.completedChecks}/${snapshot.progress.totalChecks} agents (${snapshot.progress.percent}%)`,
    );

    if (snapshot.budget && snapshot.budget.cap > 0) {
      lines.push(
        `Budget:    ${this.progressBar(snapshot.budget.percent, 30, snapshot.budget.percent > 80)} ` +
        `${this.fmtTokens(snapshot.budget.used)} / ${this.fmtTokens(snapshot.budget.cap)} (${snapshot.budget.percent}%)`,
      );
    } else {
      lines.push(`Tokens:    ${this.fmtTokens(snapshot.tokens.total)} used | No cap`);
    }

    if (snapshot.coverage) {
      const coveragePct = snapshot.coverage.actualPercent;
      const targetPct = snapshot.coverage.targetPercent;
      const met = coveragePct >= targetPct;
      lines.push(
        `Coverage:  ${this.progressBar(coveragePct, 30, !met)} ` +
        `${snapshot.coverage.filesExamined} / ${snapshot.coverage.filesTotal} files ` +
        `(${coveragePct}% \u2192 ${targetPct}% target)`,
      );
    }

    if (snapshot.tokens.cacheRead > 0) {
      const hitPct = Math.round(snapshot.tokens.cacheHitRate * 100);
      lines.push(
        `Cache:     ${this.progressBar(hitPct, 30)} ` +
        `${hitPct}% hit rate | saved ~$${snapshot.tokens.estimatedSavingsUsd.toFixed(2)}`,
      );
    }

    lines.push('');

    // Column header
    const hdr = this.pad('#', 3)
      + this.pad('Agent', 30)
      + this.pad('Status', 12)
      + this.pad('Provider', 14)
      + this.pad('Tokens', 10)
      + this.pad('Findings', 10)
      + this.pad('Files', 14)
      + 'Duration';
    lines.push(`\x1b[4m${hdr}\x1b[0m`);

    // Agent rows — viewport to fit terminal height
    const termRows = process.stderr.rows || process.stdout.rows || 40;
    // Reserve space for: footer(2) + possible ▲/▼ indicators(2) + detail panel
    const reservedLines = 4 + (this.showDetail ? 14 : 0);
    const maxVisibleRows = Math.max(3, termRows - lines.length - reservedLines);
    const totalRows = snapshot.agentRows.length;

    // Auto-scroll to keep running agents visible
    if (totalRows > maxVisibleRows) {
      const firstRunningIdx = snapshot.agentRows.findIndex(r => r.status === 'running');
      if (firstRunningIdx >= 0) {
        // Center the running agents in the viewport
        this.scrollOffset = Math.max(0, Math.min(
          firstRunningIdx - Math.floor(maxVisibleRows / 3),
          totalRows - maxVisibleRows,
        ));
      }
    } else {
      this.scrollOffset = 0;
    }

    const visibleRows = snapshot.agentRows.slice(this.scrollOffset, this.scrollOffset + maxVisibleRows);

    if (this.scrollOffset > 0) {
      lines.push(`\x1b[90m  \u25B2 ${this.scrollOffset} agents above\x1b[0m`);
    }

    for (const row of visibleRows) {
      const icon = STATUS_ICONS[row.status] ?? '  ';
      const statusColor = row.status === 'complete' ? '\x1b[32m'
        : row.status === 'failed' ? '\x1b[31m'
        : row.status === 'running' ? '\x1b[33m'
        : row.status === 'retrying' ? '\x1b[35m'
        : row.status === 'awaiting-data' ? '\x1b[36m'
        : '\x1b[90m';

      const tokens = row.tokens > 0 ? this.fmtTokens(row.tokens) : '\u2014';
      const findings = row.status === 'complete' ? String(row.findings) : '\u2014';
      const filesStr = row.files
        ? `${row.files.examined}/${row.files.assigned} ${row.files.percent}%${row.status === 'running' ? '\u2191' : ''}`
        : '\u2014';
      const duration = row.durationMs > 0 ? `${Math.round(row.durationMs / 1000)}s` : '\u2014';
      const errorSuffix = row.error?.startsWith('Skipped') ? ` ${row.error}` : '';

      const line = this.pad(String(row.index), 3)
        + this.pad(row.name, 30)
        + statusColor + icon + this.pad(row.status.toUpperCase(), 10) + '\x1b[0m'
        + this.pad(row.provider, 14)
        + this.pad(tokens, 10)
        + this.pad(findings, 10)
        + this.pad(filesStr, 14)
        + duration
        + errorSuffix;

      lines.push(line);
    }

    const hiddenBelow = totalRows - this.scrollOffset - visibleRows.length;
    if (hiddenBelow > 0) {
      lines.push(`\x1b[90m  \u25BC ${hiddenBelow} agents below\x1b[0m`);
    }

    // Active agent detail panel
    if (this.showDetail && snapshot.activeAgent) {
      const a = snapshot.activeAgent;
      lines.push('');
      lines.push(`\u2500\u2500 Active: ${a.name} \u2500\u2500 ${a.toolCallCount} tool calls`);
      if (a.examinedFiles.length > 0) {
        for (const f of a.examinedFiles.slice(0, 10)) {
          lines.push(`  \u2713 ${f}`);
        }
        if (a.examinedFiles.length > 10) {
          lines.push(`  ... and ${a.examinedFiles.length - 10} more`);
        }
      }
    }

    // Hard clamp — never write more lines than the terminal can display.
    // Clamp BEFORE the footer so footer is always visible.
    const footerSize = 2; // blank line + status/shortcuts
    if (lines.length >= termRows - footerSize) {
      lines.length = termRows - footerSize - 1;
    }

    // Footer (always rendered, never clipped)
    lines.push('');
    const counts = snapshot.agents;
    lines.push(
      `${counts.complete} complete | ${counts.running} running | ` +
      `${counts.stale > 0 ? `${counts.stale} stale | ` : ''}` +
      `${counts.awaitingData > 0 ? `${counts.awaitingData} awaiting | ` : ''}` +
      `${counts.failed} failed | ` +
      `[q]uit [p]ause [s]ort [d]etail [?]help`,
    );

    const output = lines.join('\n') + '\n';
    process.stderr.write(output);
    this.tableLines = lines.length;
  }

  scrollUp(lines = 5): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
  }

  scrollDown(lines = 5, totalRows = 0): void {
    if (totalRows > 0) {
      this.scrollOffset = Math.min(totalRows - 1, this.scrollOffset + lines);
    }
  }

  toggleDetail(): void {
    this.showDetail = !this.showDetail;
  }

  toggleHelp(): void {
    this.showHelp = !this.showHelp;
  }

  isShowingHelp(): boolean {
    return this.showHelp;
  }

  clear(): void {
    if (this.tableLines > 0) {
      process.stderr.write(`\x1b[${this.tableLines}A\x1b[J`);
      this.tableLines = 0;
    }
  }

  private renderHelp(): void {
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
      '  j / \u2193     Scroll agent list down',
      '  k / \u2191     Scroll agent list up',
      '  s         Cycle sort order: name \u2192 status \u2192 duration \u2192 findings \u2192 coverage',
      '  d         Toggle detail panel: show/hide active agent file checklist',
      '  p         Pause \u2014 finish current agent, hold queue',
      '  r         Resume \u2014 continue processing queued agents',
      '',
      '  ?         Toggle this help screen',
      '  Esc       Close help / close detail panel',
      '',
      '\u2500\u2500\u2500 Status Icons \u2500\u2500\u2500',
      '  \u25C9  RUNNING    Agent is actively executing',
      '  \u29D7  AWAITING   Waiting for upstream agent data',
      '  \u2713  COMPLETE   Agent finished successfully',
      '  \u2717  FAILED     Agent errored (or missing upstream data)',
      '  \u21BB  RETRYING   Agent failed, trying next provider',
      '     QUEUED     Waiting to run',
      '     SKIPPED    Predicted ineffective or incompatible',
      '',
      '  Tip: run `sparfuchs status --watch` in a second pane',
      '',
      'Press ? or Esc to return to live view',
    ];

    process.stderr.write(lines.join('\n') + '\n');
    this.tableLines = lines.length;
  }

  private progressBar(pct: number, width: number, warn = false): string {
    const filled = Math.round((Math.min(pct, 100) / 100) * width);
    const empty = width - filled;
    const color = warn ? '\x1b[31m' : pct > 80 ? '\x1b[32m' : pct > 50 ? '\x1b[33m' : '\x1b[90m';
    return `${color}${'█'.repeat(filled)}${'░'.repeat(empty)}\x1b[0m`;
  }

  private pad(str: string, len: number): string {
    return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
  }

  private fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  private fmtDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }
}
