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

export default async function staleClosure(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let count = 0;

  try {
    const output = execSync(
      `grep -rn --include='*.tsx' ` +
        `'eslint-disable-next-line react-hooks/exhaustive-deps' ` +
        `apps/shell/src/ | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count = parseInt(output.trim(), 10) || 0;
  } catch {
    count = 0;
  }

  const threshold = 0;

  return {
    id: 'stale-closure',
    projectId: 'the-forge',
    type: 'react-hooks',
    severity: count > 0 ? 'medium' : 'info',
    hint:
      count > 0
        ? `Found ${count} eslint-disable for exhaustive-deps — each is a potential stale closure bug`
        : 'No stale closure suppressions found',
    value: count,
    threshold,
    passed: count <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
