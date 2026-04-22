/**
 * qa-delta-report — Compare QA findings across runs
 *
 * Library usage (from orchestrator finalizer):
 *   import { generateDeltaReport } from './qa-delta-report.js';
 *   generateDeltaReport({ projectSlug, runId, outPath: join(runDir, 'delta-report.md') });
 *
 * CLI usage:
 *   npx tsx scripts/qa-delta-report.ts --project the-forge
 *   npx tsx scripts/qa-delta-report.ts --project the-forge --run qa-20260404-0800-ab12
 *   npx tsx scripts/qa-delta-report.ts --project the-forge --output delta.md
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QaFinding, RunDelta, QaRunMeta } from '../lib/types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_QA_DATA_ROOT = join(MODULE_DIR, '..', 'qa-data');

export interface GenerateDeltaReportOptions {
  projectSlug: string;
  runId: string;
  outPath?: string;
  qaDataRoot?: string;
}

export interface DeltaReportResult {
  report: string;
  outPath?: string;
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getLatestRunId(projectSlug: string, qaDataRoot: string): string | null {
  const runsDir = join(qaDataRoot, projectSlug, 'runs');
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir).filter((d) => d.startsWith('qa-')).sort().reverse();
  return runs[0] ?? null;
}

export function generateDeltaReport(opts: GenerateDeltaReportOptions): DeltaReportResult {
  const qaDataRoot = opts.qaDataRoot ?? DEFAULT_QA_DATA_ROOT;
  const runDir = join(qaDataRoot, opts.projectSlug, 'runs', opts.runId);
  const delta = loadJson<RunDelta>(join(runDir, 'delta.json'));
  const meta = loadJson<QaRunMeta>(join(runDir, 'meta.json'));
  const findings = loadJson<QaFinding[]>(join(runDir, 'findings-final.json')) ?? [];
  const baseline = loadJson<QaFinding[]>(join(qaDataRoot, opts.projectSlug, 'current-baseline.json')) ?? [];

  const findingMap = new Map(findings.map((f) => [f.id, f]));
  const baselineMap = new Map(baseline.map((f) => [f.id, f]));

  const lines: string[] = [];
  lines.push(`# Delta Report — ${opts.projectSlug}`);
  lines.push('');
  lines.push(`**Run**: ${opts.runId}`);
  if (meta) {
    lines.push(`**Date**: ${meta.startedAt}`);
    lines.push(`**Mode**: ${meta.mode}`);
    if (meta.verdict) lines.push(`**Verdict**: ${meta.verdict}`);
  }
  lines.push('');

  if (!delta) {
    lines.push('No delta available — this may be the first run.');
  } else {
    lines.push(`**Previous run**: ${delta.previousRunId}`);
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|---|---|');
    lines.push(`| New findings | ${delta.newFindings.length} |`);
    lines.push(`| Recurring | ${delta.recurringFindings.length} |`);
    lines.push(`| Remediated | ${delta.remediatedFindings.length} |`);
    lines.push(`| Closure rate | ${delta.closureRate}% |`);
    lines.push('');

    if (delta.remediatedFindings.length > 0) {
      lines.push('## Remediated');
      for (const id of delta.remediatedFindings) {
        const f = baselineMap.get(id);
        if (f) lines.push(`- ~~[${f.category}] \`${f.file}:${f.line ?? '?'}\` — ${f.title}~~ FIXED`);
      }
      lines.push('');
    }

    if (delta.newFindings.length > 0) {
      lines.push('## New');
      for (const id of delta.newFindings) {
        const f = findingMap.get(id);
        if (f) lines.push(`- [${f.severity}] [${f.category}] \`${f.file}:${f.line ?? '?'}\` — ${f.title}`);
      }
      lines.push('');
    }

    if (delta.recurringFindings.length > 0) {
      lines.push('## Recurring');
      for (const id of delta.recurringFindings) {
        const f = findingMap.get(id);
        if (f) lines.push(`- [${f.severity}] [${f.category}] \`${f.file}:${f.line ?? '?'}\` — ${f.title}`);
      }
      lines.push('');
    }
  }

  const report = lines.join('\n');

  if (opts.outPath) {
    writeFileSync(opts.outPath, report);
  }

  return { report, outPath: opts.outPath };
}

// --- CLI entry point ---

function parseArgs(): { project: string; runId?: string; output?: string } {
  const args = process.argv.slice(2);
  let project = '';
  let runId: string | undefined;
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) project = args[++i];
    if (args[i] === '--run' && args[i + 1]) runId = args[++i];
    if (args[i] === '--output' && args[i + 1]) output = args[++i];
  }

  if (!project) {
    console.error('Usage: npx tsx scripts/qa-delta-report.ts --project <slug> [--run <id>] [--output <path>]');
    process.exit(1);
  }
  return { project, runId, output };
}

function main() {
  const { project, runId, output } = parseArgs();
  const targetRunId = runId ?? getLatestRunId(project, DEFAULT_QA_DATA_ROOT);

  if (!targetRunId) {
    console.error(`No runs found for project "${project}" in qa-data/`);
    process.exit(1);
  }

  const { report } = generateDeltaReport({
    projectSlug: project,
    runId: targetRunId,
    outPath: output,
  });

  if (output) {
    console.log(`Delta report written to ${output}`);
  } else {
    console.log(report);
  }
}

// Run main only when executed directly, not when imported as a module.
const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirect) {
  main();
}
