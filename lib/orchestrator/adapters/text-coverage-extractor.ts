import { resolve, relative } from 'node:path';
import type { ToolCallLogEntry } from '../types.js';

// --- Text-Based Coverage Extractor ---
// Heuristic file path extraction from unstructured CLI text output.
// Used by adapters without structured output (e.g., OpenClaw).
// All paths validated against knownFiles to prevent false positives.

// Common source file extensions to match
const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cpp|h|hpp|cs|php|vue|svelte|astro|html|css|scss|less|sql|graphql|proto|yaml|yml|json|toml|xml|md|mdx|sh|bash|zsh|dockerfile)$/i;

// Pattern 1: Grep-style output — "path/to/file.ts:123:" or "path/to/file.ts:123:45:"
const GREP_STYLE_RE = /^([a-zA-Z0-9_./@\-][a-zA-Z0-9_./@\-]*\.[a-zA-Z]{1,5}):\d+/;

// Pattern 2: Explicit read/file references — "Reading /path/to/file" or "File: path/to/file"
const READ_STYLE_RE = /(?:Reading|Analyzing|Examining|Reviewing|File:?|file_path:?)\s+["`']?([a-zA-Z0-9_./@\-][a-zA-Z0-9_./@\-]*\.[a-zA-Z]{1,5})["`']?/i;

// Pattern 3: Markdown code block with filename — ```ts // src/foo.ts
const MARKDOWN_FILE_RE = /```\w*\s*(?:\/\/|#|--)\s*([a-zA-Z0-9_./@\-][a-zA-Z0-9_./@\-]*\.[a-zA-Z]{1,5})/;

// Pattern 4: Bare paths that look like source files (must contain / to reduce false positives)
const BARE_PATH_RE = /(?:^|\s|['"`(])([a-zA-Z0-9_@][a-zA-Z0-9_./@\-]*\/[a-zA-Z0-9_./@\-]*\.[a-zA-Z]{1,5})(?:\s|['"`),;:]|$)/;

/**
 * Extract file paths from unstructured agent text output.
 * Returns synthetic ToolCallLogEntry[] that the babysitter can process.
 *
 * All extracted paths are validated against knownFiles to eliminate false positives.
 * Deduplication: each file appears at most once in the result.
 */
export function extractToolCallsFromText(
  text: string,
  repoPath: string,
  knownFiles: ReadonlySet<string>,
): ToolCallLogEntry[] {
  const foundPaths = new Set<string>();
  const lines = text.split('\n');

  for (const line of lines) {
    const path = extractPathFromLine(line);
    if (path) {
      const resolved = resolvePath(path, repoPath);
      if (resolved && knownFiles.has(resolved)) {
        foundPaths.add(resolved);
      }
    }
  }

  const timestamp = new Date().toISOString();
  return [...foundPaths].sort().map(filePath => ({
    tool: 'Read',
    args: { file_path: filePath },
    timestamp,
  }));
}

function extractPathFromLine(line: string): string | null {
  // Try patterns in order of specificity (most reliable first)
  let match: RegExpMatchArray | null;

  match = line.match(GREP_STYLE_RE);
  if (match?.[1] && SOURCE_EXT_RE.test(match[1])) return match[1];

  match = line.match(READ_STYLE_RE);
  if (match?.[1] && SOURCE_EXT_RE.test(match[1])) return match[1];

  match = line.match(MARKDOWN_FILE_RE);
  if (match?.[1] && SOURCE_EXT_RE.test(match[1])) return match[1];

  match = line.match(BARE_PATH_RE);
  if (match?.[1] && SOURCE_EXT_RE.test(match[1])) return match[1];

  return null;
}

function resolvePath(filePath: string, repoPath: string): string | null {
  try {
    // Handle both absolute and relative paths
    if (filePath.startsWith('/')) {
      const resolved = resolve(filePath);
      // Must be within the repo
      if (resolved.startsWith(repoPath + '/') || resolved === repoPath) {
        return resolved;
      }
      return null;
    }

    // Relative path — resolve against repo root
    return resolve(repoPath, filePath);
  } catch {
    return null;
  }
}
