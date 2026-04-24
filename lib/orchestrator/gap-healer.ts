// gap-healer — derive actionable gaps from a prior QA run and produce
// GapHealingJob entries the dispatcher can inject alongside the main run.
//
// Actionable gap = still applicable to the current HEAD + repo state:
//   - a failed agent that still exists in the agent registry
//   - an agent with <30% per-agent coverage last run whose under-covered
//     files still exist in the current source set
//   - a criterion miss whose root cause isn't already patched by HEAD
//     (e.g., `.venv` coverage bloat is a no-op after Phase 1 lands)
//
// We intentionally do NOT resurrect every stale finding. A gap is a process
// failure (the agent couldn't finish) or a structural failure (too few
// files seen), not a disagreement with the agent's findings.

import { existsSync, readFileSync } from 'node:fs';

const MIN_PER_AGENT_COVERAGE_RATIO = 0.30;

export interface CarryoverGap {
  type: 'failed-agent' | 'agent-coverage-shortfall' | 'criterion-miss';
  description: string;
  agentName?: string;
  suggestedRemediation: string;
}

export interface GapHealingJob {
  agentName: string;
  reason: string;
  tierOverride?: 'light' | 'mid' | 'heavy';
  timeoutMsOverride?: number;
  moduleScope?: string;
  kind: 'heal';
}

export interface BuildGapHealingPlanInput {
  priorMetaPath: string | null;
  priorCoveragePath: string | null;
  currentAgents: readonly string[];
  currentSourceFiles: readonly string[];
  // Agents the current run intentionally skips (e.g., testability-scanner's
  // predictAgentEffectiveness produced "no DB schemas → skip schema-migration
  // -reviewer"). Heal jobs for these would be wasted and flagged entries
  // mislead the operator. Drop them from gaps and jobs alike.
  agentsToSkip?: ReadonlySet<string>;
}

export interface GapHealingPlan {
  gaps: CarryoverGap[];
  jobs: GapHealingJob[];
}

export function buildGapHealingPlan(input: BuildGapHealingPlanInput): GapHealingPlan {
  if (!input.priorMetaPath) return { gaps: [], jobs: [] };
  const priorMeta = loadJson<Record<string, unknown>>(input.priorMetaPath);
  if (!priorMeta) return { gaps: [], jobs: [] };
  const priorCoverage = input.priorCoveragePath ? loadJson<Record<string, unknown>>(input.priorCoveragePath) : null;

  const currentAgents = new Set(input.currentAgents);
  const skipSet = input.agentsToSkip ?? new Set<string>();
  const gaps: CarryoverGap[] = [];
  const jobs: GapHealingJob[] = [];

  // --- failed agents ---
  const priorAgents = Array.isArray(priorMeta.agents) ? priorMeta.agents as Record<string, unknown>[] : [];
  for (const a of priorAgents) {
    if (a.status !== 'failed') continue;
    const name = (a.name ?? a.agentName) as string | undefined;
    if (!name || !currentAgents.has(name)) continue;
    if (skipSet.has(name)) continue;  // skipped this run — heal would also skip
    const errMsg = (a.error as string | undefined) ?? 'unknown error';
    const isTimeout = /exceeded \d+s hard timeout/.test(errMsg);
    gaps.push({
      type: 'failed-agent',
      agentName: name,
      description: isTimeout
        ? `${name} timed out on light tier (8m) — heavy tier would give it 25m`
        : `${name} failed: ${errMsg.slice(0, 120)}`,
      suggestedRemediation: isTimeout
        ? `re-run on heavy tier (expected ~15-25m)`
        : `investigate error; re-run with same tier or bump tier`,
    });
    jobs.push({
      agentName: name,
      reason: isTimeout ? 'prior timeout — heal on heavy tier' : `prior failure — ${errMsg.slice(0, 80)}`,
      tierOverride: isTimeout ? 'heavy' : undefined,
      kind: 'heal',
    });
  }

  // --- per-agent coverage shortfall ---
  if (priorCoverage) {
    const byAgent = Array.isArray(priorCoverage.byAgent) ? priorCoverage.byAgent as Record<string, unknown>[] : [];
    // Threshold against the CURRENT source count only. Using max(prior,
    // current) produced impossible targets (e.g. 2352 on a 1,297-file repo
    // when the prior run was polluted with 7,840 .venv files).
    const minFiles = Math.floor(input.currentSourceFiles.length * MIN_PER_AGENT_COVERAGE_RATIO);
    for (const row of byAgent) {
      const name = row.agent as string | undefined;
      if (!name || !currentAgents.has(name)) continue;
      if (skipSet.has(name)) continue;  // skipped this run
      const examined = typeof row.filesExamined === 'number' ? row.filesExamined : 0;
      if (examined >= minFiles) continue;
      // Skip if the agent already showed up in failed-agent jobs — we'll
      // already re-run it on heavy tier and don't need a second heal job.
      if (jobs.some(j => j.agentName === name)) continue;
      gaps.push({
        type: 'agent-coverage-shortfall',
        agentName: name,
        description: `${name} saw only ${examined} files last run (< 30% of ${input.currentSourceFiles.length})`,
        suggestedRemediation: `targeted re-dispatch to raise coverage above ${minFiles} (30% of ${input.currentSourceFiles.length})`,
      });
      jobs.push({
        agentName: name,
        reason: `prior per-agent coverage shortfall (${examined}/${input.currentSourceFiles.length})`,
        kind: 'heal',
      });
    }
  }

  return { gaps, jobs };
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch { return null; }
}
