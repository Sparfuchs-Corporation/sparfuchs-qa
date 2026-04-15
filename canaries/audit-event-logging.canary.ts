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

interface AuditGap {
  file: string;
  handlerType: 'auth' | 'admin';
  missingPath: 'success' | 'failure' | 'both' | 'action';
}

const STANDARD_EXCLUDES =
  '--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build ' +
  '--exclude-dir=.git --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=.venv ' +
  "--exclude-dir=__tests__ --exclude='*.test.*' --exclude='*.spec.*' " +
  "--exclude='test_*' --exclude='*_test.py' --exclude='*_test.go'";

// Auth handler patterns across languages
const AUTH_HANDLER_PATTERN =
  '(def |function |const |async |func )?(login|authenticate|authorize|verify.?[Tt]oken|sign[Ii]n|sign[Uu]p|reset[Pp]assword|logout|sign[Oo]ut)';

// Admin/mutation handler patterns
const ADMIN_HANDLER_PATTERN =
  '(def |function |const |async |func )?(create[A-Z]|update[A-Z]|delete[A-Z]|remove[A-Z]|admin[A-Z]|settings|configure)';

// Logger patterns that indicate structured logging
const LOGGER_PATTERNS = [
  'logger\\.',
  'log\\.',
  'audit\\.',
  'logging\\.',
  'console\\.log',
  'console\\.error',
  'console\\.warn',
  'console\\.info',
  'functions\\.logger',
  'slog\\.',
  'zap\\.',
  'logrus\\.',
];

const SUCCESS_LOG_PATTERN = LOGGER_PATTERNS.map((p) => `${p}(info|audit|debug)`).join('|');
const FAILURE_LOG_PATTERN = LOGGER_PATTERNS.map((p) => `${p}(error|warn|warning|critical|fatal)`).join('|');
const ANY_LOG_PATTERN = LOGGER_PATTERNS.join('|');

function findHandlerFiles(root: string, pattern: string, extensions: string): string[] {
  try {
    const output = execSync(
      `grep -rl ${extensions} ${STANDARD_EXCLUDES} -E '${pattern}' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    return output.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

function fileHasPattern(root: string, file: string, pattern: string): boolean {
  try {
    const output = execSync(
      `grep -c -E '${pattern}' '${file}' 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    return parseInt(output.trim(), 10) > 0;
  } catch {
    return false;
  }
}

function fileLineCount(root: string, file: string): number {
  try {
    const output = execSync(`wc -l < '${file}' 2>/dev/null || echo 0`, {
      cwd: root,
      encoding: 'utf-8',
    });
    return parseInt(output.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export default async function auditEventLogging(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const gaps: AuditGap[] = [];

  const allExtensions =
    "--include='*.py' --include='*.ts' --include='*.tsx' --include='*.js' " +
    "--include='*.jsx' --include='*.go'";

  // --- Check auth handlers ---
  const authFiles = findHandlerFiles(root, AUTH_HANDLER_PATTERN, allExtensions);

  for (const file of authFiles) {
    // Skip very short files (re-exports, type definitions)
    if (fileLineCount(root, file) <= 5) continue;

    const hasSuccessLog = fileHasPattern(root, file, SUCCESS_LOG_PATTERN);
    const hasFailureLog = fileHasPattern(root, file, FAILURE_LOG_PATTERN);

    if (!hasSuccessLog && !hasFailureLog) {
      gaps.push({ file, handlerType: 'auth', missingPath: 'both' });
    } else if (!hasFailureLog) {
      gaps.push({ file, handlerType: 'auth', missingPath: 'failure' });
    } else if (!hasSuccessLog) {
      gaps.push({ file, handlerType: 'auth', missingPath: 'success' });
    }
  }

  // --- Check admin/mutation handlers ---
  const adminFiles = findHandlerFiles(root, ADMIN_HANDLER_PATTERN, allExtensions);

  for (const file of adminFiles) {
    if (fileLineCount(root, file) <= 5) continue;
    // Skip files already flagged as auth handlers
    if (authFiles.includes(file)) continue;

    const hasAnyLog = fileHasPattern(root, file, ANY_LOG_PATTERN);

    if (!hasAnyLog) {
      gaps.push({ file, handlerType: 'admin', missingPath: 'action' });
    }
  }

  // --- No handlers found at all → graceful skip ---
  if (authFiles.length === 0 && adminFiles.length === 0) {
    return {
      id: 'audit-event-logging',
      projectId: 'the-forge',
      type: 'security',
      severity: 'info',
      hint: 'No auth or admin handler patterns found — audit event check skipped',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  const totalGaps = gaps.length;

  let hint: string;
  if (totalGaps === 0) {
    hint = `All ${authFiles.length} auth handler(s) and ${adminFiles.length} admin handler(s) have logging on success and failure paths`;
  } else {
    const authGaps = gaps.filter((g) => g.handlerType === 'auth');
    const adminGaps = gaps.filter((g) => g.handlerType === 'admin');
    const parts: string[] = [];
    if (authGaps.length > 0) {
      const examples = authGaps.slice(0, 3).map((g) => `${g.file} (missing ${g.missingPath})`).join(', ');
      parts.push(`${authGaps.length} auth handler(s) missing audit logs: ${examples}`);
    }
    if (adminGaps.length > 0) {
      const examples = adminGaps.slice(0, 3).map((g) => g.file).join(', ');
      parts.push(`${adminGaps.length} admin handler(s) with no action logging: ${examples}`);
    }
    hint = parts.join('; ');
  }

  // Auth handlers missing failure logs are highest severity
  const hasAuthFailureGap = gaps.some(
    (g) => g.handlerType === 'auth' && (g.missingPath === 'failure' || g.missingPath === 'both'),
  );
  const severity = totalGaps === 0
    ? 'info'
    : hasAuthFailureGap
      ? 'high'
      : 'medium';

  const threshold = 0;

  return {
    id: 'audit-event-logging',
    projectId: 'the-forge',
    type: 'security',
    severity,
    hint,
    value: totalGaps,
    threshold,
    passed: totalGaps <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
