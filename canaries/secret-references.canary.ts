import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { detectPlatforms } from '../lib/cicd-validators';
import type { CiPlatform } from '../lib/cicd-validators';

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

interface SecretRef {
  name: string;
  source: 'code' | 'ci-config';
  platform: CiPlatform | 'application';
  file: string;
}

// ---------------------------------------------------------------------------
// Code-level secret extraction (per serverless framework)
// ---------------------------------------------------------------------------

function extractGcpCodeSecrets(root: string): SecretRef[] {
  const refs: SecretRef[] = [];
  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.js' "defineSecret\\(" functions/src/ 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    for (const line of output.split('\n').filter(Boolean)) {
      const match = line.match(/defineSecret\(\s*['"]([^'"]+)['"]\s*\)/);
      if (match) {
        const fileMatch = line.match(/^([^:]+):/);
        refs.push({ name: match[1], source: 'code', platform: 'application', file: fileMatch?.[1] || '' });
      }
    }
  } catch { /* no functions dir or grep fails */ }
  return refs;
}

function extractAwsCodeSecrets(root: string): SecretRef[] {
  const refs: SecretRef[] = [];
  try {
    // SAM template resolve:secretsmanager references
    const samFiles = ['template.yaml', 'template.yml'].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
    for (const file of samFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      const matches = content.matchAll(/resolve:secretsmanager:([^:}\s'"]+)/g);
      for (const m of matches) {
        refs.push({ name: m[1], source: 'code', platform: 'application', file: path.relative(root, file) });
      }
    }

    // GetSecretValueCommand in code
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.js' "SecretId.*['\"]" src/ lib/ lambda/ 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    for (const line of output.split('\n').filter(Boolean)) {
      const match = line.match(/SecretId\s*:\s*['"]([^'"]+)['"]/);
      if (match) {
        const fileMatch = line.match(/^([^:]+):/);
        refs.push({ name: match[1], source: 'code', platform: 'application', file: fileMatch?.[1] || '' });
      }
    }
  } catch { /* no SAM template or grep fails */ }
  return refs;
}

function extractAzureCodeSecrets(root: string): SecretRef[] {
  const refs: SecretRef[] = [];
  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.js' --include='*.json' "@Microsoft.KeyVault" . 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    for (const line of output.split('\n').filter(Boolean)) {
      const match = line.match(/SecretName=([^)'";\s]+)/);
      if (match) {
        const fileMatch = line.match(/^([^:]+):/);
        refs.push({ name: match[1], source: 'code', platform: 'application', file: fileMatch?.[1] || '' });
      }
    }
  } catch { /* grep fails */ }
  return refs;
}

function extractGhActionsSecrets(root: string): SecretRef[] {
  const refs: SecretRef[] = [];
  try {
    const workflowDir = path.join(root, '.github', 'workflows');
    if (!fs.existsSync(workflowDir)) return refs;
    const files = fs.readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f));
    for (const file of files) {
      const content = fs.readFileSync(path.join(workflowDir, file), 'utf-8');
      const matches = content.matchAll(/\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]*)\s*\}\}/g);
      for (const m of matches) {
        refs.push({ name: m[1], source: 'code', platform: 'github-actions', file: `.github/workflows/${file}` });
      }
    }
  } catch { /* no workflows */ }
  return refs;
}

// ---------------------------------------------------------------------------
// CI config secret extraction
// ---------------------------------------------------------------------------

function extractGcpCiSecrets(root: string, files: string[]): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const file of files) {
    try {
      const doc = parseYaml(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const availableSecrets = (doc.availableSecrets as Record<string, unknown>) || {};
      const smEntries = (availableSecrets.secretManager as Array<Record<string, unknown>>) || [];
      for (const entry of smEntries) {
        const envName = entry.env as string;
        if (envName) {
          refs.push({ name: envName, source: 'ci-config', platform: 'gcp-cloudbuild', file: path.relative(root, file) });
        }
      }
    } catch { /* parse error */ }
  }
  return refs;
}

