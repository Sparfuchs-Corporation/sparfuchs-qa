import { execSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import type { ChunkPlan, FileChunk, AgentDefinition } from './types.js';

const DEFAULT_CHUNK_SIZE = 25;
const MAX_CHUNK_SIZE = 35;
const CHUNKING_THRESHOLD = 50;

const SOURCE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'rb',
  'vue', 'svelte', 'astro',
];

const EXCLUDE_DIRS = [
  'node_modules', 'dist', 'build', '.next', '.nuxt', 'out',
  'vendor', '__pycache__', '.git', 'coverage', '.turbo',
  'target', 'bin', 'obj', '.cache',
];

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

/**
 * Discover all source files in the repo, respecting module scope and exclusions.
 */
export function discoverSourceFiles(
  repoPath: string,
  moduleScope?: string,
  excludedFiles?: Set<string>,
): string[] {
  const searchRoot = moduleScope ? join(repoPath, moduleScope) : repoPath;
  const extGlob = SOURCE_EXTENSIONS.map(e => `*.${e}`).join(',');
  const excludeArgs = EXCLUDE_DIRS.map(d => `--exclude-dir=${d}`).join(' ');

  // Use find for reliable cross-platform file discovery
  const cmd = `find "${searchRoot}" -type f \\( ${SOURCE_EXTENSIONS.map(e => `-name "*.${e}"`).join(' -o ')} \\) ${EXCLUDE_DIRS.map(d => `-not -path "*/${d}/*"`).join(' ')} 2>/dev/null | sort`;

  try {
    const output = execSync(cmd, { maxBuffer: 5 * 1024 * 1024, encoding: 'utf8' });
    let files = output.trim().split('\n').filter(Boolean);

    if (excludedFiles?.size) {
      files = files.filter(f => !excludedFiles.has(f));
    }

    return files;
  } catch {
    return [];
  }
}

/**
 * Build a chunk plan for the given file list and agent set.
 * Returns null if chunking is not needed (<=CHUNKING_THRESHOLD files).
 */
export function buildChunkPlan(
  allFiles: string[],
  agents: AgentDefinition[],
  excludedFiles: string[] = [],
): ChunkPlan | null {
  const checkableFiles = allFiles.filter(f => !excludedFiles.includes(f));

  if (checkableFiles.length <= CHUNKING_THRESHOLD) {
    return null;
  }

  const chunks = groupIntoChunks(checkableFiles);
  const agentNames = agents.map(a => a.name);

  return {
    totalFiles: allFiles.length,
    checkableFiles: checkableFiles.length,
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunks,
    chunkedAgents: agentNames.filter(n => CHUNKED_AGENT_NAMES.has(n)),
    unchunkedAgents: agentNames.filter(n => !CHUNKED_AGENT_NAMES.has(n)),
    excludedFiles,
  };
}

/**
 * Group files into chunks of ~DEFAULT_CHUNK_SIZE, keeping files from the same
 * directory together for context coherence.
 */
function groupIntoChunks(files: string[]): FileChunk[] {
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

    // If adding this directory would exceed MAX_CHUNK_SIZE, flush current chunk first
    if (currentFiles.length > 0 && currentFiles.length + dirFiles.length > MAX_CHUNK_SIZE) {
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
    if (currentFiles.length >= DEFAULT_CHUNK_SIZE) {
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
    `Source files: ${plan.totalFiles} (${plan.checkableFiles} checkable, ${plan.excludedFiles.length} excluded)`,
    `Chunk size: ${plan.chunkSize}`,
    `Chunks: ${plan.chunks.length}`,
    `Chunked agents: ${plan.chunkedAgents.join(', ')} (${plan.chunkedAgents.length} x ${plan.chunks.length} instances)`,
    `Unchunked agents: ${plan.unchunkedAgents.join(', ')}`,
  ];
  return lines.join('\n');
}
