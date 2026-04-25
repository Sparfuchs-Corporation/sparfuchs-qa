// preflight — repo census + plan preview + scale-adaptive success criteria +
// prior-run gap detection + interactive 3-way gap-healing gate.
//
// Called after scanTestability() and before buildChunkPlan() so operators
// see what the orchestrator is about to do — and what "good" looks like —
// before spending 45-90 minutes of agent wall-clock on a run that might be
// misconfigured.
//
// Outputs preflight.json into the run directory; Phase 3's run-verifier
// reads it to grade the actual run afterwards.

import * as readline from 'node:readline';
import { existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import type {
  AgentDefinition, ChunkPlan, CoverageStrategy,
  OrchestrationConfig,
} from './types.js';
import { isChunkedAgent } from './chunker.js';
import { buildGapHealingPlan, type CarryoverGap, type GapHealingJob } from './gap-healer.js';

// --- Types ---

export interface RepoCensus {
  sourceFileCount: number;
  filesByLanguage: Record<string, number>;
  filesByTopLevel: Record<string, number>;
  checkabilityPercent: number;
  uncheckableCount: number;
}

export interface PlanPreview {
  mode: string;
  coverageStrategy: CoverageStrategy;
  targetCoveragePercent: number;
  agentCount: number;
  chunkedAgents: readonly string[];
  chunkCount: number;
  avgFilesPerChunk: number;
  estRuntimeMsMin: number;
  estRuntimeMsMax: number;
}

export interface SuccessCriteria {
  coverageMinPercent: number;
  coverageMaxPercent: number;
  filesExaminedMin: number;
  filesExaminedMax: number;
  perChunkedAgentFilesMin: number;
  findingsTotalMin: number;
  findingsTotalMax: number;
  perAgentTelemetryPositive: true;  // binary — expect >0 on every agent
  uncoveredFilesAllRelative: true;  // binary — expect single path format
  lightMidTimeoutsZero: true;       // binary — heavy tier allowed
  runtimeMsMin: number;
  runtimeMsMax: number;
}

export interface PreflightReport {
  runId: string;
  projectSlug: string;
  generatedAt: string;
  repoPath: string;
  mode: string;
  census: RepoCensus;
  plan: PlanPreview;
  expectations: SuccessCriteria;
  priorRun: { runId: string | null; ageSeconds: number | null };
  carryoverGaps: CarryoverGap[];
  gapHealDecision: 'auto' | 'report' | 'fail' | null;
  healJobs: GapHealingJob[];  // non-empty only when gapHealDecision === 'auto'
  proceed: boolean;
}

export interface PreflightInput {
  config: OrchestrationConfig;
  agents: readonly AgentDefinition[];
  allSourceFiles: readonly string[];
  chunkPlan: ChunkPlan | null;
  strategy: CoverageStrategy;
  targetCoveragePercent: number;
  runDir: string;
  testabilityCheckabilityPercent: number;
  testabilityUncheckableCount: number;
  // Agents the testability-scanner marked as ineffective for this repo
  // (e.g., no React → skip a11y-reviewer). gap-healer filters gaps that
  // name one of these so the operator doesn't see "heal schema-migration-
  // reviewer" for a repo with no DB schemas.
  agentsToSkip?: ReadonlySet<string>;
}

// --- Execute ---

export async function runPreflight(input: PreflightInput): Promise<PreflightReport> {
  const census = buildCensus(input);
  const plan = buildPlanPreview(input);
  const expectations = computeExpectations(census, plan);
  const { runId: priorRunId, ageSeconds, metaPath, coveragePath } =
    locatePriorRun(input.config.qaDataRoot, input.config.projectSlug, input.config.runId);
  const carryoverGaps = buildGapHealingPlan({
    priorMetaPath: metaPath,
    priorCoveragePath: coveragePath,
    currentAgents: input.agents.map(a => a.name),
    currentSourceFiles: input.allSourceFiles,
    agentsToSkip: input.agentsToSkip,
  });

  const report: PreflightReport = {
    runId: input.config.runId,
    projectSlug: input.config.projectSlug,
    generatedAt: new Date().toISOString(),
    repoPath: input.config.repoPath,
    mode: input.config.mode,
    census,
    plan,
    expectations,
    priorRun: { runId: priorRunId, ageSeconds },
    carryoverGaps: carryoverGaps.gaps,
    gapHealDecision: null,
    healJobs: [],
    proceed: false,
  };

  const skip = process.env.QA_PREFLIGHT === 'skip';
  if (skip) {
    report.gapHealDecision = 'report';
    report.proceed = true;
    writeReport(input.runDir, report);
    printSummary(report, { interactive: false });
    return report;
  }

  // Interactive gate
  printSummary(report, { interactive: true });
  const gapChoice = await askGapHealing(report, carryoverGaps.gaps.length > 0);
  report.gapHealDecision = gapChoice;
  if (gapChoice === 'auto') {
    report.healJobs = carryoverGaps.jobs;
  }
  if (gapChoice === 'fail') {
    // Write remediation script, decline to proceed.
    writeRemediationScript(input.runDir, input.config, carryoverGaps.jobs);
    report.proceed = false;
    writeReport(input.runDir, report);
    return report;
  }

  const go = await askProceed();
  report.proceed = go;
  writeReport(input.runDir, report);
  return report;
}

// --- Census ---

function buildCensus(input: PreflightInput): RepoCensus {
  const byLang: Record<string, number> = {};
  const byTop: Record<string, number> = {};
  for (const abs of input.allSourceFiles) {
    const ext = extensionOf(abs);
    byLang[ext] = (byLang[ext] ?? 0) + 1;
    const top = topLevelOf(input.config.repoPath, abs);
    byTop[top] = (byTop[top] ?? 0) + 1;
  }
  return {
    sourceFileCount: input.allSourceFiles.length,
    filesByLanguage: byLang,
    filesByTopLevel: byTop,
    checkabilityPercent: input.testabilityCheckabilityPercent,
    uncheckableCount: input.testabilityUncheckableCount,
  };
}

function extensionOf(abs: string): string {
  const dot = abs.lastIndexOf('.');
  if (dot < 0) return 'other';
  const ext = abs.slice(dot + 1);
  if (/^[a-z]+$/i.test(ext) && ext.length <= 5) return ext.toLowerCase();
  return 'other';
}

function topLevelOf(repoPath: string, abs: string): string {
  const rel = relative(repoPath, abs);
  const seg = rel.split('/')[0] ?? '(root)';
  return seg.length > 0 ? seg : '(root)';
}

// --- Plan preview ---

function buildPlanPreview(input: PreflightInput): PlanPreview {
  const chunkedAgents = input.agents.map(a => a.name).filter(isChunkedAgent);
  const chunkCount = input.chunkPlan?.chunks.length ?? 0;
  const avgFilesPerChunk = chunkCount > 0
    ? Math.round((input.chunkPlan?.checkableFiles ?? 0) / chunkCount)
    : input.allSourceFiles.length;

  // Rough wall-clock bands: lower bound = 30s/agent (best case),
  // upper bound = agents × mid-tier budget × 0.7 concurrency factor.
  const TIER_MINUTES = { light: 8, mid: 15, heavy: 25 };
  const weightedMins = input.agents.reduce((sum, a) => sum + (TIER_MINUTES[a.tier] ?? 15), 0);
  const estRuntimeMsMin = input.agents.length * 30_000;
  const estRuntimeMsMax = Math.round(weightedMins * 60_000 * 0.7);

  return {
    mode: input.config.mode,
    coverageStrategy: input.strategy,
    targetCoveragePercent: input.targetCoveragePercent,
    agentCount: input.agents.length,
    chunkedAgents,
    chunkCount,
    avgFilesPerChunk,
    estRuntimeMsMin,
    estRuntimeMsMax,
  };
}

// --- Success criteria (scale-adaptive) ---

function computeExpectations(census: RepoCensus, plan: PlanPreview): SuccessCriteria {
  const t = plan.targetCoveragePercent;
  const src = census.sourceFileCount;

  return {
    coverageMinPercent: Math.max(0, t - 10),
    coverageMaxPercent: Math.min(100, t + 5),
    filesExaminedMin: Math.floor(src * Math.max(0, t - 10) / 100),
    filesExaminedMax: Math.ceil(src * Math.min(100, t + 5) / 100),
    perChunkedAgentFilesMin: Math.floor(src * 0.30),
    findingsTotalMin: Math.max(1, Math.floor(src / 100)),
    findingsTotalMax: Math.ceil(src * 2),
    perAgentTelemetryPositive: true,
    uncoveredFilesAllRelative: true,
    lightMidTimeoutsZero: true,
    runtimeMsMin: plan.estRuntimeMsMin,
    runtimeMsMax: plan.estRuntimeMsMax,
  };
}

// --- Prior run location ---

function locatePriorRun(
  qaDataRoot: string,
  projectSlug: string,
  currentRunId: string,
): { runId: string | null; ageSeconds: number | null; metaPath: string | null; coveragePath: string | null } {
  const runsDir = join(qaDataRoot, projectSlug, 'runs');
  if (!existsSync(runsDir)) return { runId: null, ageSeconds: null, metaPath: null, coveragePath: null };
  const entries = readdirSync(runsDir)
    .filter(e => e !== currentRunId && e.startsWith('qa-'))
    .sort()
    .reverse();
  for (const e of entries) {
    const meta = join(runsDir, e, 'meta.json');
    const cov = join(runsDir, e, 'coverage-report.json');
    if (existsSync(meta)) {
      const ageSeconds = Math.round((Date.now() - statSync(meta).mtimeMs) / 1000);
      return {
        runId: e,
        ageSeconds,
        metaPath: meta,
        coveragePath: existsSync(cov) ? cov : null,
      };
    }
  }
  return { runId: null, ageSeconds: null, metaPath: null, coveragePath: null };
}

// --- Interactive prompts ---

function readLineOnce(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askGapHealing(
  report: PreflightReport,
  gapsExist: boolean,
): Promise<'auto' | 'report' | 'fail'> {
  const fromEnv = process.env.QA_GAP_HEAL;
  if (fromEnv === 'auto' || fromEnv === 'report' || fromEnv === 'fail') {
    process.stderr.write(`[preflight] QA_GAP_HEAL=${fromEnv} — skipping gap-healing prompt\n`);
    return fromEnv;
  }
  if (!gapsExist) {
    process.stderr.write('\n(no actionable carryover gaps from prior run)\n');
    return 'report';
  }

  process.stderr.write('\nHow should we handle prior-run gaps?\n');
  process.stderr.write('  [1] Auto-heal (recommended) — run gap-healing jobs alongside the main run\n');
  process.stderr.write('  [2] Report only — proceed normally; gaps appear in qa-gaps.md Carryover section\n');
  process.stderr.write('  [3] Fail + script — abort this run; write remediation-commands.sh\n');
  const ans = (await readLineOnce('Choice [1/2/3]: ')).toLowerCase();
  if (ans === '3' || ans === 'fail') return 'fail';
  if (ans === '2' || ans === 'report') return 'report';
  return 'auto';
}

async function askProceed(): Promise<boolean> {
  const ans = (await readLineOnce('\nProceed with run? [y/N]: ')).toLowerCase();
  return ans === 'y' || ans === 'yes';
}

// --- Output ---

function writeReport(runDir: string, report: PreflightReport): void {
  try {
    writeFileSync(join(runDir, 'preflight.json'), JSON.stringify(report, null, 2));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[preflight] failed to write preflight.json: ${msg}\n`);
  }
}

function writeRemediationScript(
  runDir: string,
  config: OrchestrationConfig,
  jobs: readonly GapHealingJob[],
): void {
  const lines = [
    '#!/usr/bin/env bash',
    '# Generated by preflight — run these to heal prior-run gaps, then re-run qa-review.',
    `# Repo: ${config.repoPath}`,
    `# Generated at: ${new Date().toISOString()}`,
    'set -euo pipefail',
    '',
  ];
  for (const j of jobs) {
    const envs: string[] = [];
    if (j.timeoutMsOverride) envs.push(`QA_AGENT_TIMEOUT_MS=${j.timeoutMsOverride}`);
    const moduleArg = j.moduleScope ? ` MODULE=${j.moduleScope}` : '';
    const envStr = envs.length ? `${envs.join(' ')} ` : '';
    lines.push(`# ${j.reason}`);
    lines.push(`${envStr}make qa-review REPO="${config.repoPath}" AGENT_ONLY=${j.agentName}${moduleArg}`);
    lines.push('');
  }
  const scriptPath = join(runDir, 'remediation-commands.sh');
  try {
    writeFileSync(scriptPath, lines.join('\n'), { mode: 0o755 });
    process.stderr.write(`[preflight] wrote remediation script: ${scriptPath}\n`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[preflight] failed to write remediation script: ${msg}\n`);
  }
}

function printSummary(report: PreflightReport, opts: { interactive: boolean }): void {
  const w = (s: string) => process.stderr.write(s);
  w('\n=== QA Preflight ===\n');
  w(`Project: ${report.projectSlug}  |  Run: ${report.runId}  |  Mode: ${report.mode}\n`);
  w(`Repo: ${report.repoPath}\n`);

  w('\n--- Repo census ---\n');
  w(`Source files: ${report.census.sourceFileCount} (checkability ${report.census.checkabilityPercent}%, ${report.census.uncheckableCount} uncheckable)\n`);

  const topLangs = Object.entries(report.census.filesByLanguage)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  w(`By language: ${topLangs.map(([k, v]) => `${k}=${v}`).join(', ')}\n`);

  const topDirs = Object.entries(report.census.filesByTopLevel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  w(`By top-level: ${topDirs.map(([k, v]) => `${k}=${v}`).join(', ')}\n`);

  w('\n--- Plan ---\n');
  w(`Strategy: ${report.plan.coverageStrategy} (targetPercent=${report.plan.targetCoveragePercent})\n`);
  w(`Agents: ${report.plan.agentCount}  |  Chunked: ${report.plan.chunkedAgents.length}  |  Chunks: ${report.plan.chunkCount} (~${report.plan.avgFilesPerChunk} files each)\n`);
  w(`Est. runtime: ${Math.round(report.plan.estRuntimeMsMin / 60_000)}–${Math.round(report.plan.estRuntimeMsMax / 60_000)} min\n`);

  w('\n--- Expected outcome ---\n');
  const ex = report.expectations;
  w(`Coverage: ${ex.coverageMinPercent}%–${ex.coverageMaxPercent}% (${ex.filesExaminedMin}–${ex.filesExaminedMax} files examined)\n`);
  w(`Findings total: ${ex.findingsTotalMin}–${ex.findingsTotalMax}\n`);
  w(`Per-chunked-agent min: ${ex.perChunkedAgentFilesMin} files\n`);
  w(`Per-agent filesExamined: > 0 (every agent, any adapter)\n`);
  w(`uncoveredFiles path format: relative to repo root\n`);
  w(`Timeouts on light/mid tier: 0\n`);

  if (report.carryoverGaps.length > 0) {
    w('\n--- Prior-run gaps (still actionable) ---\n');
    for (const g of report.carryoverGaps) {
      w(`  - [${g.type}] ${g.description}\n`);
      w(`      remediation: ${g.suggestedRemediation}\n`);
    }
  } else if (report.priorRun.runId) {
    w(`\n(prior run ${report.priorRun.runId} has no actionable carryover gaps)\n`);
  } else {
    w('\n(no prior run on disk — this is a fresh audit)\n');
  }

  if (!opts.interactive) {
    w('\n[preflight] QA_PREFLIGHT=skip — proceeding without gate\n');
  }
}
