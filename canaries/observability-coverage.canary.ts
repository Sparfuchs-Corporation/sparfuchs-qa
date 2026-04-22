import { execSync } from 'child_process';

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

const STRUCTURED_LOGGERS = [
  'winston', 'pino', 'bunyan', 'log4js', 'structlog', 'zerolog', 'zap',
  'slog', '@google-cloud/logging', 'firebase-functions/logger',
];

const HANDLER_PATTERNS = [
  'exports\\.', 'onRequest', 'onCall', 'onDocument', 'onSchedule',
  'app\\.get\\(', 'app\\.post\\(', 'app\\.put\\(', 'app\\.delete\\(',
  'router\\.get\\(', 'router\\.post\\(', 'fastify\\.get\\(',
  '@app\\.route', '@router\\.',
];

export default async function observabilityCoverage(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  let handlerFiles = 0;
  let instrumentedFiles = 0;

  // Count files containing handler/endpoint patterns
  try {
    const pattern = HANDLER_PATTERNS.join('|');
    const output = execSync(
      `grep -rl --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
        `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build ` +
        `--exclude-dir=__tests__ --exclude='*.test.*' --exclude='*.spec.*' ` +
        `-E '${pattern}' . 2>/dev/null | wc -l`,
      { cwd: root, encoding: 'utf-8' },
    );
    handlerFiles = parseInt(output.trim(), 10) || 0;
  } catch {
    handlerFiles = 0;
  }

  // Count handler files that also import a structured logger
  if (handlerFiles > 0) {
    try {
      const handlerPattern = HANDLER_PATTERNS.join('|');
      const loggerPattern = STRUCTURED_LOGGERS.map(l => l.replace('/', '\\/')).join('|');

      // Get handler files, then check which ones have a logger import
      const handlerOutput = execSync(
        `grep -rl --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
          `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build ` +
          `--exclude-dir=__tests__ --exclude='*.test.*' --exclude='*.spec.*' ` +
          `-E '${handlerPattern}' . 2>/dev/null`,
        { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
      );
      const files = handlerOutput.trim().split('\n').filter(Boolean);

      for (const file of files) {
        try {
          const content = execSync(
            `grep -l -E '${loggerPattern}' "${file}" 2>/dev/null`,
            { cwd: root, encoding: 'utf-8' },
          );
          if (content.trim()) {
            instrumentedFiles++;
          }
        } catch {
          // File doesn't have a structured logger import
        }
      }
    } catch {
      instrumentedFiles = 0;
    }
  }

  const coveragePercent = handlerFiles > 0
    ? Math.round((instrumentedFiles / handlerFiles) * 100)
    : 100; // No handlers = nothing to instrument

  const threshold = 50;
  const severity = coveragePercent < 25 ? 'high'
    : coveragePercent < threshold ? 'medium'
    : 'low';

  return {
    id: 'observability-coverage',
    projectId: 'sample-project',
    type: 'code-quality',
    severity,
    hint: `${instrumentedFiles}/${handlerFiles} handler files have structured logging (${coveragePercent}% coverage)`,
    value: coveragePercent,
    threshold,
    passed: coveragePercent >= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
