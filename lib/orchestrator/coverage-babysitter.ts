import { relative, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import type {
  CoverageStrategy, CoverageStrategyConfig, CoverageReport,
  FileChunk, ToolCallLogEntry,
} from './types.js';

// --- Strategy Configuration Map ---

const STRATEGY_CONFIGS: Record<CoverageStrategy, CoverageStrategyConfig> = {
  sweep: {
    chunkSize: 80,
    maxChunkSize: 100,
    maxChunksPerAgent: 3,
    targetCoveragePercent: 40,
    retryLowCoverageChunks: false,
    lowCoverageThreshold: 0,
    maxRetriesPerChunk: 0,
    retryBackoffMs: 0,
    unchunkedScopeHint: false,
    requireApiProvider: false,
  },
  balanced: {
    chunkSize: 45,
    maxChunkSize: 55,
    maxChunksPerAgent: 10,
    targetCoveragePercent: 65,
    retryLowCoverageChunks: false,
    lowCoverageThreshold: 0,
    maxRetriesPerChunk: 0,
    retryBackoffMs: 0,
    unchunkedScopeHint: true,
    requireApiProvider: true,
  },
  thorough: {
    chunkSize: 25,
    maxChunkSize: 35,
    maxChunksPerAgent: 20,
    targetCoveragePercent: 85,
    retryLowCoverageChunks: true,
    lowCoverageThreshold: 50,
    maxRetriesPerChunk: 2,
    retryBackoffMs: 0,
    unchunkedScopeHint: true,
    requireApiProvider: true,
  },
  exhaustive: {
    chunkSize: 18,
    maxChunkSize: 25,
    maxChunksPerAgent: 40,
    targetCoveragePercent: 95,
    retryLowCoverageChunks: true,
    lowCoverageThreshold: 60,
    maxRetriesPerChunk: 2,
    retryBackoffMs: 0,
    unchunkedScopeHint: true,
    requireApiProvider: true,
  },
};

export function getStrategyConfig(strategy: CoverageStrategy): CoverageStrategyConfig {
  return STRATEGY_CONFIGS[strategy];
}

// --- Tool Call Log Cap ---

const TOOL_CALL_LOG_CAP = 5_000;

export function capToolCallLog(log: ToolCallLogEntry[]): { capped: ToolCallLogEntry[]; droppedCount: number } {
  if (log.length <= TOOL_CALL_LOG_CAP) {
    return { capped: log, droppedCount: 0 };
  }
  const kept = log.slice(0, TOOL_CALL_LOG_CAP);
  const dropped = log.slice(TOOL_CALL_LOG_CAP).map(entry => ({
    tool: entry.tool,
    args: {},
    timestamp: entry.timestamp,
  }));
  return { capped: [...kept, ...dropped], droppedCount: log.length - TOOL_CALL_LOG_CAP };
}

// --- Path Sanitization ---

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function assertSafePath(filePath: string): void {
  if (CONTROL_CHAR_RE.test(filePath)) {
    throw new Error(`Unsafe file path rejected (contains control characters): ${JSON.stringify(filePath)}`);
  }
}

// --- CoverageBabysitter ---

export class CoverageBabysitter {
  private readonly allFiles: Set<string>;
  private readonly allFilesArray: string[];
  private readonly coveredFiles = new Set<string>();
  private readonly coveredByAgent = new Map<string, Set<string>>();
  private readonly strategy: CoverageStrategy;
  private readonly config: CoverageStrategyConfig;
  private retriesExecuted = 0;

  constructor(
    allSourceFiles: string[],
    strategy: CoverageStrategy,
    config?: CoverageStrategyConfig,
  ) {
    this.allFilesArray = allSourceFiles;
    this.allFiles = new Set(allSourceFiles);
    this.strategy = strategy;
    this.config = config ?? getStrategyConfig(strategy);
  }

  /**
   * Extract file paths from tool call log entries and mark them as covered.
   */
  recordAgentRun(agentName: string, toolCallLog: ToolCallLogEntry[]): void {
    const agentFiles = new Set<string>();

    for (const entry of toolCallLog) {
      const paths = this.extractFilePaths(entry);
      for (const p of paths) {
        if (this.allFiles.has(p)) {
          this.coveredFiles.add(p);
          agentFiles.add(p);
        }
      }
    }

    const existing = this.coveredByAgent.get(agentName);
    if (existing) {
      for (const f of agentFiles) existing.add(f);
    } else {
      this.coveredByAgent.set(agentName, agentFiles);
    }
  }

  /**
   * Evaluate coverage for a specific chunk. Returns whether it should be retried.
   */
  evaluateChunkCoverage(agentName: string, chunk: FileChunk): {
    coveragePercent: number;
    shouldRetry: boolean;
    uncoveredInChunk: string[];
  } {
    const agentFiles = this.coveredByAgent.get(agentName) ?? new Set<string>();
    const coveredInChunk = chunk.files.filter(f => agentFiles.has(f) || this.coveredFiles.has(f));
    const uncoveredInChunk = chunk.files.filter(f => !coveredInChunk.includes(f));
    const coveragePercent = chunk.files.length > 0
      ? Math.round((coveredInChunk.length / chunk.files.length) * 100)
      : 100;

    const shouldRetry = this.config.retryLowCoverageChunks
      && coveragePercent < this.config.lowCoverageThreshold
      && this.retriesExecuted < (this.config.maxRetriesPerChunk * (this.coveredByAgent.size || 1));

    return { coveragePercent, shouldRetry, uncoveredInChunk };
  }

  /**
   * Get uncovered files for injection into unchunked agent prompts.
   * Prioritizes by heuristic: alphabetical for determinism (diff-mode and
   * import-count prioritization deferred to Phase 2C smart chunking).
   */
  getUncoveredFilesForHint(maxFiles: number): string[] {
    const uncovered = this.allFilesArray.filter(f => !this.coveredFiles.has(f));
    // Sort alphabetically for deterministic output
    uncovered.sort();
    return uncovered.slice(0, maxFiles);
  }

  getCoveragePercent(): number {
    if (this.allFiles.size === 0) return 100;
    return Math.round((this.coveredFiles.size / this.allFiles.size) * 100);
  }

  isTargetMet(): boolean {
    return this.getCoveragePercent() >= this.config.targetCoveragePercent;
  }

  getFilesExamined(): ReadonlySet<string> {
    return this.coveredFiles;
  }

  getTargetPercent(): number {
    return this.config.targetCoveragePercent;
  }

  getStrategy(): CoverageStrategy {
    return this.strategy;
  }

  getConfig(): CoverageStrategyConfig {
    return this.config;
  }

  incrementRetries(): void {
    this.retriesExecuted++;
  }

  getRetriesExecuted(): number {
    return this.retriesExecuted;
  }

  /**
   * Build a focused retry prompt for a low-coverage chunk.
   * File paths are sanitized to prevent control character injection.
   */
  buildRetryPrompt(chunk: FileChunk, uncoveredFiles: string[], repoPath: string): string {
    const relativeFiles = uncoveredFiles.map(f => {
      const rel = relative(repoPath, f);
      assertSafePath(rel);
      return rel;
    });

    return (
      `\n\nRETRY — Low coverage on chunk ${chunk.id}\n` +
      `The previous analysis missed ${uncoveredFiles.length} files in this chunk.\n` +
      `Review ONLY these files:\n` +
      relativeFiles.map(f => `  ${f}`).join('\n') + '\n' +
      `Focus your analysis on these specific files. Do NOT re-analyze files from the previous pass.\n`
    );
  }

  /**
   * Build the final coverage report.
   */
  buildReport(): CoverageReport {
    const uncoveredFiles = this.allFilesArray
      .filter(f => !this.coveredFiles.has(f))
      .sort();

    const byAgent: CoverageReport['byAgent'] = [];
    for (const [agent, files] of this.coveredByAgent) {
      byAgent.push({ agent, filesExamined: files.size });
    }
    byAgent.sort((a, b) => b.filesExamined - a.filesExamined);

    return {
      strategy: this.strategy,
      targetPercent: this.config.targetCoveragePercent,
      actualPercent: this.getCoveragePercent(),
      totalFiles: this.allFiles.size,
      filesExaminedCount: this.coveredFiles.size,
      uncoveredFiles,
      retriesExecuted: this.retriesExecuted,
      byAgent,
    };
  }

  /**
   * Print coverage summary to stderr.
   */
  printReport(): void {
    const report = this.buildReport();
    const met = report.actualPercent >= report.targetPercent;
    const verdict = met ? 'TARGET MET' : 'BELOW TARGET';

    process.stderr.write(`\n=== Coverage Report ===\n`);
    process.stderr.write(`Strategy: ${report.strategy} | Target: ${report.targetPercent}% | Actual: ${report.actualPercent}% — ${verdict}\n`);
    process.stderr.write(`Files: ${report.filesExaminedCount}/${report.totalFiles} examined`);
    if (report.retriesExecuted > 0) {
      process.stderr.write(` | Retries: ${report.retriesExecuted}`);
    }
    process.stderr.write('\n');

    if (report.byAgent.length > 0) {
      process.stderr.write('By agent:\n');
      for (const { agent, filesExamined } of report.byAgent.slice(0, 10)) {
        process.stderr.write(`  ${agent}: ${filesExamined} files\n`);
      }
      if (report.byAgent.length > 10) {
        process.stderr.write(`  ... and ${report.byAgent.length - 10} more agents\n`);
      }
    }

    if (report.uncoveredFiles.length > 0 && report.uncoveredFiles.length <= 20) {
      process.stderr.write(`Uncovered (${report.uncoveredFiles.length}):\n`);
      for (const f of report.uncoveredFiles) {
        process.stderr.write(`  ${f}\n`);
      }
    } else if (report.uncoveredFiles.length > 20) {
      process.stderr.write(`Uncovered: ${report.uncoveredFiles.length} files (see coverage-report.json)\n`);
    }

    process.stderr.write('=======================\n');
  }

  /**
   * Write coverage-report.json to runDir.
   */
  writeReport(runDir: string): void {
    const report = this.buildReport();
    const reportPath = `${runDir}/coverage-report.json`;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }

  // --- Private helpers ---

  private extractFilePaths(entry: ToolCallLogEntry): string[] {
    const paths: string[] = [];
    const args = entry.args;

    switch (entry.tool) {
      case 'Read': {
        const filePath = args.file_path;
        if (typeof filePath === 'string') {
          paths.push(this.normalizePath(filePath));
        }
        break;
      }
      case 'Grep': {
        const searchPath = args.path;
        if (typeof searchPath === 'string') {
          const normalized = this.normalizePath(searchPath);
          // Grep path is a directory or file — match all allFiles under it
          for (const f of this.allFilesArray) {
            if (f === normalized || f.startsWith(normalized + '/')) {
              paths.push(f);
            }
          }
        }
        break;
      }
      case 'Glob': {
        const searchPath = args.path;
        if (typeof searchPath === 'string') {
          const normalized = this.normalizePath(searchPath);
          for (const f of this.allFilesArray) {
            if (f === normalized || f.startsWith(normalized + '/')) {
              paths.push(f);
            }
          }
        }
        break;
      }
      // Future tools (AST, DependencyGraph) will be added here
    }

    return paths;
  }

  private normalizePath(filePath: string): string {
    try {
      return resolve(filePath);
    } catch {
      return filePath;
    }
  }
}
