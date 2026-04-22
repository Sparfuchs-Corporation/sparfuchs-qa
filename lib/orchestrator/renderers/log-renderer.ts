import type { RunStateSnapshot } from '../run-state.js';

/**
 * Sequential log-line renderer for non-TTY / CI environments.
 * Event-driven only — no polling, no screen clearing.
 */
export class LogRenderer {
  private lastCompletedCount = 0;
  private lastRunningAgent = '';

  render(snapshot: RunStateSnapshot): void {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

    // Log new agent starts
    for (const row of snapshot.agentRows) {
      if (row.status === 'running' && row.name !== this.lastRunningAgent) {
        this.lastRunningAgent = row.name;
        const idx = row.index;
        const total = snapshot.progress.totalChecks;
        process.stderr.write(
          `\n[${ts}] --- Agent ${idx}/${total}: ${row.name} (${row.provider}/${row.model}) ---\n`,
        );
      }
    }

    // Log completions
    const completed = snapshot.agentRows.filter(
      r => r.status === 'complete' || r.status === 'failed',
    ).length;

    if (completed > this.lastCompletedCount) {
      const newlyDone = snapshot.agentRows
        .filter(r => (r.status === 'complete' || r.status === 'failed'))
        .slice(this.lastCompletedCount);

      for (const row of newlyDone) {
        if (row.status === 'failed') {
          process.stderr.write(`[${ts}] FAILED: ${row.name} — ${row.error}\n`);
        } else {
          const fmtTokens = row.tokens > 1000 ? `${(row.tokens / 1000).toFixed(1)}k` : String(row.tokens);
          process.stderr.write(
            `[${ts}] Complete: ${row.name} | ${row.findings} findings | ${fmtTokens} tokens | ${Math.round(row.durationMs / 1000)}s\n`,
          );
        }
      }

      this.lastCompletedCount = completed;
    }
  }
}
