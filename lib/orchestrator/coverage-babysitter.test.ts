import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { CoverageBabysitter, getStrategyConfig, capToolCallLog } from './coverage-babysitter.js';
import type { ToolCallLogEntry, FileChunk } from './types.js';

const makeLog = (tool: string, args: Record<string, unknown>): ToolCallLogEntry => ({
  tool,
  args,
  timestamp: new Date().toISOString(),
});

const FILES = [
  '/repo/src/auth/middleware.ts',
  '/repo/src/auth/jwt-utils.ts',
  '/repo/src/api/routes/users.ts',
  '/repo/src/api/routes/billing.ts',
  '/repo/src/utils/format.ts',
];

describe('CoverageBabysitter', () => {
  describe('tool extraction — Read', () => {
    it('should mark Read file_path as covered', () => {
      const b = new CoverageBabysitter(FILES, 'balanced');
      b.recordAgentRun('code-reviewer', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
      ]);
      assert.ok(b.getFilesExamined().has('/repo/src/auth/middleware.ts'));
      assert.equal(b.getFilesExamined().size, 1);
    });
  });

  describe('tool extraction — Grep', () => {
    it('should mark all files under Grep path as covered', () => {
      const b = new CoverageBabysitter(FILES, 'balanced');
      b.recordAgentRun('security-reviewer', [
        makeLog('Grep', { path: '/repo/src/auth' }),
      ]);
      assert.ok(b.getFilesExamined().has('/repo/src/auth/middleware.ts'));
      assert.ok(b.getFilesExamined().has('/repo/src/auth/jwt-utils.ts'));
      assert.equal(b.getFilesExamined().size, 2);
    });
  });

  describe('tool extraction — Glob', () => {
    it('should mark all files under Glob path as covered', () => {
      const b = new CoverageBabysitter(FILES, 'balanced');
      b.recordAgentRun('a11y-reviewer', [
        makeLog('Glob', { path: '/repo/src/api' }),
      ]);
      assert.ok(b.getFilesExamined().has('/repo/src/api/routes/users.ts'));
      assert.ok(b.getFilesExamined().has('/repo/src/api/routes/billing.ts'));
      assert.equal(b.getFilesExamined().size, 2);
    });
  });

  describe('evaluateChunkCoverage — under threshold', () => {
    it('should flag retry when coverage is below lowCoverageThreshold on thorough', () => {
      const config = getStrategyConfig('thorough');
      const b = new CoverageBabysitter(FILES, 'thorough', config);

      // Cover only 1 of 5 files = 20%
      b.recordAgentRun('code-reviewer-chunk-1', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
      ]);

      const chunk: FileChunk = { id: 1, files: FILES, primaryDirectory: '/repo/src' };
      const result = b.evaluateChunkCoverage('code-reviewer-chunk-1', chunk);

      assert.equal(result.coveragePercent, 20);
      assert.ok(result.shouldRetry);
      assert.equal(result.uncoveredInChunk.length, 4);
    });
  });

  describe('evaluateChunkCoverage — over threshold', () => {
    it('should not flag retry when coverage is above threshold', () => {
      const config = getStrategyConfig('thorough');
      const b = new CoverageBabysitter(FILES, 'thorough', config);

      // Cover 4 of 5 files = 80%
      b.recordAgentRun('code-reviewer-chunk-1', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
        makeLog('Read', { file_path: '/repo/src/auth/jwt-utils.ts' }),
        makeLog('Read', { file_path: '/repo/src/api/routes/users.ts' }),
        makeLog('Read', { file_path: '/repo/src/utils/format.ts' }),
      ]);

      const chunk: FileChunk = { id: 1, files: FILES, primaryDirectory: '/repo/src' };
      const result = b.evaluateChunkCoverage('code-reviewer-chunk-1', chunk);

      assert.equal(result.coveragePercent, 80);
      assert.ok(!result.shouldRetry);
      assert.equal(result.uncoveredInChunk.length, 1);
    });
  });

  describe('buildRetryPrompt contents', () => {
    it('should include uncovered file paths and RETRY instruction', () => {
      const b = new CoverageBabysitter(FILES, 'thorough');
      const chunk: FileChunk = { id: 3, files: FILES, primaryDirectory: '/repo/src' };
      const uncovered = ['/repo/src/api/routes/billing.ts', '/repo/src/utils/format.ts'];

      const prompt = b.buildRetryPrompt(chunk, uncovered, '/repo');

      assert.ok(prompt.includes('RETRY'));
      assert.ok(prompt.includes('chunk 3'));
      assert.ok(prompt.includes('src/api/routes/billing.ts'));
      assert.ok(prompt.includes('src/utils/format.ts'));
      assert.ok(prompt.includes('2 files'));
    });
  });

  describe('buildReport — uncoveredFiles path format', () => {
    it('emits absolute paths when repoPath is not provided', () => {
      const b = new CoverageBabysitter(FILES, 'balanced');
      b.recordAgentRun('code-reviewer', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
      ]);
      const report = b.buildReport();
      assert.ok(report.uncoveredFiles.every(f => f.startsWith('/')),
        `expected all absolute, got: ${JSON.stringify(report.uncoveredFiles)}`);
    });

    it('emits repo-relative paths when repoPath is provided', () => {
      const b = new CoverageBabysitter(FILES, 'balanced', undefined, '/repo');
      b.recordAgentRun('code-reviewer', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
      ]);
      const report = b.buildReport();
      assert.ok(report.uncoveredFiles.every(f => !f.startsWith('/')),
        `expected all relative, got: ${JSON.stringify(report.uncoveredFiles)}`);
      assert.ok(report.uncoveredFiles.includes('src/auth/jwt-utils.ts'));
      assert.ok(report.uncoveredFiles.includes('src/api/routes/users.ts'));
    });
  });

  describe('buildRetryPrompt — path sanitization', () => {
    it('should reject paths with control characters', () => {
      const b = new CoverageBabysitter(FILES, 'thorough');
      const chunk: FileChunk = { id: 1, files: FILES, primaryDirectory: '/repo/src' };
      const malicious = ['/repo/src/\nmalicious\x00.ts'];

      assert.throws(
        () => b.buildRetryPrompt(chunk, malicious, '/repo'),
        /control characters/,
      );
    });
  });

  describe('getUncoveredFilesForHint — default mode', () => {
    it('should return files in deterministic alphabetical order', () => {
      const b = new CoverageBabysitter(FILES, 'balanced');
      b.recordAgentRun('agent1', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
      ]);

      const hints = b.getUncoveredFilesForHint(3);
      assert.equal(hints.length, 3);
      // Should be alphabetically sorted
      for (let i = 1; i < hints.length; i++) {
        assert.ok(hints[i] >= hints[i - 1], `${hints[i]} should come after ${hints[i - 1]}`);
      }
    });
  });

  describe('getCoveragePercent', () => {
    it('should compute correct percentage across multiple agent runs', () => {
      const b = new CoverageBabysitter(FILES, 'balanced');

      b.recordAgentRun('agent1', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
      ]);
      assert.equal(b.getCoveragePercent(), 20);

      b.recordAgentRun('agent2', [
        makeLog('Read', { file_path: '/repo/src/api/routes/users.ts' }),
        makeLog('Read', { file_path: '/repo/src/utils/format.ts' }),
      ]);
      assert.equal(b.getCoveragePercent(), 60);
    });
  });

  describe('isTargetMet', () => {
    it('should return true only when coverage >= target', () => {
      const config = getStrategyConfig('sweep'); // target 40%
      const b = new CoverageBabysitter(FILES, 'sweep', config);

      // 1/5 = 20% — below 40% target
      b.recordAgentRun('agent1', [
        makeLog('Read', { file_path: '/repo/src/auth/middleware.ts' }),
      ]);
      assert.ok(!b.isTargetMet());

      // 3/5 = 60% — above 40% target
      b.recordAgentRun('agent2', [
        makeLog('Read', { file_path: '/repo/src/api/routes/users.ts' }),
        makeLog('Read', { file_path: '/repo/src/utils/format.ts' }),
      ]);
      assert.ok(b.isTargetMet());
    });
  });
});

describe('capToolCallLog', () => {
  it('should not cap logs under the limit', () => {
    const log = Array.from({ length: 100 }, (_, i) => makeLog('Read', { file_path: `/f${i}.ts` }));
    const { capped, droppedCount } = capToolCallLog(log);
    assert.equal(capped.length, 100);
    assert.equal(droppedCount, 0);
  });

  it('should drop args beyond cap and report count', () => {
    const log = Array.from({ length: 6000 }, (_, i) => makeLog('Read', { file_path: `/f${i}.ts` }));
    const { capped, droppedCount } = capToolCallLog(log);
    assert.equal(capped.length, 6000);
    assert.equal(droppedCount, 1000);

    // First 5000 should have args
    assert.ok('file_path' in capped[4999].args);
    // 5001st should have empty args
    assert.deepEqual(capped[5000].args, {});
  });
});
