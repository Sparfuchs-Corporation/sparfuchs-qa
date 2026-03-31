/**
 * QA Report Adapter
 *
 * Converts static_analysis.py output into the QA Platform's AgentReport format
 * and POSTs it to the ingestAgentReport Cloud Function.
 *
 * Usage:
 *   npx tsx scripts/qa-report-adapter.ts [report-json-path] [platform-url] [agent-key]
 *   npx tsx scripts/qa-report-adapter.ts --dry-run
 *
 * Environment variables (used as fallbacks):
 *   QA_PLATFORM_URL  — ingestAgentReport endpoint URL
 *   AGENT_REPORT_KEY — X-Agent-Key header value
 *   TARGET_ENV       — target environment (default: 'dev')
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

/** Issue shape from static_analysis.py JSON output */
interface StaticAnalysisIssue {
  id: string;
  category: string;
  severity: string;
  file: string;
  line: number;
  title: string;
  description: string;
  code_snippet: string;
  auto_fixable: boolean;
  fix_type: string;
}

interface StaticAnalysisReport {
  timestamp: string;
  scan_dirs: string[];
  total_files_scanned: number;
  issues: StaticAnalysisIssue[];
  summary: {
    total_issues: number;
    by_severity: Record<string, number>;
    by_category: Record<string, number>;
    auto_fixable: number;
    by_fix_type: Record<string, number>;
  };
}

/** Finding shape expected by ingestAgentReport */
interface AgentReportFinding {
  severity: string;
  category: string;
  message: string;
  file?: string;
  line?: number;
  rule?: string;
  evidence?: string;
  autoFixable?: boolean;
}

interface AgentReportSummary {
  pass: boolean;
  findings: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
  headline: string;
}

interface AgentReport {
  agentSystem: string;
  reportType: string;
  targetProject: string;
  targetEnvironment: string;
  runId: string;
  status: string;
  summary: AgentReportSummary;
  writtenBy: string;
  branch?: string;
  findings?: AgentReportFinding[];
}

// ── Mapping ──────────────────────────────────────────────────────────────

function mapIssueToFinding(issue: StaticAnalysisIssue): AgentReportFinding {
  return {
    severity: issue.severity,
    category: issue.category,
    message: issue.title,
    file: issue.file,
    line: issue.line,
    rule: issue.id,
    evidence: issue.code_snippet || undefined,
    autoFixable: issue.auto_fixable,
  };
}

function computeStatus(bySeverity: Record<string, number>): string {
  if ((bySeverity['critical'] ?? 0) > 0) return 'fail';
  if ((bySeverity['high'] ?? 0) > 0) return 'warn';
  return 'pass';
}

function buildHeadline(bySeverity: Record<string, number>): string {
  const parts: string[] = [];
  for (const level of ['critical', 'high', 'medium', 'low', 'info']) {
    const count = bySeverity[level] ?? 0;
    if (count > 0) {
      parts.push(`${count} ${level}`);
    }
  }
  if (parts.length === 0) return 'Static analysis: clean';
  return `Static analysis: ${parts.join(', ')}`;
}

function buildAgentReport(
  source: StaticAnalysisReport,
  targetEnv: string,
  branch?: string,
): AgentReport {
  const bySeverity = source.summary.by_severity;
  const status = computeStatus(bySeverity);
  const headline = buildHeadline(bySeverity);

  const findings = source.issues.map(mapIssueToFinding);

  return {
    agentSystem: 'sparfuchs-qa',
    reportType: 'static-analysis',
    targetProject: 'the-forge',
    targetEnvironment: targetEnv,
    runId: randomUUID(),
    status,
    writtenBy: 'qa-report-adapter',
    branch,
    summary: {
      pass: status === 'pass',
      findings: {
        critical: bySeverity['critical'] ?? 0,
        high: bySeverity['high'] ?? 0,
        medium: bySeverity['medium'] ?? 0,
        low: bySeverity['low'] ?? 0,
        info: bySeverity['info'] ?? 0,
      },
      headline,
    },
    findings,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter(a => !a.startsWith('--'));

  const reportPath = positional[0]
    ?? '.claude/skills/forge-qa/reports/analysis-results.json';
  const platformUrl = positional[1] ?? process.env.QA_PLATFORM_URL ?? '';
  const agentKey = positional[2] ?? process.env.AGENT_REPORT_KEY ?? '';
  const targetEnv = process.env.TARGET_ENV ?? 'dev';

  // Read the current branch for metadata
  let branch: string | undefined;
  try {
    const { execSync } = await import('node:child_process');
    branch = execSync('git branch --show-current', { encoding: 'utf-8' }).trim();
  } catch {
    // not in a git repo — skip
  }

  // Read source report
  const resolvedPath = resolve(reportPath);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read report at ${resolvedPath}: ${msg}`);
    process.exit(1);
  }

  let source: StaticAnalysisReport;
  try {
    source = JSON.parse(raw);
  } catch {
    console.error(`Failed to parse JSON from ${resolvedPath}`);
    process.exit(1);
  }

  if (!source.issues || !source.summary) {
    console.error('Report JSON missing required fields (issues, summary)');
    process.exit(1);
  }

  const report = buildAgentReport(source, targetEnv, branch);

  console.log(`Converted ${source.issues.length} issues into AgentReport`);
  console.log(`  Status:  ${report.status}`);
  console.log(`  Headline: ${report.summary.headline}`);
  console.log(`  RunId:   ${report.runId}`);

  if (dryRun) {
    console.log('\n--- DRY RUN: AgentReport payload ---');
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (!platformUrl) {
    console.error(
      'No platform URL provided. Pass as second argument or set QA_PLATFORM_URL env var.',
    );
    process.exit(1);
  }
  if (!agentKey) {
    console.error(
      'No agent key provided. Pass as third argument or set AGENT_REPORT_KEY env var.',
    );
    process.exit(1);
  }

  // POST to ingestAgentReport
  console.log(`\nPOSTing to ${platformUrl} ...`);
  try {
    const response = await fetch(platformUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': agentKey,
      },
      body: JSON.stringify(report),
    });

    const text = await response.text();
    if (!response.ok) {
      console.error(`POST failed: ${response.status} ${response.statusText}`);
      console.error(text);
      process.exit(1);
    }

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(text);
    } catch {
      result = { raw: text };
    }

    console.log('POST succeeded:', JSON.stringify(result, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`POST failed: ${msg}`);
    process.exit(1);
  }
}

main();
