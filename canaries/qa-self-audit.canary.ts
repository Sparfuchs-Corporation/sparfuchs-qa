import * as fs from 'fs';
import * as path from 'path';

interface CanaryResult {
  id: string;
  projectId: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  hint: string;
  value: number;
  threshold: number;
  passed: boolean;
  trend: 'improving' | 'stable' | 'degrading';
  lastSeen: string;
  history: { date: string; value: number }[];
}

export default async function qaSelfAudit(): Promise<CanaryResult> {
  const canaryDir = path.resolve(__dirname);
  let canaryCount = 0;
  let issues: string[] = [];

  try {
    const files = fs.readdirSync(canaryDir);
    const canaryFiles = files.filter(f => f.endsWith('.canary.ts'));
    canaryCount = canaryFiles.length;

    // Check index.ts exists
    if (!files.includes('index.ts')) {
      issues.push('index.ts orchestrator missing');
    }

    // Check README exists
    if (!files.includes('README.md')) {
      issues.push('README.md missing');
    }

    // Verify each canary file has a default export (basic check)
    for (const file of canaryFiles) {
      const content = fs.readFileSync(path.join(canaryDir, file), 'utf-8');
      if (!content.includes('export default')) {
        issues.push(`${file} missing default export`);
      }
    }
  } catch {
    issues.push('Failed to read canary directory');
  }

  const passed = issues.length === 0;

  return {
    id: 'qa-self-audit',
    projectId: 'sample-project',
    type: 'meta',
    severity: 'info',
    hint: passed
      ? `QA canary suite healthy: ${canaryCount} canaries, structure valid`
      : `QA canary issues: ${issues.join('; ')}`,
    value: issues.length,
    threshold: 0,
    passed,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
