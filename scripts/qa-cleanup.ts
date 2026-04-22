/**
 * qa-cleanup — Archive old runs and compact finding index
 *
 * Usage:
 *   npx tsx scripts/qa-cleanup.ts --project <your-project-slug> --keep 10
 *   npx tsx scripts/qa-cleanup.ts --project <your-project-slug> --older-than 90d
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FindingRegistryEntry } from '../lib/types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const QA_DATA_ROOT = join(MODULE_DIR, '..', 'qa-data');
const CLOSED_RETENTION_DAYS = 90;

function parseArgs(): { project: string; keep: number } {
  const args = process.argv.slice(2);
  let project = '';
  let keep = 10;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) project = args[++i];
    if (args[i] === '--keep' && args[i + 1]) keep = parseInt(args[++i], 10);
  }

  if (!project) {
    console.error('Usage: npx tsx scripts/qa-cleanup.ts --project <slug> [--keep <n>]');
    process.exit(1);
  }
  return { project, keep };
}

function main() {
  const { project, keep } = parseArgs();
  const projectDir = join(QA_DATA_ROOT, project);
  const runsDir = join(projectDir, 'runs');

  if (!existsSync(runsDir)) {
    console.log(`No runs directory found for "${project}".`);
    return;
  }

  // List all runs sorted by name (which sorts chronologically since format is qa-YYYYMMDD-HHmm-xxxx)
  const allRuns = readdirSync(runsDir)
    .filter((d) => d.startsWith('qa-') && statSync(join(runsDir, d)).isDirectory())
    .sort();

  console.log(`Found ${allRuns.length} runs for "${project}" (keeping ${keep})`);

  if (allRuns.length <= keep) {
    console.log('Nothing to clean up.');
  } else {
    const toArchive = allRuns.slice(0, allRuns.length - keep);
    for (const runId of toArchive) {
      const runPath = join(runsDir, runId);
      // Keep meta.json and delta.json, remove large files
      const largeFiles = ['findings.jsonl', 'findings-final.json'];
      let cleaned = 0;
      for (const file of largeFiles) {
        const filePath = join(runPath, file);
        if (existsSync(filePath)) {
          rmSync(filePath);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        console.log(`  Archived ${runId}: removed ${cleaned} large file(s), kept meta.json + delta.json`);
      }
    }
  }

  // Compact finding index: remove closed entries older than retention period
  const indexPath = join(projectDir, 'findings', 'index.json');
  if (existsSync(indexPath)) {
    const index: FindingRegistryEntry[] = JSON.parse(readFileSync(indexPath, 'utf-8'));
    const cutoff = new Date(Date.now() - CLOSED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const before = index.length;
    const compacted = index.filter((entry) => {
      if (entry.lifecycle === 'closed' && entry.closedAt && entry.closedAt < cutoff) {
        return false;
      }
      return true;
    });

    const removed = before - compacted.length;
    if (removed > 0) {
      writeFileSync(indexPath, JSON.stringify(compacted, null, 2));
      console.log(`Compacted finding index: removed ${removed} closed entries older than ${CLOSED_RETENTION_DAYS} days`);
    } else {
      console.log('Finding index: no entries to compact.');
    }
  }

  console.log('Cleanup complete.');
}

main();
