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
    minimumObservability: 'none',
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
    requireApiProvider: false,
    minimumObservability: 'heuristic',
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
    requireApiProvider: false,
    minimumObservability: 'structured',
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
    requireApiProvider: false,
    minimumObservability: 'structured',
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
  // Repo root for mapping absolute paths back to relative in buildReport().
  // Optional so existing 2-arg tests keep working; when unset, uncoveredFiles
  // in the report fall back to absolute paths.
  private readonly repoPath: string | null;
  // Category-specific per-agent counters for the TTY Files column:
  // synthesis agents (qa-gap-analyzer, release-gate-synthesizer) care about
  // how many findings JSON files they read; probe agents (api-contract-
  // prober, e2e-tester) care about how many outbound network calls.
  private readonly findingsReadByAgent = new Map<string, number>();
  private readonly probeCountByAgent = new Map<string, number>();
  private retriesExecuted = 0;

  constructor(
    allSourceFiles: string[],
    strategy: CoverageStrategy,
    config?: CoverageStrategyConfig,
    repoPath?: string,
  ) {
    this.allFilesArray = allSourceFiles;
    this.allFiles = new Set(allSourceFiles);
    this.strategy = strategy;
    this.config = config ?? getStrategyConfig(strategy);
    this.repoPath = repoPath ?? null;
  }

  /**
   * Extract file paths from tool call log entries and mark them as covered.
   * Also tallies category-specific counters: findings JSON reads (for
   * synthesis agents) and network-probe calls (for probe agents).
   */
  recordAgentRun(agentName: string, toolCallLog: ToolCallLogEntry[]): void {
    const agentFiles = new Set<string>();
    let findingsReadDelta = 0;
    let probeDelta = 0;

    for (const entry of toolCallLog) {
      const paths = this.extractFilePaths(entry);
      for (const p of paths) {
        if (this.allFiles.has(p)) {
          this.coveredFiles.add(p);
          agentFiles.add(p);
        }
        // Synthesis agents read findings/*.json. Credit those even though
        // they're not in allFiles (which is source-only).
        if (/\/findings\/[^/]+\.json$/.test(p)) {
          findingsReadDelta++;
        }
      }
      // Probe agents make outbound network calls via shell / Bash with
      // URLs in the command. Rough heuristic: scan args for http(s) URLs
      // or typical CLI patterns (curl, httpie, wget).
      if (isNetworkProbe(entry)) {
        probeDelta++;
      }
    }

    const existing = this.coveredByAgent.get(agentName);
    if (existing) {
      for (const f of agentFiles) existing.add(f);
    } else {
      this.coveredByAgent.set(agentName, agentFiles);
    }
    if (findingsReadDelta > 0) {
      this.findingsReadByAgent.set(agentName, (this.findingsReadByAgent.get(agentName) ?? 0) + findingsReadDelta);
    }
    if (probeDelta > 0) {
      this.probeCountByAgent.set(agentName, (this.probeCountByAgent.get(agentName) ?? 0) + probeDelta);
    }
  }

  getFindingsReadByAgent(agentName: string): number {
    return this.findingsReadByAgent.get(agentName) ?? 0;
  }

  getProbeCountByAgent(agentName: string): number {
    return this.probeCountByAgent.get(agentName) ?? 0;
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

  // Count of distinct source files examined by a single agent. Populated
  // by recordAgentRun; used by the dispatcher to fill the TTY Files column
  // for every agent (chunked or not) after completion.
  getFilesExaminedByAgent(agentName: string): number {
    return this.coveredByAgent.get(agentName)?.size ?? 0;
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
   * Build the final coverage report. uncoveredFiles is canonicalized to
   * repo-relative paths when repoPath was provided — otherwise left absolute
   * for backwards compatibility with tests that pass only 2-3 args.
   */
  buildReport(): CoverageReport {
    const rawUncovered = this.allFilesArray
      .filter(f => !this.coveredFiles.has(f))
      .sort();

    const uncoveredFiles = this.repoPath
      ? rawUncovered.map(f => relative(this.repoPath!, f))
      : rawUncovered;

    const byAgent: CoverageReport['byAgent'] = [];
    const allAgentNames = new Set<string>([
      ...this.coveredByAgent.keys(),
      ...this.findingsReadByAgent.keys(),
      ...this.probeCountByAgent.keys(),
    ]);
    for (const agent of allAgentNames) {
      const entry: CoverageReport['byAgent'][number] = {
        agent,
        filesExamined: this.coveredByAgent.get(agent)?.size ?? 0,
      };
      const fr = this.findingsReadByAgent.get(agent);
      if (fr !== undefined && fr > 0) entry.findingsReadCount = fr;
      const pc = this.probeCountByAgent.get(agent);
      if (pc !== undefined && pc > 0) entry.probeCount = pc;
      byAgent.push(entry);
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

    // Normalize: accept both Claude CLI tool names (Read, Grep, Glob) and
    // Gemini CLI tool names (read_file, read_many_files, search_file_content,
    // glob, list_directory, edit, write_file). Arg names also differ:
    // Claude uses file_path / path; Gemini uses absolute_path / path / paths.
    const tool = entry.tool;

    // --- file-read operations ---
    if (
      tool === 'Read'
      || tool === 'Edit'
      || tool === 'Write'
      || tool === 'read_file'
      || tool === 'write_file'
      || tool === 'edit'
      || tool === 'replace'
    ) {
      const filePath = args.file_path ?? args.absolute_path ?? args.path;
      if (typeof filePath === 'string') {
        paths.push(this.normalizePath(filePath));
      }
      return paths;
    }

    // --- multi-file read (Gemini read_many_files) ---
    if (tool === 'read_many_files') {
      const filePaths = args.paths ?? args.absolute_paths;
      if (Array.isArray(filePaths)) {
        for (const p of filePaths) {
          if (typeof p === 'string') paths.push(this.normalizePath(p));
        }
      }
      return paths;
    }

    // --- directory / pattern scan operations — expand the dir to all
    //     matching files in allFilesArray so coverage credit is granted to
    //     every file under the scanned path ---
    if (
      tool === 'Grep'
      || tool === 'Glob'
      || tool === 'search_file_content'
      || tool === 'glob'
      || tool === 'list_directory'
    ) {
      const searchPath = args.path ?? args.absolute_path ?? args.directory;
      if (typeof searchPath === 'string') {
        const normalized = this.normalizePath(searchPath);
        for (const f of this.allFilesArray) {
          if (f === normalized || f.startsWith(normalized + '/')) {
            paths.push(f);
          }
        }
      }
      return paths;
    }

    // Unknown tool — no coverage credit (shell commands, web fetches, etc.)
    return paths;
  }

  // Resolve a tool-call file-path arg to its absolute form. When repoPath was
  // provided at construction, use it as the base — CLI adapters (Gemini,
  // Codex, Claude) run child processes with cwd=repoPath, so their tool_use
  // events often emit paths relative to the target repo, not the parent
  // orchestrator's cwd. Without this, Set.has() lookups against allFiles
  // (absolute paths rooted at repoPath) silently miss and coveredFiles
  // stays empty — the bug that froze the TTY at "0 / N files (0%)".
  private normalizePath(filePath: string): string {
    try {
      return this.repoPath ? resolve(this.repoPath, filePath) : resolve(filePath);
    } catch {
      return filePath;
    }
  }
}

// Detect a probe-style tool call: a Bash/shell invocation whose command
// looks like an outbound network call. Used to tally probeCount for
// live-probe agents (api-contract-prober, e2e-tester) whose "coverage"
// metric is requests made, not files read.
const PROBE_COMMAND_RE = /\b(curl|wget|http|httpie|xh|fetch)\b|https?:\/\//i;

function isNetworkProbe(entry: ToolCallLogEntry): boolean {
  if (entry.tool !== 'Bash' && entry.tool !== 'run_shell_command' && entry.tool !== 'shell') {
    return false;
  }
  const cmd = (entry.args as { command?: unknown }).command;
  const cmdStr = typeof cmd === 'string'
    ? cmd
    : Array.isArray(cmd) ? cmd.map(String).join(' ')
    : '';
  return PROBE_COMMAND_RE.test(cmdStr);
}
