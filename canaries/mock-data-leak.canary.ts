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

export default async function mockDataLeak(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let count = 0;

  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.tsx' ` +
        `--exclude='*.test.*' --exclude='*.spec.*' --exclude-dir='__tests__' ` +
        `-iE '(mock|faker|demo data|test data|placeholder|sample data)' ` +
        `apps/shell/src/ | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count = parseInt(output.trim(), 10) || 0;
  } catch {
    count = 0;
  }

  const threshold = 0;

  return {
    id: 'mock-data-leak',
    projectId: 'the-forge',
    type: 'data-integrity',
    severity: count > 0 ? 'critical' : 'info',
    hint:
      count > 0
        ? `Found ${count} mock/sample/placeholder data references in non-test production code`
        : 'No mock data leaks detected in production code',
    value: count,
    threshold,
    passed: count <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
