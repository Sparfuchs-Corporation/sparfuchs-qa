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

const STANDARD_EXCLUDES =
  '--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build ' +
  '--exclude-dir=.git --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=.venv';

// ---------------------------------------------------------------------------
// Check 1: Log level configuration
// ---------------------------------------------------------------------------

function checkLogLevelConfig(root: string): { found: boolean; details: string } {
  // Check env files for LOG_LEVEL / log_level
  try {
    const envOutput = execSync(
      `grep -rl --include='.env*' --include='*.env' ${STANDARD_EXCLUDES} ` +
        `-E '(LOG_LEVEL|log_level|logLevel)' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    if (envOutput.trim()) {
      return { found: true, details: 'LOG_LEVEL in env files' };
    }
  } catch { /* no env files */ }

  // Check code for logger initialization with level
  const loggerLevelPatterns = [
    'createLogger.*level',
    'pino\\(.*level',
    'winston\\.createLogger.*level',
    'logging\\.basicConfig.*level',
    'log_level',
    'LOG_LEVEL',
    'logLevel.*process\\.env',
    'zerolog.*Level',
    'zap\\.New.*Level',
  ];
  const pattern = loggerLevelPatterns.join('|');

  try {
    const output = execSync(
      `grep -rl --include='*.ts' --include='*.js' --include='*.py' --include='*.go' ` +
        `${STANDARD_EXCLUDES} -E '${pattern}' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    if (output.trim()) {
      return { found: true, details: 'Logger level config in code' };
    }
  } catch { /* grep fails */ }

  // Check config files
  try {
    const output = execSync(
      `grep -rl --include='*.yaml' --include='*.yml' --include='*.json' --include='*.toml' ` +
        `${STANDARD_EXCLUDES} -E '(log.?level|LOG_LEVEL)' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    if (output.trim()) {
      return { found: true, details: 'Log level in config files' };
    }
  } catch { /* grep fails */ }

  return { found: false, details: 'No log level configuration found' };
}

// ---------------------------------------------------------------------------
// Check 2: SIEM/syslog transport
// ---------------------------------------------------------------------------

function checkSiemTransport(root: string): { found: boolean; details: string } {
  // Check for syslog transports in dependencies or code
  const transportPatterns = [
    'winston-syslog',
    'pino-syslog',
    'rsyslog',
    'syslog-drain',
    'fluentd',
    'fluent-bit',
    'logstash',
    'filebeat',
    'vector',
    '@google-cloud/logging-winston',
    '@google-cloud/logging-bunyan',
    '@google-cloud/logging',
    'aws-cloudwatch-log',
    'datadog-winston',
    'pino-datadog',
    'splunk-logging',
    'elastic-apm',
  ];

  const pattern = transportPatterns.map((p) => p.replace(/[/@-]/g, '\\$&')).join('|');

  try {
    const output = execSync(
      `grep -rl --include='*.ts' --include='*.js' --include='*.json' --include='*.py' ` +
        `--include='*.go' --include='*.yaml' --include='*.yml' ` +
        `${STANDARD_EXCLUDES} -E '${pattern}' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    if (output.trim()) {
      const files = output.trim().split('\n');
      return { found: true, details: `SIEM/syslog transport in ${files.length} file(s)` };
    }
  } catch { /* grep fails */ }

  // Check for log forwarding config files
  const forwarderConfigs = [
    'fluent.conf',
    'fluentd.conf',
    'fluent-bit.conf',
    'filebeat.yml',
    'filebeat.yaml',
    'vector.toml',
    'vector.yaml',
    'logstash.conf',
    'rsyslog.conf',
    'td-agent.conf',
  ];

  for (const config of forwarderConfigs) {
    if (fs.existsSync(path.join(root, config))) {
      return { found: true, details: `Log forwarder config: ${config}` };
    }
  }

  return { found: false, details: 'No SIEM/syslog transport or log forwarder found' };
}

// ---------------------------------------------------------------------------
// Check 3: Audit log separation
// ---------------------------------------------------------------------------

function checkAuditLogSeparation(root: string): { found: boolean; details: string } {
  // Check for separate audit/security logger instances
  const auditLoggerPatterns = [
    'createLogger.*audit',
    'getLogger.*audit',
    'getLogger.*security',
    'pino.*audit',
    'winston.*audit',
    "logging\\.getLogger\\(['\"]audit",
    "logging\\.getLogger\\(['\"]security",
    'audit.?[Ll]ogger',
    'security.?[Ll]ogger',
  ];

  const pattern = auditLoggerPatterns.join('|');

  try {
    const output = execSync(
      `grep -rl --include='*.ts' --include='*.js' --include='*.py' --include='*.go' ` +
        `${STANDARD_EXCLUDES} -E '${pattern}' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    if (output.trim()) {
      return { found: true, details: 'Separate audit logger instance found' };
    }
  } catch { /* grep fails */ }

  // Check for separate audit log file configuration
  const auditFilePatterns = [
    'audit\\.log',
    'security\\.log',
    'audit-trail',
    'audit_log',
  ];

  const filePattern = auditFilePatterns.join('|');

  try {
    const output = execSync(
      `grep -rl --include='*.ts' --include='*.js' --include='*.py' --include='*.go' ` +
        `--include='*.yaml' --include='*.yml' --include='*.json' ` +
        `${STANDARD_EXCLUDES} -E '${filePattern}' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    if (output.trim()) {
      return { found: true, details: 'Audit log file/stream configuration found' };
    }
  } catch { /* grep fails */ }

  return { found: false, details: 'No separate audit log stream found' };
}

// ---------------------------------------------------------------------------
// Canary entry point
// ---------------------------------------------------------------------------

export default async function logTierConfig(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();

  // Quick check: does the repo have any application code at all?
  let hasAppCode = false;
  try {
    const output = execSync(
      `find . -maxdepth 3 \\( -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.go' \\) ` +
        `-not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -1`,
      { cwd: root, encoding: 'utf-8' },
    );
    hasAppCode = output.trim().length > 0;
  } catch { /* find fails */ }

  if (!hasAppCode) {
    return {
      id: 'log-tier-config',
      projectId: 'the-forge',
      type: 'configuration',
      severity: 'info',
      hint: 'No application code found — log tier check skipped',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  const logLevel = checkLogLevelConfig(root);
  const siemTransport = checkSiemTransport(root);
  const auditSeparation = checkAuditLogSeparation(root);

  let missingCount = 0;
  const missing: string[] = [];
  const present: string[] = [];

  if (!logLevel.found) {
    missingCount++;
    missing.push('log level config');
  } else {
    present.push(logLevel.details);
  }

  if (!siemTransport.found) {
    missingCount++;
    missing.push('SIEM/syslog transport');
  } else {
    present.push(siemTransport.details);
  }

  if (!auditSeparation.found) {
    // Audit separation is informational, not a hard requirement
    missing.push('audit log separation (info)');
  } else {
    present.push(auditSeparation.details);
  }

  let hint: string;
  if (missingCount === 0) {
    hint = `Log tier infrastructure present: ${present.join('; ')}`;
    if (!auditSeparation.found) {
      hint += ' (note: no separate audit log stream)';
    }
  } else {
    hint = `Missing: ${missing.join(', ')}`;
    if (present.length > 0) {
      hint += `. Present: ${present.join('; ')}`;
    }
  }

  const threshold = 0;
  const severity = missingCount >= 2 ? 'high' : missingCount === 1 ? 'medium' : 'info';

  return {
    id: 'log-tier-config',
    projectId: 'the-forge',
    type: 'configuration',
    severity,
    hint,
    value: missingCount,
    threshold,
    passed: missingCount <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
