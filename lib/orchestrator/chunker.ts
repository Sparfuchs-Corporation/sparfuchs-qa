import { dirname, relative } from 'node:path';
import type { ChunkPlan, FileChunk, AgentDefinition, CoverageStrategy } from './types.js';
import { getStrategyConfig } from './coverage-babysitter.js';
import { discoverSourceFiles as _discoverSourceFiles } from './file-discovery.js';

const CHUNKING_THRESHOLD = 50;

// Agents that need to see every file (general-purpose analysis)
const CHUNKED_AGENT_NAMES = new Set([
  'code-reviewer',
  'security-reviewer',
  'performance-reviewer',
  'a11y-reviewer',
  'observability-auditor',
]);

export function isChunkedAgent(name: string): boolean {
  return CHUNKED_AGENT_NAMES.has(name);
}

// Re-exported from file-discovery.ts so callers continue to import from
// chunker (historical call site in lib/orchestrator/index.ts). The unified
// implementation lives in file-discovery.ts; see that module for the shared
// EXCLUDE_DIRS list used by the chunker, testability-scanner, and preflight.
export const discoverSourceFiles = _discoverSourceFiles;

/**
 * Build a chunk plan for the given file list and agent set.
 * Returns null if chunking is not needed (<=CHUNKING_THRESHOLD files).
 */
export function buildChunkPlan(
  allFiles: string[],
  agents: AgentDefinition[],
  excludedFiles: string[] = [],
  strategy: CoverageStrategy = 'balanced',
): ChunkPlan | null {
  const checkableFiles = allFiles.filter(f => !excludedFiles.includes(f));

  // When the checkable pool is under the threshold, the dispatcher gives
  // every chunked agent the full file list rather than slicing it. The null
  // return is the signal for that mode; we log here so the behavior is
  // visible in session logs and the operator doesn't mistake it for a bug.
  if (checkableFiles.length <= CHUNKING_THRESHOLD) {
    process.stderr.write(
      `[chunker] chunking disabled (${checkableFiles.length} source files ≤ CHUNKING_THRESHOLD=${CHUNKING_THRESHOLD}); ` +
      `all chunked agents will see the full list\n`,
    );
    return null;
  }

  const strategyConfig = getStrategyConfig(strategy);
  const chunks = groupIntoChunks(checkableFiles, strategyConfig.chunkSize, strategyConfig.maxChunkSize);
  const agentNames = agents.map(a => a.name);

  return {
    totalFiles: allFiles.length,
    checkableFiles: checkableFiles.length,
    chunkSize: strategyConfig.chunkSize,
    chunks,
    chunkedAgents: agentNames.filter(n => CHUNKED_AGENT_NAMES.has(n)),
    unchunkedAgents: agentNames.filter(n => !CHUNKED_AGENT_NAMES.has(n)),
    excludedFiles,
    strategy,
  };
}

/**
 * Group files into chunks of ~chunkSize, keeping files from the same
 * directory together for context coherence.
 */
function groupIntoChunks(files: string[], chunkSize: number, maxChunkSize: number): FileChunk[] {
  // Group by parent directory
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const dir = dirname(file);
    const group = byDir.get(dir) ?? [];
    group.push(file);
    byDir.set(dir, group);
  }

  // Sort directories for deterministic output
  const sortedDirs = [...byDir.keys()].sort();

  const chunks: FileChunk[] = [];
  let currentFiles: string[] = [];
  let currentDir = '';

  for (const dir of sortedDirs) {
    const dirFiles = byDir.get(dir)!;

    // If adding this directory would exceed maxChunkSize, flush current chunk first
    if (currentFiles.length > 0 && currentFiles.length + dirFiles.length > maxChunkSize) {
      chunks.push({
        id: chunks.length + 1,
        files: currentFiles,
        primaryDirectory: currentDir,
      });
      currentFiles = [];
    }

    currentFiles.push(...dirFiles);
    if (!currentDir || dirFiles.length > (byDir.get(currentDir)?.length ?? 0)) {
      currentDir = dir;
    }

    // If current chunk hit the target size, flush
    if (currentFiles.length >= chunkSize) {
      chunks.push({
        id: chunks.length + 1,
        files: currentFiles,
        primaryDirectory: currentDir,
      });
      currentFiles = [];
      currentDir = '';
    }
  }

  // Flush remaining files
  if (currentFiles.length > 0) {
    chunks.push({
      id: chunks.length + 1,
      files: currentFiles,
      primaryDirectory: currentDir,
    });
  }

  return chunks;
}

/**
 * Build a delegation prompt suffix for a chunked agent instance.
 */
export function buildChunkPromptSuffix(chunk: FileChunk, totalChunks: number, repoPath: string): string {
  const relativeFiles = chunk.files.map(f => relative(repoPath, f));
  return (
    `\n\nCHUNKED ANALYSIS — Chunk ${chunk.id} of ${totalChunks}\n` +
    `Review ONLY these ${chunk.files.length} files:\n` +
    relativeFiles.map(f => `  ${f}`).join('\n') + '\n' +
    `Do NOT analyze files outside this list. Other chunks cover the rest of the codebase.\n`
  );
}

/**
 * Format a chunk plan summary for logging.
 */
export function formatChunkPlanSummary(plan: ChunkPlan): string {
  const lines = [
    `Strategy: ${plan.strategy}`,
    `Source files: ${plan.totalFiles} (${plan.checkableFiles} checkable, ${plan.excludedFiles.length} excluded)`,
    `Chunk size: ${plan.chunkSize}`,
    `Chunks: ${plan.chunks.length}`,
    `Chunked agents: ${plan.chunkedAgents.join(', ')} (${plan.chunkedAgents.length} x ${plan.chunks.length} instances)`,
    `Unchunked agents: ${plan.unchunkedAgents.join(', ')}`,
  ];
  return lines.join('\n');
}
