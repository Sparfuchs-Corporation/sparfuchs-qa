/**
 * qa-markdown-reports — Deterministic markdown generators for guaranteed final reports.
 *
 * Each generator compiles from the structured JSON artifacts produced by the
 * orchestrator finalizer (findings-final.json, delta.json, meta.json) and
 * optionally folds in richer narrative output from the relevant agent (when the
 * agent ran and its session-log markdown exists).
 *
 * These are the documented exception to the JSON-only agent-ingestion rule:
 * they are human-facing, intentionally markdown.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QaFinding, RunDelta, FindingSeverity } from '../lib/types.js';

// --- Observability dimensions (mirrors .claude/agents/observability-auditor.md) ---
// The 12 dimensions the auditor enumerates. Categories on findings from that
// agent are expected to land in one of these buckets; unmatched findings go to
// "other".
const OBSERVABILITY_DIMENSIONS = [
  'logging',
  'errors',
  'metrics',
  'tracing',
  'health',
  'alerting',
  'audit-events',
  'log-tiers',
  'security-events',
  'enrichment',
  'business-metrics',
  'compliance-trail',
] as const;

const OBSERVABILITY_CATEGORY_ALIASES: Record<string, (typeof OBSERVABILITY_DIMENSIONS)[number]> = {
  'log': 'logging',
  'logging': 'logging',
  'error-handling': 'errors',
  'errors': 'errors',
  'metric': 'metrics',
  'metrics': 'metrics',
  'trace': 'tracing',
  'tracing': 'tracing',
  'health-check': 'health',
  'health': 'health',
  'alert': 'alerting',
  'alerting': 'alerting',
  'audit': 'audit-events',
  'audit-events': 'audit-events',
  'audit-log': 'audit-events',
  'log-tier': 'log-tiers',
  'log-tiers': 'log-tiers',
  'security': 'security-events',
  'security-event': 'security-events',
  'security-events': 'security-events',
  'enrichment': 'enrichment',
  'business': 'business-metrics',
  'business-metric': 'business-metrics',
  'business-metrics': 'business-metrics',
  'compliance': 'compliance-trail',
  'compliance-trail': 'compliance-trail',
};

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

// Human-readable duration: '2h 1m 33s', '45s', '3m 4s'. Drops leading zero units.
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || h > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// Locate the session-log markdown that a given agent wrote. Session logs are
// named `${HH-MM-SS}_${agentLabel}.md` in sessionLogDir. When multiple exist
// (retries / chunks), prefer the most recent.
function findAgentSessionLog(sessionLogDir: string, agentName: string): string | null {
  if (!existsSync(sessionLogDir)) return null;
  try {
    const matches = readdirSync(sessionLogDir)
      .filter((f) => f.endsWith('.md') && f.includes(`_${agentName}`))
      .sort()
      .reverse();
    return matches.length > 0 ? join(sessionLogDir, matches[0]) : null;
  } catch {
    return null;
  }
}

function readIfExists(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

// --- qa-report.md ---
// Top-level run synthesis. If release-gate-synthesizer ran and wrote markdown
// into the session log, prepend its verdict block; otherwise fall back to a
// deterministic summary compiled from meta + findings.
export interface GenerateQaReportInput {
  runDir: string;
  sessionLogDir: string;
  projectSlug: string;
  runId: string;
  outPath: string;
}

export function generateQaReport(input: GenerateQaReportInput): void {
  const findings = loadJson<QaFinding[]>(join(input.runDir, 'findings-final.json')) ?? [];
  const delta = loadJson<RunDelta>(join(input.runDir, 'delta.json'));
  const meta = loadJson<Record<string, unknown>>(join(input.runDir, 'meta.json')) ?? {};

  const lines: string[] = [];
  lines.push(`# QA Report — ${input.projectSlug}`);
  lines.push('');
  lines.push(`**Run**: ${input.runId}`);

  const startedAtUtc = typeof meta.startedAt === 'string' ? meta.startedAt : null;
  const completedAtUtc = typeof meta.completedAt === 'string' ? meta.completedAt : null;
  const startedAtLocal = typeof meta.startedAtLocal === 'string' ? meta.startedAtLocal : null;
  const completedAtLocal = typeof meta.completedAtLocal === 'string' ? meta.completedAtLocal : null;

  if (startedAtUtc) {
    lines.push(startedAtLocal
      ? `**Started**: ${startedAtLocal}  (UTC: ${startedAtUtc})`
      : `**Started**: ${startedAtUtc}`);
  }
  if (completedAtUtc) {
    lines.push(completedAtLocal
      ? `**Completed**: ${completedAtLocal}  (UTC: ${completedAtUtc})`
      : `**Completed**: ${completedAtUtc}`);
  }
  if (startedAtUtc && completedAtUtc) {
    const durationMs = Date.parse(completedAtUtc) - Date.parse(startedAtUtc);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      lines.push(`**Duration**: ${formatDuration(durationMs)}`);
    }
  }

  if (typeof meta.mode === 'string') lines.push(`**Mode**: ${meta.mode}`);
  if (typeof meta.status === 'string') lines.push(`**Status**: ${meta.status}`);
  if (typeof meta.isGitRepo === 'boolean') {
    lines.push(`**Git-backed target**: ${meta.isGitRepo ? 'yes' : 'NO — no VCS backup for this run'}`);
  }
  lines.push('');

  // Run-quality labeling (Phase 3). Prepends a PARTIAL / PASS block above
  // the Release-Gate Verdict so the operator sees honest signal before
  // severity-based ship/block guidance. Adjacent to — not overriding —
  // the release gate.
  const runQuality = loadJson<{
    passed: number; failed: number; total: number; passRatePercent: number;
    partialRun: boolean; checks: Array<{ id: string; status: string; observed: unknown; expected: string }>;
  }>(join(input.runDir, 'run-quality.json'));
  if (runQuality) {
    if (runQuality.partialRun) {
      lines.push(`## Run Quality — PARTIAL`);
      lines.push('');
      lines.push(
        `This was a **partial** run. ${runQuality.failed} of ${runQuality.total} ` +
        `preflight criteria missed (${runQuality.passRatePercent}% pass rate).`,
      );
      lines.push('');
      for (const c of runQuality.checks) {
        if (c.status !== 'fail') continue;
        lines.push(`- **${c.id}**: observed \`${c.observed}\`, expected \`${c.expected}\``);
      }
      lines.push('');
      lines.push('**See qa-gaps.md § Run Quality Deficit for causes and remediation.**');
      lines.push('');
    } else {
      lines.push(`## Run Quality — PASS (${runQuality.passed}/${runQuality.total} criteria)`);
      lines.push('');
    }
  }

  // Fold in release-gate-synthesizer verdict if available.
  const gateOutput = readIfExists(findAgentSessionLog(input.sessionLogDir, 'release-gate-synthesizer'));
  if (gateOutput) {
    lines.push('## Release-Gate Verdict');
    lines.push('');
    lines.push(gateOutput.trim());
    lines.push('');
  }

  // Findings summary
  const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byAgent = new Map<string, QaFinding[]>();
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    const list = byAgent.get(f.agent) ?? [];
    list.push(f);
    byAgent.set(f.agent, list);
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  lines.push(`| critical | ${bySeverity.critical ?? 0} |`);
  lines.push(`| high | ${bySeverity.high ?? 0} |`);
  lines.push(`| medium | ${bySeverity.medium ?? 0} |`);
  lines.push(`| low | ${bySeverity.low ?? 0} |`);
  lines.push(`| **total** | **${findings.length}** |`);
  lines.push('');

  if (delta) {
    lines.push('## Delta vs. previous run');
    lines.push('');
    lines.push(`- Previous run: \`${delta.previousRunId}\``);
    lines.push(`- New: ${delta.newFindings.length}`);
    lines.push(`- Recurring: ${delta.recurringFindings.length}`);
    lines.push(`- Remediated: ${delta.remediatedFindings.length}`);
    lines.push(`- Closure rate: ${delta.closureRate}%`);
    lines.push(`- Regression rate: ${delta.regressionRate}%`);
    lines.push('');
  }

  if (typeof meta.coverage === 'object' && meta.coverage !== null) {
    const c = meta.coverage as Record<string, unknown>;
    lines.push('## Coverage');
    lines.push('');
    if (typeof c.strategy === 'string') lines.push(`- Strategy: \`${c.strategy}\``);
    if (typeof c.targetPercent === 'number') lines.push(`- Target: ${c.targetPercent}%`);
    if (typeof c.actualPercent === 'number') lines.push(`- Actual: ${c.actualPercent}%`);
    if (typeof c.filesExamined === 'number' && typeof c.filesTotal === 'number') {
      lines.push(`- Files examined: ${c.filesExamined} / ${c.filesTotal}`);
    }
    lines.push('');
  }

  if (byAgent.size > 0) {
    lines.push('## Findings by agent');
    lines.push('');
    const agentNames = [...byAgent.keys()].sort();
    for (const agent of agentNames) {
      const list = byAgent.get(agent)!;
      lines.push(`### ${agent} (${list.length})`);
      lines.push('');
      const sorted = [...list].sort(
        (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
      );
      for (const f of sorted) {
        const loc = `${f.file}${f.line ? `:${f.line}` : ''}`;
        lines.push(`- **[${f.severity}]** \`${loc}\` — ${f.title}`);
      }
      lines.push('');
    }
  }

  const finalizationErrors = Array.isArray(meta.finalizationErrors) ? meta.finalizationErrors : [];
  if (finalizationErrors.length > 0) {
    lines.push('## Finalization errors (degraded report)');
    lines.push('');
    for (const e of finalizationErrors as Array<{ step?: string; error?: string }>) {
      lines.push(`- \`${e.step ?? 'unknown-step'}\`: ${e.error ?? 'unknown error'}`);
    }
    lines.push('');
  }

  writeFileSync(input.outPath, lines.join('\n'));
}

// --- remediation-plan.md ---
export interface GenerateRemediationPlanInput {
  runDir: string;
  projectSlug: string;
  runId: string;
  outPath: string;
}

export function generateRemediationPlan(input: GenerateRemediationPlanInput): void {
  const findings = loadJson<QaFinding[]>(join(input.runDir, 'findings-final.json')) ?? [];
  const delta = loadJson<RunDelta>(join(input.runDir, 'delta.json'));

  const lines: string[] = [];
  lines.push(`# Remediation Plan — ${input.projectSlug}`);
  lines.push('');
  lines.push(`**Run**: ${input.runId}`);
  lines.push(`**Open findings**: ${findings.length}`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('No open findings in this run.');
    lines.push('');
  } else {
    // Group by file, severity desc within file.
    const byFile = new Map<string, QaFinding[]>();
    for (const f of findings) {
      const key = f.file || 'unknown';
      const list = byFile.get(key) ?? [];
      list.push(f);
      byFile.set(key, list);
    }

    // File order: highest-severity finding first, then alphabetical.
    const fileOrder = [...byFile.keys()].sort((a, b) => {
      const aMax = Math.max(...byFile.get(a)!.map((f) => SEVERITY_RANK[f.severity] ?? 0));
      const bMax = Math.max(...byFile.get(b)!.map((f) => SEVERITY_RANK[f.severity] ?? 0));
      if (aMax !== bMax) return bMax - aMax;
      return a.localeCompare(b);
    });

    for (const file of fileOrder) {
      lines.push(`## \`${file}\``);
      lines.push('');
      const sorted = [...byFile.get(file)!].sort(
        (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
      );
      for (const f of sorted) {
        const loc = f.line ? `:${f.line}` : '';
        lines.push(`### [${f.severity}] [${f.category}] ${f.title}`);
        lines.push('');
        lines.push(`- **Location**: \`${f.file}${loc}\``);
        lines.push(`- **Rule**: \`${f.rule}\``);
        lines.push(`- **Agent**: ${f.agent}`);
        if (f.description) {
          lines.push(`- **Description**: ${f.description}`);
        }
        if (f.fix) {
          lines.push('- **Recommended fix**:');
          lines.push('');
          for (const fixLine of f.fix.split('\n')) {
            lines.push(`  > ${fixLine}`);
          }
        }
        lines.push('');
      }
    }
  }

  if (delta && delta.remediatedFindings.length > 0) {
    lines.push('## Known-remediated in this run');
    lines.push('');
    lines.push(
      `${delta.remediatedFindings.length} finding(s) from the previous run did not recur. ` +
        'Finding IDs:',
    );
    lines.push('');
    for (const id of delta.remediatedFindings) {
      lines.push(`- \`${id}\``);
    }
    lines.push('');
  }

  writeFileSync(input.outPath, lines.join('\n'));
}

// --- observability-gaps.md ---
function normalizeObservabilityCategory(category: string): string | null {
  const key = category.toLowerCase().trim();
  if (OBSERVABILITY_CATEGORY_ALIASES[key]) return OBSERVABILITY_CATEGORY_ALIASES[key];
  for (const alias of Object.keys(OBSERVABILITY_CATEGORY_ALIASES)) {
    if (key.includes(alias)) return OBSERVABILITY_CATEGORY_ALIASES[alias];
  }
  return null;
}

export interface GenerateObservabilityGapsInput {
  runDir: string;
  sessionLogDir: string;
  projectSlug: string;
  runId: string;
  outPath: string;
}

export function generateObservabilityGaps(input: GenerateObservabilityGapsInput): void {
  const findings = loadJson<QaFinding[]>(join(input.runDir, 'findings-final.json')) ?? [];

  const relevant = findings.filter((f) => {
    if (f.agent === 'observability-auditor') return true;
    return normalizeObservabilityCategory(f.category) !== null;
  });

  const byDimension = new Map<string, QaFinding[]>();
  const other: QaFinding[] = [];
  for (const f of relevant) {
    const dim = normalizeObservabilityCategory(f.category);
    if (dim) {
      const list = byDimension.get(dim) ?? [];
      list.push(f);
      byDimension.set(dim, list);
    } else {
      other.push(f);
    }
  }

  const lines: string[] = [];
  lines.push(`# Observability Gaps — ${input.projectSlug}`);
  lines.push('');
  lines.push(`**Run**: ${input.runId}`);
  lines.push(`**Findings in scope**: ${relevant.length} (out of ${findings.length} total)`);
  lines.push('');

  const auditorOutput = readIfExists(findAgentSessionLog(input.sessionLogDir, 'observability-auditor'));
  if (!auditorOutput) {
    lines.push(
      '> The `observability-auditor` agent did not run or produced no session log. ' +
        'This report is compiled from any findings tagged to observability dimensions.',
    );
    lines.push('');
  }

  if (relevant.length === 0) {
    lines.push('No observability gaps surfaced in this run.');
    lines.push('');
  } else {
    for (const dim of OBSERVABILITY_DIMENSIONS) {
      const list = byDimension.get(dim);
      if (!list || list.length === 0) continue;
      lines.push(`## ${dim} (${list.length})`);
      lines.push('');
      const sorted = [...list].sort(
        (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
      );
      for (const f of sorted) {
        const loc = `${f.file}${f.line ? `:${f.line}` : ''}`;
        lines.push(`- **[${f.severity}]** \`${loc}\` — ${f.title}`);
        if (f.description) lines.push(`  - ${f.description}`);
      }
      lines.push('');
    }
    if (other.length > 0) {
      lines.push(`## other (${other.length})`);
      lines.push('');
      lines.push(
        'Findings attributed to `observability-auditor` but not mapping to one of the 12 dimensions:',
      );
      lines.push('');
      for (const f of other) {
        const loc = `${f.file}${f.line ? `:${f.line}` : ''}`;
        lines.push(`- **[${f.severity}]** [${f.category}] \`${loc}\` — ${f.title}`);
      }
      lines.push('');
    }
  }

  if (auditorOutput) {
    lines.push('---');
    lines.push('');
    lines.push('## Auditor narrative');
    lines.push('');
    lines.push(auditorOutput.trim());
    lines.push('');
  }

  writeFileSync(input.outPath, lines.join('\n'));
}

// --- qa-gaps.md ---
// Promotes the qa-gap-analyzer agent's session-log output to a top-level
// artifact. If the agent did not run, emits a deterministic stub listing
// failed/skipped agents.
export interface GenerateQaGapsInput {
  runDir: string;
  sessionLogDir: string;
  projectSlug: string;
  runId: string;
  outPath: string;
  failedAgents: Array<{ name: string; error: string | null }>;
  skippedAgents: Array<{ name: string; reason: string | null }>;
}

export function generateQaGaps(input: GenerateQaGapsInput): void {
  const analyzerOutput = readIfExists(findAgentSessionLog(input.sessionLogDir, 'qa-gap-analyzer'));

  const lines: string[] = [];
  lines.push(`# QA Gaps — ${input.projectSlug}`);
  lines.push('');
  lines.push(`**Run**: ${input.runId}`);
  lines.push('');

  // Run Quality Deficit (Phase 3). Leads the document when the preflight's
  // scale-adaptive expectations weren't met — failed checks with cause +
  // remediation strings come straight from run-verifier.
  const runQuality = loadJson<{
    passed: number; failed: number; total: number;
    checks: Array<{ id: string; status: string; observed: unknown; expected: string; cause?: string; remediation?: string }>;
  }>(join(input.runDir, 'run-quality.json'));
  if (runQuality && runQuality.failed > 0) {
    lines.push('## Run Quality Deficit');
    lines.push('');
    lines.push(
      `${runQuality.failed} of ${runQuality.total} preflight criteria missed. ` +
      'Each failing check below names what was observed, what was expected, ' +
      'and — where the pattern is known — a concrete remediation.',
    );
    lines.push('');
    for (const c of runQuality.checks) {
      if (c.status !== 'fail') continue;
      lines.push(`### ${c.id}`);
      lines.push('');
      lines.push(`- **Observed**: \`${String(c.observed)}\``);
      lines.push(`- **Expected**: \`${c.expected}\``);
      if (c.cause) lines.push(`- **Cause**: ${c.cause}`);
      if (c.remediation) lines.push(`- **Remediation**: ${c.remediation}`);
      lines.push('');
    }
  }

  if (analyzerOutput) {
    lines.push(analyzerOutput.trim());
    lines.push('');
  } else {
    lines.push(
      '> The `qa-gap-analyzer` agent did not run or produced no session-log output. ' +
        'The deterministic fallback below lists agents that failed or were skipped.',
    );
    lines.push('');

    if (input.failedAgents.length === 0 && input.skippedAgents.length === 0) {
      lines.push('No failed or skipped agents in this run.');
      lines.push('');
    } else {
      if (input.failedAgents.length > 0) {
        lines.push(`## Failed agents (${input.failedAgents.length})`);
        lines.push('');
        for (const a of input.failedAgents) {
          lines.push(`- **${a.name}** — ${a.error ?? 'unknown error'}`);
        }
        lines.push('');
      }
      if (input.skippedAgents.length > 0) {
        lines.push(`## Skipped agents (${input.skippedAgents.length})`);
        lines.push('');
        for (const a of input.skippedAgents) {
          lines.push(`- **${a.name}** — ${a.reason ?? 'no reason recorded'}`);
        }
        lines.push('');
      }
    }
  }

  writeFileSync(input.outPath, lines.join('\n'));
}
