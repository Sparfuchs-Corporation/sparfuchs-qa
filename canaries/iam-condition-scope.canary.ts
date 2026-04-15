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

interface IamIssue {
  source: 'terraform' | 'iam-policy-json';
  file: string;
  role: string;
  conditionSnippet: string;
  conditionType: 'startsWith' | 'contains' | 'endsWith' | 'exact-match';
}

// Roles that grant create/delete permissions — conditions on these silently block
// create operations because IAM evaluates creates against the parent resource.
const DANGEROUS_ROLE_PATTERNS = [
  /roles\/secretmanager\.admin/,
  /roles\/storage\.admin/,
  /roles\/storage\.objectCreator/,
  /roles\/cloudsql\.admin/,
  /roles\/cloudsql\.editor/,
  /roles\/iam\.serviceAccountAdmin/,
  /roles\/iam\.serviceAccountCreator/,
  /roles\/pubsub\.admin/,
  /roles\/pubsub\.editor/,
  /roles\/cloudfunctions\.admin/,
  /roles\/cloudfunctions\.developer/,
  /roles\/run\.admin/,
  /roles\/run\.developer/,
  /roles\/editor/,
  /roles\/owner/,
];

// Also flag custom roles with admin/creator in the name
const CUSTOM_ROLE_PATTERN = /roles\/.*(admin|creator)/i;

const RESOURCE_NAME_CONDITION = /resource\.name/;

function isDangerousRole(role: string): boolean {
  // Skip variable-interpolated roles — cannot evaluate statically
  if (role.includes('var.') || role.includes('${')) return false;

  for (const pattern of DANGEROUS_ROLE_PATTERNS) {
    if (pattern.test(role)) return true;
  }
  return CUSTOM_ROLE_PATTERN.test(role);
}

function classifyCondition(expression: string): IamIssue['conditionType'] {
  if (/startsWith/.test(expression)) return 'startsWith';
  if (/\.contains/.test(expression) || /hasPrefix/.test(expression)) return 'contains';
  if (/endsWith/.test(expression)) return 'endsWith';
  return 'exact-match';
}

// ---------------------------------------------------------------------------
// Path A: Terraform files
// ---------------------------------------------------------------------------

