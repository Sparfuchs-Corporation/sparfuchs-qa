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

export default async function todoDensity(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let count = 0;

  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
        `--exclude-dir=node_modules -E '(TODO|FIXME|XXX|HACK)' apps/ libs/ | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count = parseInt(output.trim(), 10) || 0;
  } catch {
    count = 0;
  }

  const threshold = 50;
  const severity = count > threshold ? 'high' : count > 20 ? 'medium' : 'low';

  return {
    id: 'todo-density',
    projectId: 'sample-project',
    type: 'code-quality',
    severity,
    hint: `Found ${count} TODO/FIXME/XXX/HACK comments in apps/ and libs/`,
    value: count,
    threshold,
    passed: count <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
