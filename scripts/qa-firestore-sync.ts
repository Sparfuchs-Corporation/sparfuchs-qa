/**
 * qa-firestore-sync — Push local QA data to Firestore (optional)
 *
 * Usage:
 *   npx tsx scripts/qa-firestore-sync.ts --project the-forge --latest
 *   npx tsx scripts/qa-firestore-sync.ts --project the-forge --run qa-20260404-0800-ab12
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QaFinding, QaRunMeta, RunDelta, EvolutionPattern, QaIngestPayload } from '../lib/types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const QA_DATA_ROOT = join(MODULE_DIR, '..', 'qa-data');

function parseArgs(): { project: string; runId?: string; latest: boolean } {
  const args = process.argv.slice(2);
  let project = '';
  let runId: string | undefined;
  let latest = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) project = args[++i];
    if (args[i] === '--run' && args[i + 1]) runId = args[++i];
    if (args[i] === '--latest') latest = true;
  }

  if (!project) {
    console.error('Usage: npx tsx scripts/qa-firestore-sync.ts --project <slug> [--latest | --run <id>]');
    process.exit(1);
  }
  return { project, runId, latest };
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function getLatestRunId(projectSlug: string): string | null {
  const runsDir = join(QA_DATA_ROOT, projectSlug, 'runs');
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir).filter((d) => d.startsWith('qa-')).sort().reverse();
  return runs[0] ?? null;
}

async function main() {
  const { project, runId, latest } = parseArgs();
  const targetRunId = runId ?? (latest ? getLatestRunId(project) : null);

  if (!targetRunId) {
    console.error('Specify --latest or --run <id>');
    process.exit(1);
  }

  const runDir = join(QA_DATA_ROOT, project, 'runs', targetRunId);
  const meta = loadJson<QaRunMeta>(join(runDir, 'meta.json'));
  const findings = loadJson<QaFinding[]>(join(runDir, 'findings-final.json')) ?? [];
  const delta = loadJson<RunDelta>(join(runDir, 'delta.json'));
  const patterns = loadJson<EvolutionPattern[]>(join(QA_DATA_ROOT, project, 'evolution', 'patterns.json'));

  if (!meta) {
    console.error(`No meta.json found for run ${targetRunId}`);
    process.exit(1);
  }

  const payload: QaIngestPayload = {
    version: 1,
    projectSlug: project,
    run: meta,
    findings,
    delta,
    evolution: patterns,
  };

  // Push to Firestore via the existing client
  try {
    const { db, COLLECTIONS } = await import('../lib/firestore.js');

    // Write run document
    await db.collection(COLLECTIONS.FINDINGS).doc(targetRunId).set({
      ...meta,
      findingCount: findings.length,
      syncedAt: new Date().toISOString(),
    });

    // Write findings as subcollection
    const batch = db.batch();
    for (const finding of findings) {
      const ref = db.collection(COLLECTIONS.FINDINGS).doc(targetRunId).collection('items').doc(finding.id);
      batch.set(ref, finding);
    }
    await batch.commit();

    console.log(`Synced run ${targetRunId} to Firestore: ${findings.length} findings`);

    if (delta) {
      console.log(`  Delta: ${delta.newFindings.length} new, ${delta.remediatedFindings.length} remediated, ${delta.closureRate}% closure`);
    }
  } catch (err) {
    console.error('Firestore sync failed:', err);
    console.log('\nPayload that would have been sent:');
    console.log(JSON.stringify(payload, null, 2).slice(0, 500) + '...');
    process.exit(1);
  }
}

main();
