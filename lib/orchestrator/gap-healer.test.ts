import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGapHealingPlan } from './gap-healer.js';

function seed(meta: unknown, coverage: unknown): { metaPath: string; coveragePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gap-healer-'));
  const metaPath = join(dir, 'meta.json');
  const coveragePath = join(dir, 'coverage-report.json');
  writeFileSync(metaPath, JSON.stringify(meta));
  writeFileSync(coveragePath, JSON.stringify(coverage));
  return { metaPath, coveragePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SOURCE_FILES = Array.from({ length: 100 }, (_, i) => `/repo/src/file${i}.ts`);

describe('buildGapHealingPlan', () => {
  it('returns empty when no prior meta path', () => {
    const plan = buildGapHealingPlan({
      priorMetaPath: null,
      priorCoveragePath: null,
      currentAgents: ['code-reviewer'],
      currentSourceFiles: SOURCE_FILES,
    });
    assert.deepEqual(plan, { gaps: [], jobs: [] });
  });

  it('flags timed-out agent as heavy-tier heal job', () => {
    const { metaPath, coveragePath, cleanup } = seed(
      {
        agents: [
          {
            name: 'doc-reviewer',
            status: 'failed',
            error: 'Agent doc-reviewer failed on all providers: doc-reviewer (gemini-cli/gemini) exceeded 480s hard timeout',
          },
        ],
      },
      { byAgent: [] },
    );
    try {
      const plan = buildGapHealingPlan({
        priorMetaPath: metaPath,
        priorCoveragePath: coveragePath,
        currentAgents: ['doc-reviewer', 'code-reviewer'],
        currentSourceFiles: SOURCE_FILES,
      });
      assert.equal(plan.gaps.length, 1);
      assert.equal(plan.gaps[0].type, 'failed-agent');
      assert.equal(plan.gaps[0].agentName, 'doc-reviewer');
      assert.equal(plan.jobs.length, 1);
      assert.equal(plan.jobs[0].agentName, 'doc-reviewer');
      assert.equal(plan.jobs[0].tierOverride, 'heavy');
      assert.equal(plan.jobs[0].kind, 'heal');
    } finally { cleanup(); }
  });

  it('skips failed agents not in current registry', () => {
    const { metaPath, coveragePath, cleanup } = seed(
      { agents: [{ name: 'removed-agent', status: 'failed', error: 'timeout' }] },
      { byAgent: [] },
    );
    try {
      const plan = buildGapHealingPlan({
        priorMetaPath: metaPath,
        priorCoveragePath: coveragePath,
        currentAgents: ['code-reviewer'],
        currentSourceFiles: SOURCE_FILES,
      });
      assert.equal(plan.gaps.length, 0);
      assert.equal(plan.jobs.length, 0);
    } finally { cleanup(); }
  });

  it('flags per-agent coverage shortfall when examined < 30%', () => {
    const { metaPath, coveragePath, cleanup } = seed(
      { agents: [] },
      {
        totalFiles: 100,
        byAgent: [
          { agent: 'code-reviewer', filesExamined: 10 }, // 10% — shortfall
          { agent: 'security-reviewer', filesExamined: 50 }, // 50% — ok
        ],
      },
    );
    try {
      const plan = buildGapHealingPlan({
        priorMetaPath: metaPath,
        priorCoveragePath: coveragePath,
        currentAgents: ['code-reviewer', 'security-reviewer'],
        currentSourceFiles: SOURCE_FILES,
      });
      const shortfalls = plan.gaps.filter(g => g.type === 'agent-coverage-shortfall');
      assert.equal(shortfalls.length, 1);
      assert.equal(shortfalls[0].agentName, 'code-reviewer');
      assert.equal(plan.jobs.length, 1);
      assert.equal(plan.jobs[0].agentName, 'code-reviewer');
    } finally { cleanup(); }
  });

  it('does not double-schedule an agent that is both failed and under-covered', () => {
    const { metaPath, coveragePath, cleanup } = seed(
      { agents: [{ name: 'code-reviewer', status: 'failed', error: 'exceeded 480s hard timeout' }] },
      { totalFiles: 100, byAgent: [{ agent: 'code-reviewer', filesExamined: 5 }] },
    );
    try {
      const plan = buildGapHealingPlan({
        priorMetaPath: metaPath,
        priorCoveragePath: coveragePath,
        currentAgents: ['code-reviewer'],
        currentSourceFiles: SOURCE_FILES,
      });
      assert.equal(plan.jobs.length, 1, 'should produce exactly one heal job');
      assert.equal(plan.jobs[0].tierOverride, 'heavy');
    } finally { cleanup(); }
  });
});
