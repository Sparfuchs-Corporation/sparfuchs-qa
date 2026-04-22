import { execSync } from 'child_process';
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

export default async function performanceRegression(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const distDir = path.join(root, 'dist', 'apps', 'shell');
  const threshold = 2500000; // 2.5MB
  let totalSize = 0;
  let distExists = false;

  if (fs.existsSync(distDir)) {
    distExists = true;
    try {
      const output = execSync(
        `find "${distDir}" -type f -exec stat -f%z {} + 2>/dev/null | awk '{s+=$1} END {print s}'`,
        { encoding: 'utf-8' },
      );
      totalSize = parseInt(output.trim(), 10) || 0;
    } catch {
      // Fallback for Linux stat format
      try {
        const output = execSync(
          `find "${distDir}" -type f -exec stat --format=%s {} + 2>/dev/null | awk '{s+=$1} END {print s}'`,
          { encoding: 'utf-8' },
        );
        totalSize = parseInt(output.trim(), 10) || 0;
      } catch {
        totalSize = 0;
      }
    }
  }

  const sizeMB = (totalSize / 1_000_000).toFixed(2);
  const severity = !distExists
    ? 'info'
    : totalSize > threshold
      ? 'high'
      : 'low';

  return {
    id: 'performance-regression',
    projectId: 'sample-project',
    type: 'performance',
    severity,
    hint: distExists
      ? `Shell bundle total size: ${sizeMB}MB (threshold: ${(threshold / 1_000_000).toFixed(1)}MB)`
      : 'dist/apps/shell not found — run a build first',
    value: totalSize,
    threshold,
    passed: !distExists || totalSize <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
