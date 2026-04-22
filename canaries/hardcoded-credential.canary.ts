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

export default async function hardcodedCredential(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let count = 0;

  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
        `--exclude='*.test.*' --exclude='*.spec.*' --exclude='*.md' ` +
        `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git ` +
        `-E '(API_KEY\\s*=\\s*["\x27]|SECRET\\s*=\\s*["\x27]|PASSWORD\\s*=\\s*["\x27]|TOKEN\\s*=\\s*["\x27]|private_key["\x27]\\s*:)' ` +
        `apps/ libs/ | grep -v 'process\\.env' | grep -v 'import\\.meta\\.env' | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    count = parseInt(output.trim(), 10) || 0;
  } catch {
    count = 0;
  }

  const threshold = 0;

  return {
    id: 'hardcoded-credential',
    projectId: 'sample-project',
    type: 'security',
    severity: count > 0 ? 'critical' : 'info',
    hint:
      count > 0
        ? `Found ${count} potential hardcoded credential(s) in source files`
        : 'No hardcoded credentials detected',
    value: count,
    threshold,
    passed: count <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
