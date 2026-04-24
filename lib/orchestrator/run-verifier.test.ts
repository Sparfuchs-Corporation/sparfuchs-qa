import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRun } from './run-verifier.js';

function setup(files: Record<string, unknown>): { runDir: string; cleanup: () => void } {
  const runDir = mkdtempSync(join(tmpdir(), 'run-verifier-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(runDir, name), JSON.stringify(content));
  }
  return { runDir, cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}

const MINIMAL_PREFLIGHT = {
  runId: 'qa-test',
  projectSlug: 'test',
  generatedAt: '2026-04-24T00:00:00.000Z',
  repoPath: '/repo',
  mode: 'full',
  census: { sourceFileCount: 100, filesByLanguage: {}, filesByTopLevel: {}, checkabilityPercent: 95, uncheckableCount: 5 },
  plan: {
    mode: 'full', coverageStrategy: 'balanced', targetCoveragePercent: 65,
    agentCount: 10, chunkedAgents: [], chunkCount: 0, avgFilesPerChunk: 100,
    estRuntimeMsMin: 300_000, estRuntimeMsMax: 3_000_000,
  },
  expectations: {
    coverageMinPercent: 55, coverageMaxPercent: 70,
    filesExaminedMin: 55, filesExaminedMax: 70,
    perChunkedAgentFilesMin: 30,
    findingsTotalMin: 1, findingsTotalMax: 200,
    perAgentTelemetryPositive: true as const,
    uncoveredFilesAllRelative: true as const,
    lightMidTimeoutsZero: true as const,
    runtimeMsMin: 300_000, runtimeMsMax: 3_000_000,
  },
  priorRun: { runId: null, ageSeconds: null },
  carryoverGaps: [],
  gapHealDecision: 'report',
  healJobs: [],
  proceed: true,
};

describe('verifyRun', () => {
  it('returns null when no preflight.json exists', () => {
    const { runDir, cleanup } = setup({});
    try {
      assert.equal(verifyRun({ runDir, projectSlug: 'test', runId: 'qa-test' }), null);
    } finally { cleanup(); }
  });

  it('passes all checks on a healthy run', () => {
    const { runDir, cleanup } = setup({
      'preflight.json': MINIMAL_PREFLIGHT,
      'meta.json': {
        agents: [
          { name: 'code-reviewer', status: 'complete', tier: 'mid' },
          { name: 'security-reviewer', status: 'complete', tier: 'mid' },
        ],
      },
      'coverage-report.json': {
        actualPercent: 62,
        totalFiles: 100,
        uncoveredFiles: ['src/foo.ts', 'src/bar.ts'],
        byAgent: [
          { agent: 'code-reviewer', filesExamined: 62 },
          { agent: 'security-reviewer', filesExamined: 40 },
        ],
      },
      'findings-final.json': Array.from({ length: 15 }, (_, i) => ({ severity: 'low', rule: `r${i}` })),
    });
    try {
      const report = verifyRun({ runDir, projectSlug: 'test', runId: 'qa-test' });
      assert.ok(report);
      assert.equal(report.failed, 0, `expected 0 failures, got ${report.failed}; checks: ${JSON.stringify(report.checks)}`);
      assert.equal(report.partialRun, false);
    } finally { cleanup(); }
  });

  it('fails coverage-in-band check and suggests .venv remediation when venv paths dominate uncoveredFiles', () => {
    const { runDir, cleanup } = setup({
      'preflight.json': MINIMAL_PREFLIGHT,
      'meta.json': { agents: [] },
      'coverage-report.json': {
        actualPercent: 30,  // well below 55–70
        totalFiles: 100,
        uncoveredFiles: Array.from({ length: 50 }, (_, i) => `apps/ai-proxy/.venv/lib/python3.9/site-packages/PIL/pkg${i}.py`)
          .concat(['src/real.ts']),
        byAgent: [{ agent: 'code-reviewer', filesExamined: 30 }],
      },
      'findings-final.json': [],
    });
    try {
      const report = verifyRun({ runDir, projectSlug: 'test', runId: 'qa-test' });
      assert.ok(report);
      const coverageCheck = report.checks.find(c => c.id === 'coverage-in-band');
      assert.equal(coverageCheck?.status, 'fail');
      assert.ok(coverageCheck?.remediation?.includes('.venv'), `expected .venv remediation, got: ${coverageCheck?.remediation}`);
    } finally { cleanup(); }
  });

  it('fails per-agent telemetry when zero agents reported filesExamined > 0', () => {
    const { runDir, cleanup } = setup({
      'preflight.json': MINIMAL_PREFLIGHT,
      'meta.json': { agents: [{ name: 'a1', status: 'complete' }, { name: 'a2', status: 'complete' }] },
      'coverage-report.json': {
        actualPercent: 0, totalFiles: 100, uncoveredFiles: [],
        byAgent: [{ agent: 'a1', filesExamined: 0 }, { agent: 'a2', filesExamined: 0 }],
      },
      'findings-final.json': Array.from({ length: 5 }, (_, i) => ({ severity: 'low', rule: `r${i}` })),
    });
    try {
      const report = verifyRun({ runDir, projectSlug: 'test', runId: 'qa-test' });
      assert.ok(report);
      const t = report.checks.find(c => c.id === 'per-agent-telemetry');
      assert.equal(t?.status, 'fail');
      assert.ok(t?.cause?.includes('zero file access'));
    } finally { cleanup(); }
  });

  it('fails light-mid-no-timeouts when a light-tier agent timed out', () => {
    const { runDir, cleanup } = setup({
      'preflight.json': MINIMAL_PREFLIGHT,
      'meta.json': {
        agents: [
          { name: 'doc-reviewer', status: 'failed', tier: 'light', error: 'Agent doc-reviewer failed: exceeded 480s hard timeout' },
        ],
      },
      'coverage-report.json': { actualPercent: 60, totalFiles: 100, uncoveredFiles: [], byAgent: [{ agent: 'code-reviewer', filesExamined: 60 }] },
      'findings-final.json': Array.from({ length: 5 }, (_, i) => ({ severity: 'low', rule: `r${i}` })),
    });
    try {
      const report = verifyRun({ runDir, projectSlug: 'test', runId: 'qa-test' });
      assert.ok(report);
      const t = report.checks.find(c => c.id === 'light-mid-no-timeouts');
      assert.equal(t?.status, 'fail');
      assert.ok(t?.remediation?.includes('heavy tier'));
    } finally { cleanup(); }
  });

  it('prior-gaps-healed check credits heal jobs recorded under <agent>-heal', () => {
    const withHealJobs = {
      ...MINIMAL_PREFLIGHT,
      healJobs: [{ agentName: 'doc-reviewer', kind: 'heal' as const, reason: 'prior timeout' }],
    };
    const { runDir, cleanup } = setup({
      'preflight.json': withHealJobs,
      'meta.json': { agents: [] },
      'coverage-report.json': {
        actualPercent: 60, totalFiles: 100, uncoveredFiles: [],
        byAgent: [
          { agent: 'code-reviewer', filesExamined: 60 },
          { agent: 'doc-reviewer-heal', filesExamined: 40 },  // heal-suffixed key
        ],
      },
      'findings-final.json': Array.from({ length: 5 }, (_, i) => ({ severity: 'low', rule: `r${i}` })),
    });
    try {
      const report = verifyRun({ runDir, projectSlug: 'test', runId: 'qa-test' });
      assert.ok(report);
      const healed = report.checks.find(c => c.id === 'prior-gaps-healed');
      assert.equal(healed?.status, 'pass', `expected pass, got ${JSON.stringify(healed)}`);
    } finally { cleanup(); }
  });

  it('writes run-quality.json with checks array', () => {
    const { runDir, cleanup } = setup({
      'preflight.json': MINIMAL_PREFLIGHT,
      'meta.json': { agents: [] },
      'coverage-report.json': { actualPercent: 60, totalFiles: 100, uncoveredFiles: [], byAgent: [{ agent: 'x', filesExamined: 60 }] },
      'findings-final.json': Array.from({ length: 5 }, (_, i) => ({ severity: 'low', rule: `r${i}` })),
    });
    try {
      verifyRun({ runDir, projectSlug: 'test', runId: 'qa-test' });
      const disk = JSON.parse(readFileSync(join(runDir, 'run-quality.json'), 'utf8'));
      assert.ok(Array.isArray(disk.checks));
      assert.ok(typeof disk.passed === 'number');
    } finally { cleanup(); }
  });
});
