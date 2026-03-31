import { db, COLLECTIONS } from '../lib/firestore';
import { execSync } from 'child_process';
import type { QaCanaryRun } from '../lib/types';

async function evolveAgents(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const snapshot = await db.collection(COLLECTIONS.CANARY_RUNS).where('timestamp', '>=', cutoff).orderBy('timestamp', 'desc').limit(20).get();
  const runs = snapshot.docs.map(d => d.data() as QaCanaryRun);
  const summary = runs.reduce((acc, run) => { run.results.forEach(r => { if (!acc[r.id]) acc[r.id] = { name: r.name, failures: 0, total: 0 }; acc[r.id].total++; if (r.severity === 'HIGH') acc[r.id].failures++; }); return acc; }, {} as any);
  const prompt = `You are the Lead QA Agent. Here is the last ${days} days of canary history:\n${JSON.stringify(summary, null, 2)}\n\nIdentify: 1. Canaries that are consistently passing → tighten thresholds 2. Canaries that are consistently failing → suggest investigation 3. New canaries we should add. Output ONLY a structured list of evolution suggestions (max 5).`;
  console.log('=== EVOLVE PROMPT ===\n', prompt);
  if (process.env.QA_EVOLVE_DRY !== '1') {
    try { const output = execSync(`claude "${prompt.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }); console.log('\n=== CLAUDE EVOLUTION OUTPUT ===\n', output); } catch (e) { console.error('Claude CLI not available'); }
  }
}
const days = process.argv.includes('--days') ? parseInt(process.argv[process.argv.indexOf('--days') + 1]) : 30;
evolveAgents(days).catch(console.error);
