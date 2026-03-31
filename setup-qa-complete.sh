#!/bin/bash
set -e

echo "=== Sparfuchs-Pro/sparfuchs-qa FULL MASTER SETUP ==="

cd ~/Development-Local/sparfuchs-qa

git pull origin main || true

# Create folders
mkdir -p lib scripts docs canaries .claude/skills/{run-canaries,qa-evolve,persona-test}

# === Core QA Plan files ===
cat > lib/firestore.ts << 'EOF'
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.QA_PROJECT_ID || 'theforge-dev-1771601127';
const app = initializeApp({ projectId }, 'qa-platform');
export const db = getFirestore(app);
export { FieldValue };

export const COLLECTIONS = {
  CANARY_RUNS: 'qa_canary_runs',
  FINDINGS: 'qa_findings',
  AGENT_SESSIONS: 'qa_agent_sessions',
} as const;
EOF

cat > lib/types.ts << 'EOF'
export interface CanaryResult {
  id: string;
  name: string;
  category: 'code-quality' | 'security' | 'performance' | 'i18n' | 'visual' | 'rbac';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  count: number;
  hint: string;
  details?: string;
  timestamp: string;
}

export interface QaCanaryRun {
  runId: string;
  projectId: string;
  branch?: string;
  commitSha?: string;
  environment: 'local' | 'cloud-build' | 'nightly';
  timestamp: any;
  results: CanaryResult[];
  summary: { total: number; passed: number; failed: number; bySeverity: { LOW: number; MEDIUM: number; HIGH: number } };
  source: 'local' | 'cloud-build' | 'nightly';
  forecastNotes?: string;
}
EOF

cat > canaries/index.ts << 'EOF'
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
}

runAllCanaries().catch(console.error);
EOF

cat > scripts/qa-evolve.ts << 'EOF'
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
EOF

cat > Makefile << 'EOF'
qa-quick:
	npx tsx canaries/index.ts
qa-push:
	QA_PUSH_FIRESTORE=1 npx tsx canaries/index.ts
qa-evolve:
	npx tsx scripts/qa-evolve.ts
qa-evolve-dry:
	QA_EVOLVE_DRY=1 npx tsx scripts/qa-evolve.ts
qa-setup:
	npm ci
EOF

# === Add the three QA skills ===
cat > .claude/skills/run-canaries/SKILL.md << 'EOF'
# /run-canaries
Run all QA canaries. Use --push to save history to Firestore.
EOF

cat > .claude/skills/qa-evolve/SKILL.md << 'EOF'
# /qa-evolve
Make agents learn from canary history. Use --dry-run to preview.
EOF

cat > .claude/skills/persona-test/SKILL.md << 'EOF'
# /persona-test
Run multi-user E2E tests using safe staging personas (auto-disables after run).
EOF

# === Integrate dotclaude ===
git clone https://github.com/poshan0126/dotclaude.git /tmp/dotclaude
cp /tmp/dotclaude/settings.json .claude/
cp -r /tmp/dotclaude/{rules,skills,agents,hooks} .claude/
cp /tmp/dotclaude/.gitignore .claude/
cp /tmp/dotclaude/CLAUDE.md ./
cp /tmp/dotclaude/CLAUDE.local.md.example ./
chmod +x .claude/hooks/*.sh
rm -rf /tmp/dotclaude
echo "CLAUDE.local.md" >> .gitignore

# === Commit and push ===
git add .
git commit -m "feat(qa): complete updated QA plan + dotclaude + three QA skills"
git push origin main

echo "✅ FULL QA SYSTEM DEPLOYED!"
echo ""
echo "Team members can now do:"
echo "   cd ~/Development-Local/sparfuchs-qa && git pull origin main"
echo "   Open Claude in that folder and type: /setupdotclaude"
