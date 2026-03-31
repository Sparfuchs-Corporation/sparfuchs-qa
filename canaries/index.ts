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
      const summary = {
        total: results.length,
        passed: results.filter(r => r.severity !== 'HIGH').length,
        failed: results.filter(r => r.severity === 'HIGH').length,
        bySeverity: { LOW: 0, MEDIUM: 0, HIGH: 0 }
      };
      results.forEach(r => summary.bySeverity[r.severity]++);

      const doc: Omit<QaCanaryRun, 'timestamp'> = {
        runId: output.runId,
        projectId: process.env.GOOGLE_CLOUD_PROJECT || 'theforge-dev-1771601127',
        branch,
        commitSha: sha,
        environment: process.env.CLOUD_BUILD ? 'cloud-build' : 'local',
        results,
        summary,
        source: process.env.CLOUD_BUILD ? 'cloud-build' : 'local',
        forecastNotes: summary.bySeverity.HIGH > 2 ? 'Multiple high-severity canaries detected' : 'Stable'
      };

      await db.collection(COLLECTIONS.CANARY_RUNS).add(doc);
      console.error('✅ Canary history pushed to Firestore');
    } catch (e) {
      console.error('⚠️ Firestore push failed (non-blocking)', e);
    }
  }
}

runAllCanaries().catch(console.error);
