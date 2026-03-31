/**
 * Nightly Regression Runner
 *
 * Designed to be called by Cloud Scheduler or manually.
 * Runs canaries and optionally vitest, then POSTs an AgentReport
 * to the QA Platform.
 *
 * Usage:
 *   npx tsx scripts/trigger-nightly-regression.ts
 *
 * Environment variables:
 *   QA_PLATFORM_URL  — ingestAgentReport endpoint URL (required)
 *   AGENT_REPORT_KEY — X-Agent-Key header value (required)
 *   TARGET_ENV       — target environment (default: 'dev')
 *   SKIP_VITEST      — set to '1' to skip vitest run
 */

import { randomUUID } from 'node:crypto';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { resolve } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

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

interface VitestResult {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  success: boolean;
}

interface AgentReportFinding {
  severity: string;
  category: string;
  message: string;
  file?: string;
  line?: number;
  rule?: string;
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
  triggerType: string;
  branch?: string;
  durationSeconds?: number;
  findings?: AgentReportFinding[];
  canaryResults?: CanaryResult[];
  vitestSummary?: VitestResult;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '..');
const EXEC_OPTS: ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  cwd: ROOT,
  timeout: 300_000, // 5 minutes
};

function getCurrentBranch(): string | undefined {
  try {
    return execSync('git branch --show-current', { ...EXEC_OPTS, timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

function runCanaries(): { results: CanaryResult[]; error?: string } {
  console.log('Running canaries...');
  try {
    const output = execSync('npx tsx tests/platform/canaries/index.ts', {
      ...EXEC_OPTS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const results: CanaryResult[] = JSON.parse(output);
    console.log(`  Canaries complete: ${results.length} results`);
    return { results };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Canary run failed: ${msg}`);
    return {
      results: [],
      error: msg,
    };
  }
}

function runVitest(): { result: VitestResult | null; error?: string } {
  if (process.env.SKIP_VITEST === '1') {
    console.log('Skipping vitest (SKIP_VITEST=1)');
    return { result: null };
  }

  console.log('Running vitest...');
  try {
    const output = execSync('npx vitest run --reporter=json 2>/dev/null', {
      ...EXEC_OPTS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // vitest --reporter=json outputs a JSON object; parse the last JSON block
    const jsonMatch = output.match(/\{[\s\S]*"numTotalTests"[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('  Vitest ran but no JSON summary found in output');
      return { result: null };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const result: VitestResult = {
      numTotalTests: parsed.numTotalTests ?? 0,
      numPassedTests: parsed.numPassedTests ?? 0,
      numFailedTests: parsed.numFailedTests ?? 0,
      numPendingTests: parsed.numPendingTests ?? 0,
      success: parsed.success ?? false,
    };
    console.log(
      `  Vitest complete: ${result.numPassedTests}/${result.numTotalTests} passed`,
    );
    return { result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Vitest failed: ${msg}`);
    return { result: null, error: msg };
  }
}

// ── Report Building ──────────────────────────────────────────────────────

function buildReport(
  canaryResults: CanaryResult[],
  canaryError: string | undefined,
  vitestResult: VitestResult | null,
  vitestError: string | undefined,
  targetEnv: string,
  branch?: string,
  durationSeconds?: number,
): AgentReport {
  const findings: AgentReportFinding[] = [];

  // Convert failed canaries to findings
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const canary of canaryResults) {
    if (!canary.passed) {
      const sev = canary.severity || 'medium';
      findings.push({
        severity: sev,
        category: `canary:${canary.type}`,
        message: canary.hint || `Canary ${canary.id} failed`,
        rule: canary.id,
      });
      if (sev in severityCounts) {
        severityCounts[sev as keyof typeof severityCounts]++;
      }
    }
  }

  // Add canary error as a critical finding if the runner itself crashed
  if (canaryError) {
    findings.push({
      severity: 'critical',
      category: 'canary:orchestration',
      message: `Canary runner crashed: ${canaryError.slice(0, 200)}`,
    });
    severityCounts.critical++;
  }

  // Add vitest failures
  if (vitestResult && vitestResult.numFailedTests > 0) {
    findings.push({
      severity: 'high',
      category: 'vitest',
      message: `${vitestResult.numFailedTests} of ${vitestResult.numTotalTests} tests failed`,
    });
    severityCounts.high += 1;
  }
  if (vitestError) {
    findings.push({
      severity: 'high',
      category: 'vitest:orchestration',
      message: `Vitest runner failed: ${vitestError.slice(0, 200)}`,
    });
    severityCounts.high++;
  }

  // Determine status
  let status: string;
  if (severityCounts.critical > 0) {
    status = 'fail';
  } else if (severityCounts.high > 0) {
    status = 'warn';
  } else {
    status = 'pass';
  }

  // Build headline
  const totalCanaries = canaryResults.length;
  const passedCanaries = canaryResults.filter(c => c.passed).length;
  const headlineParts: string[] = [
    `Canaries: ${passedCanaries}/${totalCanaries} passed`,
  ];
  if (vitestResult) {
    headlineParts.push(
      `Tests: ${vitestResult.numPassedTests}/${vitestResult.numTotalTests} passed`,
    );
  }
  const headline = `Nightly regression: ${headlineParts.join(', ')}`;

  return {
    agentSystem: 'nightly-regression',
    reportType: 'nightly-regression',
    targetProject: 'the-forge',
    targetEnvironment: targetEnv,
    runId: randomUUID(),
    status,
    writtenBy: 'trigger-nightly-regression',
    triggerType: 'scheduled',
    branch,
    durationSeconds,
    summary: {
      pass: status === 'pass',
      findings: severityCounts,
      headline,
    },
    findings,
    canaryResults,
    vitestSummary: vitestResult ?? undefined,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const platformUrl = process.env.QA_PLATFORM_URL;
  const agentKey = process.env.AGENT_REPORT_KEY;
  const targetEnv = process.env.TARGET_ENV ?? 'dev';

  if (!platformUrl) {
    console.error('QA_PLATFORM_URL environment variable is required');
    process.exit(1);
  }
  if (!agentKey) {
    console.error('AGENT_REPORT_KEY environment variable is required');
    process.exit(1);
  }

  const branch = getCurrentBranch();
  const startTime = Date.now();

  console.log('=== Nightly Regression Run ===');
  console.log(`  Environment: ${targetEnv}`);
  console.log(`  Branch:      ${branch ?? '(detached)'}`);
  console.log(`  RunId:       (generated after completion)`);
  console.log('');

  // Step 1: Run canaries
  const { results: canaryResults, error: canaryError } = runCanaries();

  // Step 2: Run vitest
  const { result: vitestResult, error: vitestError } = runVitest();

  const durationSeconds = Math.round((Date.now() - startTime) / 1000);

  // Step 3: Build report
  const report = buildReport(
    canaryResults,
    canaryError,
    vitestResult,
    vitestError,
    targetEnv,
    branch,
    durationSeconds,
  );

  console.log('');
  console.log(`Report built in ${durationSeconds}s`);
  console.log(`  Status:   ${report.status}`);
  console.log(`  Headline: ${report.summary.headline}`);
  console.log(`  RunId:    ${report.runId}`);
  console.log(`  Findings: ${report.findings?.length ?? 0}`);

  // Step 4: POST to QA Platform
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

  // Exit code based on status
  if (report.status === 'fail') {
    console.error('\nExiting with code 1 — critical failures detected');
    process.exit(1);
  }

  console.log('\nNightly regression complete.');
}

main();
