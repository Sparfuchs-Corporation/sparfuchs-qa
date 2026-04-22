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

export default async function coverageHole(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const coveragePath = path.join(root, 'coverage', 'coverage-final.json');
  let zeroCoverageFiles = 0;
  let totalFiles = 0;
  let coverageExists = false;

  if (fs.existsSync(coveragePath)) {
    coverageExists = true;
    try {
      const raw = fs.readFileSync(coveragePath, 'utf-8');
      const data = JSON.parse(raw);

      for (const filePath of Object.keys(data)) {
        totalFiles++;
        const stmts = data[filePath]?.s || {};
        const stmtValues = Object.values(stmts) as number[];
        if (stmtValues.length > 0 && stmtValues.every(v => v === 0)) {
          zeroCoverageFiles++;
        }
      }
    } catch {
      zeroCoverageFiles = 0;
    }
  }

  const threshold = 10;
  const severity = !coverageExists
    ? 'info'
    : zeroCoverageFiles > threshold
      ? 'high'
      : zeroCoverageFiles > 5
        ? 'medium'
        : 'low';

  return {
    id: 'coverage-hole',
    projectId: 'sample-project',
    type: 'test-coverage',
    severity,
    hint: coverageExists
      ? `${zeroCoverageFiles}/${totalFiles} files have 0% statement coverage`
      : 'No coverage report found at coverage/coverage-final.json',
    value: zeroCoverageFiles,
    threshold,
    passed: zeroCoverageFiles <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
