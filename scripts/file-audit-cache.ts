/**
 * File Audit Cache — Incremental auditing support
 *
 * Tracks which files were audited at which commit, enabling subsequent runs
 * to only re-audit changed files while carrying forward cached findings.
 *
 * Usage:
 *   npx tsx scripts/file-audit-cache.ts --project <slug> --repo <path> <command>
 *
 * Commands:
 *   changed   — List files changed since last full audit
 *   update    — Update cache after a run (reads findings from stdin or --run-dir)
 *   status    — Show cache status (last audit, file count, staleness)
 *   reset     — Delete cache (forces next run to be full)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { FileAuditCache, FileAuditEntry, QaFinding } from '../lib/types';

const SCHEMA_VERSION = 1;
const STALE_THRESHOLD_DAYS = 30;

function getCachePath(projectSlug: string): string {
  return join('qa-data', projectSlug, 'file-audit-cache.json');
}

function readCache(projectSlug: string): FileAuditCache | null {
  const path = getCachePath(projectSlug);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const cache = JSON.parse(raw) as FileAuditCache;
    if (cache.schemaVersion !== SCHEMA_VERSION) {
      console.error(`Cache schema version mismatch: expected ${SCHEMA_VERSION}, got ${cache.schemaVersion}`);
      return null;
    }
    return cache;
  } catch {
    console.error('Failed to read cache file, treating as empty');
    return null;
  }
}

function writeCache(projectSlug: string, cache: FileAuditCache): void {
  const path = getCachePath(projectSlug);
  const dir = join('qa-data', projectSlug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

function getChangedFiles(repoPath: string, sinceCommit: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${sinceCommit}..HEAD`, {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    return output
      .trim()
      .split('\n')
      .filter(f => f.length > 0);
  } catch {
    console.error(`Failed to get diff since ${sinceCommit}, treating all files as changed`);
    return [];
  }
}

function getNewFiles(repoPath: string, cache: FileAuditCache): string[] {
  try {
    const output = execSync(
      `find . -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' | grep -v node_modules | grep -v dist | grep -v .git`,
      { cwd: repoPath, encoding: 'utf-8' },
    );
    const allFiles = output
      .trim()
      .split('\n')
      .map(f => f.replace(/^\.\//, ''))
      .filter(f => f.length > 0);
    return allFiles.filter(f => !(f in cache.files));
  } catch {
    return [];
  }
}

function hashFileContent(repoPath: string, filePath: string): string {
  try {
    const content = readFileSync(join(repoPath, filePath), 'utf-8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

function isStale(cache: FileAuditCache): boolean {
  const lastAudit = new Date(cache.lastFullAudit.timestamp);
  const daysSince = (Date.now() - lastAudit.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince > STALE_THRESHOLD_DAYS;
}

function cmdChanged(projectSlug: string, repoPath: string): void {
  const cache = readCache(projectSlug);
  if (!cache) {
    console.log('NO_CACHE');
    console.error('No cache found — a full audit is required');
    return;
  }

  if (isStale(cache)) {
    console.error(
      `WARNING: Cache is stale (last full audit: ${cache.lastFullAudit.timestamp}). Consider running --full.`,
    );
  }

  const changed = getChangedFiles(repoPath, cache.lastFullAudit.commitSha);
  const newFiles = getNewFiles(repoPath, cache);
  const allAffected = [...new Set([...changed, ...newFiles])];

  console.log(JSON.stringify({ changed, newFiles, total: allAffected.length }, null, 2));
}

function cmdUpdate(projectSlug: string, repoPath: string, runId: string, isFull: boolean): void {
  const commitSha = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf-8' }).trim();
  const runDir = join('qa-data', projectSlug, 'runs', runId);
  const findingsPath = join(runDir, 'findings-final.json');

  let findings: QaFinding[] = [];
  if (existsSync(findingsPath)) {
    findings = JSON.parse(readFileSync(findingsPath, 'utf-8'));
  }

  const existingCache = readCache(projectSlug);

  const cache: FileAuditCache = {
    schemaVersion: SCHEMA_VERSION,
    lastFullAudit: isFull
      ? { runId, commitSha, timestamp: new Date().toISOString() }
      : existingCache?.lastFullAudit ?? { runId, commitSha, timestamp: new Date().toISOString() },
    files: isFull ? {} : { ...existingCache?.files },
  };

  // Group findings by file
  const findingsByFile = new Map<string, QaFinding[]>();
  for (const f of findings) {
    if (!findingsByFile.has(f.file)) findingsByFile.set(f.file, []);
    findingsByFile.get(f.file)!.push(f);
  }

  // Update cache entries for audited files
  const auditedFiles = new Set(findings.map(f => f.file));
  for (const file of auditedFiles) {
    const fileFindings = findingsByFile.get(file) ?? [];
    cache.files[file] = {
      lastAuditedRunId: runId,
      lastAuditedCommitSha: commitSha,
      contentHash: hashFileContent(repoPath, file),
      findingIds: fileFindings.map(f => f.id),
      agents: [...new Set(fileFindings.map(f => f.agent))],
    };
  }

  writeCache(projectSlug, cache);
  console.log(
    `Cache updated: ${auditedFiles.size} files audited, ${Object.keys(cache.files).length} total cached`,
  );
}

function cmdStatus(projectSlug: string): void {
  const cache = readCache(projectSlug);
  if (!cache) {
    console.log('No cache exists for this project');
    return;
  }

  const fileCount = Object.keys(cache.files).length;
  const stale = isStale(cache);
  const daysSince = Math.floor(
    (Date.now() - new Date(cache.lastFullAudit.timestamp).getTime()) / (1000 * 60 * 60 * 24),
  );

  console.log(JSON.stringify({
    lastFullAudit: cache.lastFullAudit,
    cachedFiles: fileCount,
    daysSinceFullAudit: daysSince,
    isStale: stale,
    recommendation: stale ? 'Run --full to refresh cache' : 'Incremental audit OK',
  }, null, 2));
}

function cmdReset(projectSlug: string): void {
  const path = getCachePath(projectSlug);
  if (existsSync(path)) {
    const { unlinkSync } = require('node:fs');
    unlinkSync(path);
    console.log(`Cache deleted: ${path}`);
  } else {
    console.log('No cache to delete');
  }
}

// --- CLI ---

const args = process.argv.slice(2);
let projectSlug = '';
let repoPath = process.cwd();
let runId = '';
let isFull = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--project':
      projectSlug = args[++i];
      break;
    case '--repo':
      repoPath = resolve(args[++i]);
      break;
    case '--run-id':
      runId = args[++i];
      break;
    case '--full':
      isFull = true;
      break;
  }
}

const command = args.find(a => !a.startsWith('--') && args.indexOf(a) > 0) ?? args[0];

if (!projectSlug) {
  console.error('Error: --project is required');
  process.exit(1);
}

switch (command) {
  case 'changed':
    cmdChanged(projectSlug, repoPath);
    break;
  case 'update':
    if (!runId) {
      console.error('Error: --run-id is required for update');
      process.exit(1);
    }
    cmdUpdate(projectSlug, repoPath, runId, isFull);
    break;
  case 'status':
    cmdStatus(projectSlug);
    break;
  case 'reset':
    cmdReset(projectSlug);
    break;
  default:
    console.error('Usage: file-audit-cache.ts --project <slug> --repo <path> <changed|update|status|reset>');
    process.exit(1);
}