function extractAwsCiSecrets(root: string, files: string[]): SecretRef[] {
  const refs: SecretRef[] = [];
  for (const file of files) {
    try {
      const doc = parseYaml(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const envBlock = (doc.env as Record<string, unknown>) || {};
      const smVars = (envBlock['secrets-manager'] as Record<string, string>) || {};
      for (const varName of Object.keys(smVars)) {
        refs.push({ name: varName, source: 'ci-config', platform: 'aws-codebuild', file: path.relative(root, file) });
      }
      const psVars = (envBlock['parameter-store'] as Record<string, string>) || {};
      for (const varName of Object.keys(psVars)) {
        refs.push({ name: varName, source: 'ci-config', platform: 'aws-codebuild', file: path.relative(root, file) });
      }
    } catch { /* parse error */ }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Cross-referencing
// ---------------------------------------------------------------------------

export default async function secretReferences(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const platforms = detectPlatforms(root);

  if (platforms.length === 0) {
    return {
      id: 'secret-references',
      projectId: 'the-forge',
      type: 'deploy-readiness',
      severity: 'info',
      hint: 'No CI/CD platforms detected — secret cross-referencing skipped',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  const codeSecrets: SecretRef[] = [];
  const ciSecrets: SecretRef[] = [];

  for (const p of platforms) {
    switch (p.platform) {
      case 'gcp-cloudbuild':
        codeSecrets.push(...extractGcpCodeSecrets(root));
        ciSecrets.push(...extractGcpCiSecrets(root, p.configFiles));
        break;
      case 'aws-codebuild':
        codeSecrets.push(...extractAwsCodeSecrets(root));
        ciSecrets.push(...extractAwsCiSecrets(root, p.configFiles));
        break;
      case 'azure-devops':
        codeSecrets.push(...extractAzureCodeSecrets(root));
        // Azure secrets are typically in variable groups — can't validate statically
        break;
      case 'github-actions':
        codeSecrets.push(...extractGhActionsSecrets(root));
        // GitHub secrets can only be cross-checked across workflows
        break;
    }
  }

  // Find orphaned secrets: in code but not in any CI config
  const ciSecretNames = new Set(ciSecrets.map((s) => s.name));
  const orphaned = codeSecrets.filter((s) => !ciSecretNames.has(s.name));

  // Find partial coverage: CI secrets that appear in some config files but not all for the same platform
  const ciByPlatform = new Map<string, Map<string, Set<string>>>();
  for (const s of ciSecrets) {
    if (!ciByPlatform.has(s.platform)) ciByPlatform.set(s.platform, new Map());
    const platformMap = ciByPlatform.get(s.platform)!;
    if (!platformMap.has(s.name)) platformMap.set(s.name, new Set());
    platformMap.get(s.name)!.add(s.file);
  }

  let partialCount = 0;
  for (const p of platforms) {
    const platformMap = ciByPlatform.get(p.platform);
    if (!platformMap || p.configFiles.length <= 1) continue;
    const relFiles = new Set(p.configFiles.map((f) => path.relative(root, f)));
    for (const [_name, files] of platformMap) {
      if (files.size < relFiles.size) partialCount++;
    }
  }

  const totalIssues = orphaned.length + partialCount;

  let hint: string;
  if (totalIssues === 0) {
    hint = `Secret references consistent across ${platforms.length} platform(s) — ${codeSecrets.length} code ref(s), ${ciSecrets.length} CI config ref(s)`;
  } else {
    const parts: string[] = [];
    if (orphaned.length > 0) {
      const names = [...new Set(orphaned.map((o) => o.name))].slice(0, 5).join(', ');
      parts.push(`${orphaned.length} orphaned (in code, not in CI): ${names}`);
    }
    if (partialCount > 0) {
      parts.push(`${partialCount} with partial environment coverage`);
    }
    hint = `${totalIssues} secret reference issue(s): ${parts.join('; ')}`;
  }

  const threshold = 0;
  const severity = orphaned.length > 0 ? 'high' : partialCount > 0 ? 'medium' : 'info';

  return {
    id: 'secret-references',
    projectId: 'the-forge',
    type: 'deploy-readiness',
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
