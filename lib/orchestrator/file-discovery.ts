// file-discovery — single source of truth for source-file discovery.
//
// Called from:
//   - chunker.ts (builds agent work lists)
//   - testability-scanner.ts (repo profile + uncheckable detection)
//   - preflight.ts (repo census before dispatch)
//
// Three prior inline exclusion lists (chunker + two in testability-scanner)
// produced the April-23 run's path-format mix and the .venv budget blow-up.
// Everything now goes through EXCLUDE_DIRS below.
//
// Returned paths are always absolute. Set.has() lookups downstream (coverage
// babysitter, uncovered-file tracking) depend on a single format.

import { execSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';

export const SOURCE_EXTENSIONS: readonly string[] = [
  'ts', 'tsx', 'mts',
  'js', 'jsx', 'mjs', 'cjs',
  'py',
  'go', 'rs',
  'java', 'kt',
  'rb',
  'vue', 'svelte', 'astro',
  'swift', 'cs', 'php',
];

// Dirs that never produce real source. Order groups related entries for
// readability only — `find -not -path` treats them as a set.
export const EXCLUDE_DIRS: readonly string[] = [
  // Node / JS build output
  'node_modules', 'dist', 'build', '.next', '.nuxt', 'out',
  'target', 'bin', 'obj', '.cache', '.turbo',
  // VCS / CI / IDE metadata
  '.git', '.github', '.githooks', '.claude', '.worktrees',
  '.gemini', '.antigravity', '.agent', '.firebase', '.doc',
  // Generated / vendored
  'vendor', 'generated',
  // Python envs + caches (the Forge run's 45% budget leak)
  '.venv', 'venv', '__pycache__', '.tox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
  // Test and coverage artifacts
  'coverage', 'playwright-report', 'test-results',
  // Module Federation temp output
  '.__mf__temp',
];

/**
 * Discover all source files. Returns absolute paths, sorted.
 *
 * @param repoPath absolute (or process-cwd-relative) repo root
 * @param moduleScope subdirectory to limit discovery to (MODULE=... knob)
 * @param excludedFiles explicit file-path set to drop (from testability-scanner's uncheckable report)
 */
export function discoverSourceFiles(
  repoPath: string,
  moduleScope?: string,
  excludedFiles?: Set<string>,
): string[] {
  const absRoot = resolvePath(repoPath, moduleScope ?? '');
  const nameClauses = SOURCE_EXTENSIONS.map(e => `-name "*.${e}"`).join(' -o ');
  const cmd = `find "${absRoot}" -type f \\( ${nameClauses} \\) ${excludePathArgsForFind()} 2>/dev/null | sort`;

  let files: string[];
  try {
    const output = execSync(cmd, { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
    files = output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }

  // Defensive canonicalization. `find "$absRoot"` emits absolute paths, but
  // resolvePath normalizes `//` / trailing slash edge cases so Set.has()
  // downstream compares consistently.
  files = files.map(f => resolvePath(absRoot, f));

  if (excludedFiles?.size) {
    files = files.filter(f => !excludedFiles.has(f));
  }
  return files;
}

/**
 * Count files by extension across the whole repo (every extension, not just
 * source). Testability-scanner uses this to build repoProfile.languages.
 */
export function countFilesByExtension(
  repoPath: string,
  moduleScope?: string,
): Map<string, number> {
  const absRoot = resolvePath(repoPath, moduleScope ?? '');
  const cmd = `find "${absRoot}" -type f ${excludePathArgsForFind()} 2>/dev/null | sed 's/.*\\./\\./' | sort | uniq -c | sort -rn`;

  const counts = new Map<string, number>();
  try {
    const output = execSync(cmd, { maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)\s+(\.\S+)$/);
      if (match) {
        counts.set(match[2], parseInt(match[1], 10));
      }
    }
  } catch { /* empty */ }
  return counts;
}

/**
 * Count all files under the repo (excluding EXCLUDE_DIRS). Used by
 * testability-scanner's checkability denominator.
 */
export function countAllFiles(repoPath: string, moduleScope?: string): number {
  const absRoot = resolvePath(repoPath, moduleScope ?? '');
  const cmd = `find "${absRoot}" -type f ${excludePathArgsForFind()} 2>/dev/null | wc -l`;
  try {
    const output = execSync(cmd, { encoding: 'utf8' });
    return parseInt(output.trim(), 10) || 0;
  } catch { return 0; }
}

// --- shared CLI flag builders ---

// Emits `-not -path "*\/NAME\/*"` arguments for `find`.
export function excludePathArgsForFind(): string {
  return EXCLUDE_DIRS.map(d => `-not -path "*/${d}/*"`).join(' ');
}

// Emits `--exclude-dir=NAME` arguments for `grep -r`.
export function excludeDirArgsForGrep(): string {
  return EXCLUDE_DIRS.map(d => `--exclude-dir=${d}`).join(' ');
}
