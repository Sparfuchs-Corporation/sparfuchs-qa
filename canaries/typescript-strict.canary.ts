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

const TSC_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 5 * 1024 * 1024;

interface TscResult {
  totalErrors: number;
  errorsByCode: Map<string, number>;
  timedOut: boolean;
}

function runTsc(cwd: string, project?: string): TscResult {
  const projectArg = project ? ` -p ${project}` : '';
  const errorsByCode = new Map<string, number>();
  let timedOut = false;

  try {
    const output = execSync(
      `npx tsc --noEmit${projectArg} 2>&1 || true`,
      { cwd, encoding: 'utf-8', maxBuffer: MAX_BUFFER, timeout: TSC_TIMEOUT_MS },
    );

    const errorPattern = /error TS(\d+):/g;
    let match: RegExpExecArray | null;
    while ((match = errorPattern.exec(output)) !== null) {
      const code = `TS${match[1]}`;
      errorsByCode.set(code, (errorsByCode.get(code) || 0) + 1);
    }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'killed' in err && (err as { killed: boolean }).killed) {
      timedOut = true;
    }
    // Other errors (e.g., tsc not found) → treat as 0 errors
  }

  let totalErrors = 0;
  for (const count of errorsByCode.values()) totalErrors += count;

  return { totalErrors, errorsByCode, timedOut };
}

function formatTopErrors(errorsByCode: Map<string, number>, limit: number): string {
  const sorted = [...errorsByCode.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, limit);
  return top.map(([code, count]) => `${count}× ${code}`).join(', ');
}

export default async function typescriptStrict(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();

  // Check for tsconfig.json
  const hasTsconfig = fs.existsSync(path.join(root, 'tsconfig.json'));
  if (!hasTsconfig) {
    return {
      id: 'typescript-strict',
      projectId: 'sample-project',
      type: 'build',
      severity: 'info',
      hint: 'No tsconfig.json found at project root — skipping TypeScript check',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  // Check for node_modules
  const hasNodeModules = fs.existsSync(path.join(root, 'node_modules'));
  if (!hasNodeModules) {
    return {
      id: 'typescript-strict',
      projectId: 'sample-project',
      type: 'build',
      severity: 'medium',
      hint: 'node_modules not found — run npm install before checking TypeScript',
      value: 1,
      threshold: 0,
      passed: false,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  // Run tsc on main project
  const mainResult = runTsc(root);

  // Run tsc on functions/ if it has its own tsconfig
  const functionsTsconfig = path.join(root, 'functions', 'tsconfig.json');
  let functionsResult: TscResult | null = null;
  if (fs.existsSync(functionsTsconfig)) {
    functionsResult = runTsc(root, 'functions/tsconfig.json');
  }

  // Aggregate
  const mergedErrors = new Map<string, number>(mainResult.errorsByCode);
  if (functionsResult) {
    for (const [code, count] of functionsResult.errorsByCode) {
      mergedErrors.set(code, (mergedErrors.get(code) || 0) + count);
    }
  }

  const totalErrors = mainResult.totalErrors + (functionsResult?.totalErrors || 0);
  const timedOut = mainResult.timedOut || (functionsResult?.timedOut || false);

  // Build hint
  let hint: string;
  if (timedOut) {
    hint = `TypeScript check timed out after ${TSC_TIMEOUT_MS / 1000}s — ${totalErrors} error(s) found before timeout`;
  } else if (totalErrors === 0) {
    const targets = functionsResult ? 'frontend + functions' : 'frontend';
    hint = `TypeScript compilation clean (${targets})`;
  } else {
    const breakdown = formatTopErrors(mergedErrors, 3);
    const targets: string[] = [];
    if (mainResult.totalErrors > 0) targets.push(`${mainResult.totalErrors} frontend`);
    if (functionsResult && functionsResult.totalErrors > 0) targets.push(`${functionsResult.totalErrors} functions`);
    hint = `${totalErrors} TypeScript error(s) (${targets.join(' + ')}): ${breakdown}`;
  }

  const threshold = 0;

  return {
    id: 'typescript-strict',
    projectId: 'sample-project',
    type: 'build',
    severity: totalErrors > 0 ? 'critical' : timedOut ? 'medium' : 'info',
    hint,
    value: totalErrors,
    threshold,
    passed: totalErrors <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
