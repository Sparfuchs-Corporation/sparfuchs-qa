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

interface NamingMismatch {
  snakeKey: string;
  camelKey: string;
  pythonFiles: string[];
  jsFiles: string[];
}

// ORM timestamp keys that legitimately appear in both conventions
const ALLOWLIST = new Set(['created_at', 'updated_at', 'deleted_at']);

const MAX_KEYS = 50;

const STANDARD_EXCLUDES =
  '--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build ' +
  '--exclude-dir=.git --exclude-dir=venv --exclude-dir=__pycache__ --exclude-dir=.venv ' +
  "--exclude='*.test.*' --exclude='*.spec.*' --exclude='test_*' --exclude='*_test.py'";

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

function isSnakeCase(s: string): boolean {
  return /^[a-z]+(_[a-z0-9]+)+$/.test(s);
}

function isCamelCase(s: string): boolean {
  return /^[a-z]+[A-Z][a-zA-Z0-9]*$/.test(s);
}

function extractSnakeKeysFromPython(root: string): Map<string, string[]> {
  const keyFiles = new Map<string, string[]>();

  // Pattern 1: .get("snake_case_key", fallback) — broad grep, precise JS filter
  try {
    const output = execSync(
      `grep -rn --include='*.py' ${STANDARD_EXCLUDES} ` +
        `-E '[.]get[(]' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    for (const line of output.split('\n').filter(Boolean)) {
      const match = line.match(/\.get\(\s*['"]([a-z]+(?:_[a-z0-9]+)+)['"]\s*,/);
      if (match) {
        const key = match[1];
        const fileMatch = line.match(/^\.\/([^:]+):/);
        const file = fileMatch?.[1] || '';
        if (!ALLOWLIST.has(key) && file) {
          const files = keyFiles.get(key) || [];
          if (!files.includes(file)) files.push(file);
          keyFiles.set(key, files);
        }
      }
    }
  } catch { /* no Python files or grep fails */ }

  // Pattern 2: ["snake_case_key"] — broad grep, precise JS filter
  try {
    const output = execSync(
      `grep -rn --include='*.py' ${STANDARD_EXCLUDES} ` +
        `-E '[[]' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    for (const line of output.split('\n').filter(Boolean)) {
      const match = line.match(/\[\s*['"]([a-z]+(?:_[a-z0-9]+)+)['"]\s*\]/);
      if (match) {
        const key = match[1];
        const fileMatch = line.match(/^\.\/([^:]+):/);
        const file = fileMatch?.[1] || '';
        if (!ALLOWLIST.has(key) && file) {
          const files = keyFiles.get(key) || [];
          if (!files.includes(file)) files.push(file);
          keyFiles.set(key, files);
        }
      }
    }
  } catch { /* grep fails */ }

  return keyFiles;
}

function extractCamelKeysFromJs(root: string): Map<string, string[]> {
  const keyFiles = new Map<string, string[]>();

  // Look for camelCase keys on boundary objects
  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
        `${STANDARD_EXCLUDES} ` +
        `-E '\\.(claims|payload|data|body|params|query|user|auth|token|decoded|result)\\.[a-z]+[A-Z][a-zA-Z]*' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    for (const line of output.split('\n').filter(Boolean)) {
      const match = line.match(/\.(claims|payload|data|body|params|query|user|auth|token|decoded|result)\.([a-z]+[A-Z][a-zA-Z0-9]*)/);
      if (match) {
        const key = match[2];
        const fileMatch = line.match(/^\.\/([^:]+):/);
        const file = fileMatch?.[1] || '';
        if (isCamelCase(key) && file) {
          const files = keyFiles.get(key) || [];
          if (!files.includes(file)) files.push(file);
          keyFiles.set(key, files);
        }
      }
    }
  } catch { /* grep fails */ }

  return keyFiles;
}

function findCamelInRepo(root: string, camelKey: string): string[] {
  try {
    const output = execSync(
      `grep -rl --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' ` +
        `--include='*.json' --include='*.yaml' --include='*.yml' ` +
        `${STANDARD_EXCLUDES} '${camelKey}' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    return output.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

function findSnakeInPython(root: string, snakeKey: string): string[] {
  try {
    const output = execSync(
      `grep -rl --include='*.py' ${STANDARD_EXCLUDES} '${snakeKey}' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    return output.split('\n').filter(Boolean).map((f) => f.replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

export default async function namingBoundaryMismatch(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const mismatches: NamingMismatch[] = [];

  // --- Forward pass: snake_case in Python → check for camelCase in JS/TS ---
  const snakeKeys = extractSnakeKeysFromPython(root);

  if (snakeKeys.size > 0) {
    const keysToCheck = [...snakeKeys.keys()].slice(0, MAX_KEYS);
    for (const snakeKey of keysToCheck) {
      const camelKey = snakeToCamel(snakeKey);
      if (camelKey === snakeKey) continue; // no conversion happened
      const jsFiles = findCamelInRepo(root, camelKey);
      if (jsFiles.length > 0) {
        mismatches.push({
          snakeKey,
          camelKey,
          pythonFiles: snakeKeys.get(snakeKey) || [],
          jsFiles,
        });
      }
    }
  }

  // --- Reverse pass: camelCase in JS/TS → check for snake_case in Python ---
  const camelKeys = extractCamelKeysFromJs(root);

  if (camelKeys.size > 0) {
    const keysToCheck = [...camelKeys.keys()].slice(0, MAX_KEYS);
    for (const camelKey of keysToCheck) {
      const snakeKey = camelToSnake(camelKey);
      if (snakeKey === camelKey) continue;
      if (!isSnakeCase(snakeKey)) continue;
      if (ALLOWLIST.has(snakeKey)) continue;
      // Skip if already found in forward pass
      if (mismatches.some((m) => m.snakeKey === snakeKey && m.camelKey === camelKey)) continue;

      const pyFiles = findSnakeInPython(root, snakeKey);
      if (pyFiles.length > 0) {
        mismatches.push({
          snakeKey,
          camelKey,
          pythonFiles: pyFiles,
          jsFiles: camelKeys.get(camelKey) || [],
        });
      }
    }
  }

  // --- No Python or JS files at all → graceful skip ---
  if (snakeKeys.size === 0 && camelKeys.size === 0) {
    return {
      id: 'naming-boundary-mismatch',
      projectId: 'sample-project',
      type: 'contract-drift',
      severity: 'info',
      hint: 'No cross-language boundary detected (no Python+JS/TS key access patterns found)',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  const totalMismatches = mismatches.length;
  let hint: string;

  if (totalMismatches === 0) {
    hint = `No naming convention mismatches found across ${snakeKeys.size} Python key(s) and ${camelKeys.size} JS/TS key(s)`;
  } else {
    const examples = mismatches
      .slice(0, 5)
      .map((m) => `${m.snakeKey}/${m.camelKey} (${m.pythonFiles.length} py + ${m.jsFiles.length} js)`)
      .join(', ');
    hint = `${totalMismatches} cross-boundary naming mismatch(es): ${examples}`;
  }

  const threshold = 0;
  const severity = totalMismatches >= 4 ? 'high' : totalMismatches > 0 ? 'medium' : 'info';

  return {
    id: 'naming-boundary-mismatch',
    projectId: 'sample-project',
    type: 'contract-drift',
    severity,
    hint,
    value: totalMismatches,
    threshold,
    passed: totalMismatches <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
