#!/usr/bin/env npx tsx
// sparfuchs-status.ts — Read active-run.json and display current run status.
// Usage:
//   npx tsx scripts/sparfuchs-status.ts          # one-shot
//   npx tsx scripts/sparfuchs-status.ts --watch   # 1s polling loop

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStateSnapshot } from '../lib/orchestrator/run-state.js';

const ACTIVE_RUN_PATH = join(process.env.HOME ?? '/tmp', '.sparfuchs-qa', 'active-run.json');
const WATCH_MODE = process.argv.includes('--watch');
const POLL_MS = 1000;

function readSnapshot(): RunStateSnapshot | null {
  if (!existsSync(ACTIVE_RUN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ACTIVE_RUN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}

function renderSnapshot(snapshot: RunStateSnapshot): string {
  const lines: string[] = [];

  // Stale detection
  const lastUpdated = new Date(snapshot.lastUpdated).getTime();
  const staleMs = Date.now() - lastUpdated;
  const isStale = staleMs > 30_000;
  const staleWarning = isStale ? `  \x1b[31m(stale — run may have crashed, last update ${Math.round(staleMs / 1000)}s ago)\x1b[0m` : '';
  const freshness = `Last updated: ${Math.round(staleMs / 1000)}s ago`;

  lines.push(`\x1b[1m=== Sparfuchs QA — Status ===\x1b[0m${staleWarning}`);
  lines.push(`Run: ${snapshot.runId} | Elapsed: ${fmtDuration(snapshot.elapsedMs)} | ${freshness}`);
  lines.push('');

  // Progress
  lines.push(`Progress: ${snapshot.progress.completedChecks}/${snapshot.progress.totalChecks} agents (${snapshot.progress.percent}%)`);
  lines.push(`Tokens: ${fmtTokens(snapshot.tokens.total)} | Findings: ${snapshot.findings.total}`);

  if (snapshot.coverage) {
    lines.push(`Coverage: ${snapshot.coverage.actualPercent}% → ${snapshot.coverage.targetPercent}% target (${snapshot.coverage.strategy})`);
  }

  if (snapshot.tokens.cacheRead > 0) {
    lines.push(`Cache: ${Math.round(snapshot.tokens.cacheHitRate * 100)}% hit rate | saved ~$${snapshot.tokens.estimatedSavingsUsd.toFixed(2)}`);
  }

  lines.push('');

  // Agent table
  const hdr = pad('#', 3) + pad('Agent', 30) + pad('Status', 12) + pad('Findings', 10) + 'Duration';
  lines.push(`\x1b[4m${hdr}\x1b[0m`);

  for (const row of snapshot.agentRows) {
    const statusColor = row.status === 'complete' ? '\x1b[32m'
      : row.status === 'failed' ? '\x1b[31m'
      : row.status === 'running' ? '\x1b[33m'
      : '\x1b[90m';
    const findings = row.status === 'complete' ? String(row.findings) : '\u2014';
    const duration = row.durationMs > 0 ? `${Math.round(row.durationMs / 1000)}s` : '\u2014';

    lines.push(
      pad(String(row.index), 3)
      + pad(row.name, 30)
      + statusColor + pad(row.status.toUpperCase(), 12) + '\x1b[0m'
      + pad(findings, 10)
      + duration,
    );
  }

  lines.push('');
  const c = snapshot.agents;
  lines.push(`${c.complete} complete | ${c.running} running | ${c.failed} failed`);

  return lines.join('\n');
}

function main(): void {
  const snapshot = readSnapshot();
  if (!snapshot) {
    process.stderr.write('No active run found.\n');
    process.stderr.write(`Looking for: ${ACTIVE_RUN_PATH}\n`);
    process.exit(1);
  }

  if (WATCH_MODE) {
    const render = () => {
      const snap = readSnapshot();
      if (!snap) {
        process.stdout.write('\x1Bc'); // clear screen
        process.stdout.write('Run completed or no active run.\n');
        process.exit(0);
      }
      process.stdout.write('\x1Bc'); // clear screen
      process.stdout.write(renderSnapshot(snap) + '\n');
    };
    render();
    setInterval(render, POLL_MS);
  } else {
    process.stdout.write(renderSnapshot(snapshot) + '\n');
  }
}

main();
