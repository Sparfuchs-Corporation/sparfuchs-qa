import fs from 'fs';
import { execSync } from 'child_process';
import { db, COLLECTIONS } from '../lib/firestore';
import type { QaCanaryRun, CanaryResult } from '../lib/types';

async function runAllCanaries() {
  const results: CanaryResult[] = [];
  const canaryFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.canary.ts'));

  for (const file of canaryFiles) {
    const canary = await import(`./${file}`);
    const result = await canary.default();
    results.push(result);
  }

  const output = { runId: `run-${Date.now()}`, timestamp: new Date().toISOString(), results };
  console.log(JSON.stringify(output, null, 2));

  if (process.env.QA_PUSH_FIRESTORE === '1') {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
      const sha = execSync('git rev-parse HEAD').toString().trim();
      const summary = { total: results.length, passed: results.filter(r => r.severity !== 'HIGH').length, failed: results.filter(r => r.severity === 'HIGH').length, bySeverity: { LOW: 0, MEDIUM: 0, HIGH: 0 } };
      results.forEach(r => summary.bySeverity[r.severity]++);
      const doc: Omit<QaCanaryRun, 'timestamp'> = { runId: output.runId, projectId: process.env.GOOGLE_CLOUD_PROJECT || 'theforge-dev-1771601127', branch, commitSha: sha, environment: process.env.CLOUD_BUILD ? 'cloud-build' : 'local', results, summary, source: process.env.CLOUD_BUILD ? 'cloud-build' : 'local', forecastNotes: summary.bySeverity.HIGH > 2 ? 'Multiple high-severity canaries detected' : 'Stable' };
      await db.collection(COLLECTIONS.CANARY_RUNS).add(doc);
      console.error('✅ History saved');
    } catch (e) { console.error('⚠️ Firestore push failed (non-blocking)', e); }
  }

  return results;
}

// --- Watch Mode ---

const WATCH_DEBOUNCE_MS = 1000;

async function runWatchMode() {
  const targetRepo = process.env.TARGET_REPO || process.cwd();
  console.error(`Watching ${targetRepo} for changes... (Ctrl+C to stop)\n`);

  // Run once immediately
  await runAllCanaries();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  fs.watch(targetRepo, { recursive: true }, (eventType, filename) => {
    if (!filename) return;

    // Skip non-source files and common noise
    if (
      filename.includes('node_modules') ||
      filename.includes('.git') ||
      filename.includes('dist') ||
      filename.includes('build') ||
      filename.includes('coverage') ||
      filename.endsWith('.log')
    ) return;

    // Debounce rapid file changes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      console.error(`\n--- File changed: ${filename} — re-running canaries ---\n`);
      try {
        await runAllCanaries();
      } catch (err) {
        console.error('Canary run failed:', err);
      }
    }, WATCH_DEBOUNCE_MS);
  });
}

// --- Entry Point ---

const isWatchMode = process.argv.includes('--watch') || process.argv.includes('-w');

if (isWatchMode) {
  runWatchMode().catch(console.error);
} else {
  runAllCanaries().catch(console.error);
}
