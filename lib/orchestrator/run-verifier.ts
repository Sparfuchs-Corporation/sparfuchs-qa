// run-verifier — grade the run against preflight.expectations and emit
// run-quality.json. Phase 3 partial-run labeling in qa-report.md and
// qa-gaps.md reads this file.
//
// Philosophy: do not override the release-gate verdict. This is an
// adjacent honest-labeling signal — the operator sees whether the run
// hit its expected scale + telemetry targets, with remediation suggestions
// when it didn't, independent of the severity-based ship/block decision.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PreflightReport } from './preflight.js';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface QualityCheck {
  id: string;
  status: CheckStatus;
  observed: string | number;
  expected: string;
  cause?: string;
  remediation?: string;
}

export interface RunQualityReport {
  runId: string;
  projectSlug: string;
  generatedAt: string;
  passed: number;
  failed: number;
  total: number;
  passRatePercent: number;
  partialRun: boolean;
  checks: QualityCheck[];
}

export interface VerifyRunInput {
  runDir: string;
  projectSlug: string;
  runId: string;
}

export function verifyRun(input: VerifyRunInput): RunQualityReport | null {
  const preflight = loadJson<PreflightReport>(join(input.runDir, 'preflight.json'));
  if (!preflight) {
    // No preflight means legacy run or QA_PREFLIGHT issue; skip grading.
    return null;
  }
  const meta = loadJson<Record<string, unknown>>(join(input.runDir, 'meta.json'));
  const coverage = loadJson<Record<string, unknown>>(join(input.runDir, 'coverage-report.json'));
  const findings = loadJson<unknown[]>(join(input.runDir, 'findings-final.json')) ?? [];

  const checks: QualityCheck[] = [];
  const ex = preflight.expectations;

  // Coverage band
  const actualCoverage = asNumber(coverage?.actualPercent);
  const coverageInBand = actualCoverage !== null &&
    actualCoverage >= ex.coverageMinPercent &&
    actualCoverage <= ex.coverageMaxPercent;
  checks.push({
    id: 'coverage-in-band',
    status: actualCoverage === null ? 'skip' : (coverageInBand ? 'pass' : 'fail'),
    observed: actualCoverage ?? 'unavailable',
    expected: `${ex.coverageMinPercent}-${ex.coverageMaxPercent}`,
    cause: !coverageInBand && actualCoverage !== null
      ? diagnoseCoverageCause(actualCoverage, ex.coverageMinPercent, coverage)
      : undefined,
    remediation: !coverageInBand && actualCoverage !== null
      ? diagnoseCoverageRemediation(actualCoverage, ex.coverageMinPercent, coverage)
      : undefined,
  });

  // Per-agent telemetry. Category-aware: synthesis agents (qa-gap-analyzer,
  // release-gate-synthesizer) read findings JSON not source files — credit
  // them via findingsReadCount. Probe agents credit via probeCount.
  const byAgent = Array.isArray(coverage?.byAgent) ? coverage.byAgent as Record<string, unknown>[] : [];
  const hasAnyCategorySignal = (r: Record<string, unknown>): boolean =>
    (asNumber(r.filesExamined) ?? 0) > 0 ||
    (asNumber(r.findingsReadCount) ?? 0) > 0 ||
    (asNumber(r.probeCount) ?? 0) > 0;
  const zeroAgents = byAgent.filter(r => !hasAnyCategorySignal(r)).map(r => String(r.agent));
  const agentCountInMeta = Array.isArray(meta?.agents) ? (meta!.agents as unknown[]).length : 0;
  const agentsReportingFiles = byAgent.filter(hasAnyCategorySignal).length;
  checks.push({
    id: 'per-agent-telemetry',
    status: agentCountInMeta === 0
      ? 'skip'
      : (zeroAgents.length === 0 && agentsReportingFiles > 0 ? 'pass' : 'fail'),
    observed: `${agentsReportingFiles} / ${agentCountInMeta} reporting any work signal (files/probes/synthesis)`,
    expected: '>0 per agent (files, probes, or synthesis reads)',
    cause: zeroAgents.length > 0
      ? `${zeroAgents.length} agents reported zero work signal: ${zeroAgents.slice(0, 5).join(', ')}${zeroAgents.length > 5 ? '…' : ''}`
      : undefined,
    remediation: zeroAgents.length > 0
      ? 'confirm the universal extractToolCallsFromText fallback in agent-runner is running (stderr "recovered N entries" log), and verify adapters emit tool_use events'
      : undefined,
  });

  // Path format consistency
  const uncovered = Array.isArray(coverage?.uncoveredFiles) ? coverage.uncoveredFiles as string[] : [];
  const absoluteCount = uncovered.filter(p => p.startsWith('/')).length;
  const pathFormatOk = uncovered.length === 0 || absoluteCount === 0;
  checks.push({
    id: 'uncovered-files-relative',
    status: uncovered.length === 0 ? 'skip' : (pathFormatOk ? 'pass' : 'fail'),
    observed: pathFormatOk ? 'all relative' : `${absoluteCount} absolute / ${uncovered.length - absoluteCount} relative`,
    expected: 'all repo-relative',
    cause: pathFormatOk ? undefined : 'CoverageBabysitter was constructed without a repoPath arg, or helper enumerations returned mixed formats',
    remediation: pathFormatOk ? undefined : 'verify `new CoverageBabysitter(..., config.repoPath)` and that file-discovery is the single source of truth',
  });

  // Timeouts on light/mid
  const failedAgents = Array.isArray(meta?.agents) ? (meta!.agents as Record<string, unknown>[])
    .filter(a => a.status === 'failed') : [];
  const lightMidTimeouts = failedAgents.filter(a => {
    const err = String(a.error ?? '');
    const tier = String(a.tier ?? '');
    return /exceeded \d+s hard timeout/.test(err) && (tier === 'light' || tier === 'mid');
  });
  checks.push({
    id: 'light-mid-no-timeouts',
    status: lightMidTimeouts.length === 0 ? 'pass' : 'fail',
    observed: lightMidTimeouts.length === 0
      ? '0 timeouts on light/mid tier'
      : `${lightMidTimeouts.length} timeout(s): ${lightMidTimeouts.map(a => a.name ?? a.agentName).join(', ')}`,
    expected: '0 timeouts on light/mid tier',
    cause: lightMidTimeouts.length > 0
      ? 'agents defaulted to a tier with too-short a timeout for their workload'
      : undefined,
    remediation: lightMidTimeouts.length > 0
      ? `bump these agents to heavy tier in config/models.yaml agentOverrides: ${lightMidTimeouts.map(a => a.name ?? a.agentName).join(', ')}`
      : undefined,
  });

  // Findings density
  const totalFindings = findings.length;
  const findingsInBand = totalFindings >= ex.findingsTotalMin && totalFindings <= ex.findingsTotalMax;
  checks.push({
    id: 'findings-density-in-band',
    status: findingsInBand ? 'pass' : 'fail',
    observed: totalFindings,
    expected: `${ex.findingsTotalMin}-${ex.findingsTotalMax}`,
    cause: !findingsInBand
      ? totalFindings < ex.findingsTotalMin
        ? 'agents produced fewer findings than repo size suggests — possibly under-covered or agents ran shallowly'
        : 'finding count unusually high — possibly vendored / generated noise'
      : undefined,
    remediation: !findingsInBand
      ? totalFindings < ex.findingsTotalMin
        ? 'inspect per-agent coverage; increase strategy to thorough or exhaustive'
        : 'verify exclusion list covers vendored + generated code (see EXCLUDE_DIRS in file-discovery.ts)'
      : undefined,
  });

  // Prior-run gaps healed (only when carryoverGaps existed).
  // Heal jobs dispatch with label `<agent>-heal` to avoid clobbering the
  // primary agent's session log, so coverage-report.json records them under
  // that suffixed key. Match either name so the check credits both paths.
  if (preflight.healJobs.length > 0) {
    const healed = preflight.healJobs.filter(j => {
      const row = byAgent.find(r => r.agent === j.agentName || r.agent === `${j.agentName}-heal`);
      return !!row && (asNumber(row.filesExamined) ?? 0) > 0;
    });
    checks.push({
      id: 'prior-gaps-healed',
      status: healed.length === preflight.healJobs.length ? 'pass' : 'fail',
      observed: `${healed.length} / ${preflight.healJobs.length} heal jobs produced file coverage`,
      expected: `${preflight.healJobs.length} / ${preflight.healJobs.length}`,
      cause: healed.length < preflight.healJobs.length
        ? `heal jobs that still produced zero coverage: ${preflight.healJobs.filter(j => !healed.includes(j)).map(j => j.agentName).join(', ')}`
        : undefined,
      remediation: healed.length < preflight.healJobs.length
        ? 'inspect the heal agent output; the tier override may still be insufficient, or the agent is broken at HEAD'
        : undefined,
    });
  }

  const passed = checks.filter(c => c.status === 'pass').length;
  const failed = checks.filter(c => c.status === 'fail').length;
  const total = checks.length;
  const passRatePercent = total > 0 ? Math.round((passed / total) * 100) : 100;

  const report: RunQualityReport = {
    runId: input.runId,
    projectSlug: input.projectSlug,
    generatedAt: new Date().toISOString(),
    passed,
    failed,
    total,
    passRatePercent,
    partialRun: failed > 0,
    checks,
  };

  try {
    writeFileSync(join(input.runDir, 'run-quality.json'), JSON.stringify(report, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[run-verifier] failed to write run-quality.json: ${msg}\n`);
  }
  return report;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

function diagnoseCoverageCause(
  actual: number,
  min: number,
  coverage: Record<string, unknown> | null,
): string {
  if (actual >= min) return '';
  const uncovered = Array.isArray(coverage?.uncoveredFiles) ? coverage.uncoveredFiles as string[] : [];
  const venvCount = uncovered.filter(p => p.includes('/.venv/') || p.includes('/venv/')).length;
  if (venvCount > uncovered.length * 0.2) {
    return `file discovery enumerated ${venvCount} vendored Python files (.venv/**) — 20%+ of the uncovered set`;
  }
  const nodeModsCount = uncovered.filter(p => p.includes('/node_modules/')).length;
  if (nodeModsCount > 0) {
    return `file discovery enumerated ${nodeModsCount} node_modules files`;
  }
  return `actual coverage ${actual}% below expected floor ${min}%`;
}

function diagnoseCoverageRemediation(
  actual: number,
  min: number,
  coverage: Record<string, unknown> | null,
): string {
  if (actual >= min) return '';
  const uncovered = Array.isArray(coverage?.uncoveredFiles) ? coverage.uncoveredFiles as string[] : [];
  const venvCount = uncovered.filter(p => p.includes('/.venv/') || p.includes('/venv/')).length;
  if (venvCount > 0) {
    return 'add .venv / venv to EXCLUDE_DIRS (lib/orchestrator/file-discovery.ts) and re-run';
  }
  if (uncovered.some(p => p.includes('/node_modules/'))) {
    return 'verify node_modules is in EXCLUDE_DIRS; re-run';
  }
  return 'raise coverageStrategy to thorough (or exhaustive) via QA_COVERAGE_STRATEGY env var';
}
