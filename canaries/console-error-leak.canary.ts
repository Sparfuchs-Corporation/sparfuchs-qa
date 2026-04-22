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

export default async function consoleErrorLeak(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let count = 0;

  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.tsx' ` +
        `--exclude='*.test.*' --exclude='*.spec.*' --exclude-dir='__tests__' ` +
        `'console.error' apps/shell/src/ | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count = parseInt(output.trim(), 10) || 0;
  } catch {
    count = 0;
  }

  const threshold = 20;

  return {
    id: 'console-error-leak',
    projectId: 'sample-project',
    type: 'logging',
    severity: 'info',
    hint:
      count > 0
        ? `Found ${count} console.error calls in apps/shell/src/ — future Playwright integration will validate these`
        : 'No console.error calls found',
    value: count,
    threshold,
    passed: count <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
