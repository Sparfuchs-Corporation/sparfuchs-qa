import { execSync } from 'child_process';
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

export default async function silentErrorSwallow(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let count = 0;

  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=node_modules ` +
        `-E 'catch\\s*\\([^)]*\\)\\s*\\{\\s*\\}' apps/ libs/ | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count = parseInt(output.trim(), 10) || 0;
  } catch {
    count = 0;
  }

  // Also check for catch blocks with only whitespace
  try {
    const output2 = execSync(
      `grep -rn --include='*.ts' --include='*.tsx' --exclude-dir=node_modules ` +
        `-E 'catch\\s*\\{\\s*\\}' apps/ libs/ | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count += parseInt(output2.trim(), 10) || 0;
  } catch {
    // no-op
  }

  const threshold = 5;
  const severity = count > threshold ? 'high' : count > 0 ? 'medium' : 'low';

  return {
    id: 'silent-error-swallow',
    projectId: 'the-forge',
    type: 'error-handling',
    severity,
    hint: `Found ${count} empty catch blocks in apps/ and libs/`,
    value: count,
    threshold,
    passed: count <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
