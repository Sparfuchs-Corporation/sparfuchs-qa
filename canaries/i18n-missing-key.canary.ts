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

export default async function i18nMissingKey(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let count = 0;

  try {
    // Heuristic: find quoted strings with 3+ words inside JSX (between > and <)
    const output = execSync(
      `grep -rn --include='*.tsx' --exclude='*.test.*' --exclude='*.spec.*' ` +
        `--exclude-dir=node_modules --exclude-dir='__tests__' ` +
        `-E '>[^<]*[A-Z][a-z]+\\s+[a-z]+\\s+[a-z]+' apps/shell/src/pages/ | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count = parseInt(output.trim(), 10) || 0;
  } catch {
    count = 0;
  }

  const threshold = 100;

  return {
    id: 'i18n-missing-key',
    projectId: 'sample-project',
    type: 'i18n',
    severity: 'info',
    hint: `Found ~${count} hardcoded user-visible strings in TSX pages (placeholder for future i18n adoption)`,
    value: count,
    threshold,
    passed: true,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
