/**
 * qa-delta-report — Compare QA findings across runs
 *
 * Usage:
 *   npx tsx scripts/qa-delta-report.ts --project the-forge
 *   npx tsx scripts/qa-delta-report.ts --project the-forge --run qa-20260404-0800-ab12
 *   npx tsx scripts/qa-delta-report.ts --project the-forge --output delta.md
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { QaFinding, RunDelta, QaRunMeta } from '../lib/types.js';

const QA_DATA_ROOT = join(import.meta.dirname, '..', 'qa-data');

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

function getLatestRunId(projectSlug: string): string | null {
  const runsDir = join(QA_DATA_ROOT, projectSlug, 'runs');
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir).filter((d) => d.startsWith('qa-')).sort().reverse();
  return runs[0] ?? null;
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function main() {
  const { project, runId, output } = parseArgs();
  const targetRunId = runId ?? getLatestRunId(project);

  if (!targetRunId) {
    console.error(`No runs found for project "${project}" in qa-data/`);
    process.exit(1);
  }

  const runDir = join(QA_DATA_ROOT, project, 'runs', targetRunId);
  const delta = loadJson<RunDelta>(join(runDir, 'delta.json'));
  const meta = loadJson<QaRunMeta>(join(runDir, 'meta.json'));
  const findings = loadJson<QaFinding[]>(join(runDir, 'findings-final.json')) ?? [];
  const baseline = loadJson<QaFinding[]>(join(QA_DATA_ROOT, project, 'current-baseline.json')) ?? [];

  const findingMap = new Map(findings.map((f) => [f.id, f]));
  const baselineMap = new Map(baseline.map((f) => [f.id, f]));

  const lines: string[] = [];
  lines.push(`# Delta Report — ${project}`);
  lines.push('');
  lines.push(`**Run**: ${targetRunId}`);
  if (meta) {
    lines.push(`**Date**: ${meta.startedAt}`);
    lines.push(`**Mode**: ${meta.mode}`);
    lines.push(`**Verdict**: ${meta.verdict}`);
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

  if (output) {
    const { writeFileSync } = require('node:fs');
    writeFileSync(output, report);
    console.log(`Delta report written to ${output}`);
  } else {
    console.log(report);
  }
}

main();