function scanTerraformFiles(root: string): IamIssue[] {
  const issues: IamIssue[] = [];

  let tfFiles: string[];
  try {
    const output = execSync(
      `grep -rl --include='*.tf' --exclude-dir=.terraform --exclude-dir=.git ` +
        `-E 'google_.*_iam' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    tfFiles = output.split('\n').filter(Boolean);
  } catch {
    return issues;
  }

  for (const relFile of tfFiles) {
    const filePath = path.resolve(root, relFile);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Extract resource blocks for google_*_iam_* resources
    const resourcePattern = /resource\s+"(google_\w+_iam_\w+)"\s+"[^"]+"\s*\{/g;
    let resourceMatch: RegExpExecArray | null;

    while ((resourceMatch = resourcePattern.exec(content)) !== null) {
      const blockStart = resourceMatch.index + resourceMatch[0].length;
      const block = extractBlock(content, blockStart);
      if (!block) continue;

      // Extract role
      const roleMatch = block.match(/role\s*=\s*"([^"]+)"/);
      if (!roleMatch) continue;
      const role = roleMatch[1];

      if (!isDangerousRole(role)) continue;

      // Check for condition block with resource.name
      const conditionMatch = block.match(/condition\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
      if (!conditionMatch) continue;

      const conditionBlock = conditionMatch[1];
      const expressionMatch = conditionBlock.match(/expression\s*=\s*"([^"]+)"/);
      if (!expressionMatch) continue;

      const expression = expressionMatch[1];
      if (!RESOURCE_NAME_CONDITION.test(expression)) continue;

      // Skip conditions on resource.type (not resource.name)
      if (/resource\.type/.test(expression) && !/resource\.name/.test(expression)) continue;

      issues.push({
        source: 'terraform',
        file: relFile.replace(/^\.\//, ''),
        role,
        conditionSnippet: expression.slice(0, 120),
        conditionType: classifyCondition(expression),
      });
    }
  }

  return issues;
}

function extractBlock(content: string, startIndex: number): string | null {
  let depth = 1;
  let i = startIndex;

  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }

  if (depth !== 0) return null;
  return content.slice(startIndex, i - 1);
}

// ---------------------------------------------------------------------------
// Path B: IAM policy JSON files
// ---------------------------------------------------------------------------

interface IamBinding {
  role: string;
  members?: string[];
  condition?: {
    expression: string;
    title?: string;
    description?: string;
  };
}

function scanIamPolicyJson(root: string): IamIssue[] {
  const issues: IamIssue[] = [];

  let jsonFiles: string[];
  try {
    const output = execSync(
      `grep -rl --include='*.json' --exclude-dir=node_modules --exclude-dir=.git ` +
        `--exclude-dir=.terraform '"bindings"' . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 },
    );
    jsonFiles = output.split('\n').filter(Boolean);
  } catch {
    return issues;
  }

  for (const relFile of jsonFiles) {
    const filePath = path.resolve(root, relFile);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    let doc: { bindings?: IamBinding[] };
    try {
      doc = JSON.parse(content);
    } catch {
      continue;
    }

    if (!Array.isArray(doc.bindings)) continue;

    for (const binding of doc.bindings) {
      if (!binding.role || !binding.condition?.expression) continue;
      if (!isDangerousRole(binding.role)) continue;
      if (!RESOURCE_NAME_CONDITION.test(binding.condition.expression)) continue;

      issues.push({
        source: 'iam-policy-json',
        file: relFile.replace(/^\.\//, ''),
        role: binding.role,
        conditionSnippet: binding.condition.expression.slice(0, 120),
        conditionType: classifyCondition(binding.condition.expression),
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Canary entry point
// ---------------------------------------------------------------------------

export default async function iamConditionScope(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();

  const tfIssues = scanTerraformFiles(root);
  const jsonIssues = scanIamPolicyJson(root);
  const allIssues = [...tfIssues, ...jsonIssues];

  if (tfIssues.length === 0 && jsonIssues.length === 0) {
    // Check if there are any Terraform or IAM files at all
    let hasTf = false;
    let hasIamJson = false;
    try {
      const tf = execSync(
        `find . -name '*.tf' -not -path './.terraform/*' -not -path './.git/*' 2>/dev/null | head -1`,
        { cwd: root, encoding: 'utf-8' },
      );
      hasTf = tf.trim().length > 0;
    } catch { /* no find */ }
    try {
      const json = execSync(
        `grep -rl --include='*.json' --exclude-dir=node_modules --exclude-dir=.git '"bindings"' . 2>/dev/null | head -1`,
        { cwd: root, encoding: 'utf-8' },
      );
      hasIamJson = json.trim().length > 0;
    } catch { /* no grep */ }

    if (!hasTf && !hasIamJson) {
      return {
        id: 'iam-condition-scope',
        projectId: 'the-forge',
        type: 'security',
        severity: 'info',
        hint: 'No Terraform or IAM policy files found — IAM condition check skipped',
        value: 0,
        threshold: 0,
        passed: true,
        trend: 'stable',
        lastSeen: new Date().toISOString(),
        history: [],
      };
    }
  }

  const totalIssues = allIssues.length;

  let hint: string;
  if (totalIssues === 0) {
    hint = 'No dangerous IAM conditional bindings found (resource.name conditions on admin roles)';
  } else {
    const examples = allIssues
      .slice(0, 3)
      .map((i) => `${i.role} with ${i.conditionType} condition in ${i.file}`)
      .join('; ');
    hint = `${totalIssues} IAM binding(s) with resource.name conditions on admin/creator roles (creates may be silently blocked): ${examples}`;
  }

  // Severity: startsWith/contains = high (most dangerous), exact-match = medium
  const hasHighSeverity = allIssues.some(
    (i) => i.conditionType === 'startsWith' || i.conditionType === 'contains' || i.conditionType === 'endsWith',
  );
  const severity = totalIssues === 0 ? 'info' : hasHighSeverity ? 'high' : 'medium';

  const threshold = 0;

  return {
    id: 'iam-condition-scope',
    projectId: 'the-forge',
    type: 'security',
    severity,
    hint,
    value: totalIssues,
    threshold,
    passed: totalIssues <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
