import { detectPlatforms, validateCiConfigs } from '../lib/cicd-validators';
import type { ValidationResult } from '../lib/cicd-validators';

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

function highestSeverity(results: ValidationResult[]): 'critical' | 'high' | 'medium' | 'low' | 'info' {
  if (results.some((r) => r.severity === 'critical')) return 'critical';
  if (results.some((r) => r.severity === 'high')) return 'high';
  if (results.some((r) => r.severity === 'medium')) return 'medium';
  if (results.some((r) => r.severity === 'low')) return 'low';
  return 'info';
}

export default async function cicdConfig(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const platforms = detectPlatforms(root);

  if (platforms.length === 0) {
    return {
      id: 'cicd-config',
      projectId: 'sample-project',
      type: 'build-config',
      severity: 'info',
      hint: 'No CI/CD config files detected (checked: Cloud Build, CodeBuild, Azure Pipelines, GitHub Actions)',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  const issues = validateCiConfigs(root);

  // Group by platform for hint
  const byPlatform = new Map<string, ValidationResult[]>();
  for (const issue of issues) {
    const list = byPlatform.get(issue.platform) || [];
    list.push(issue);
    byPlatform.set(issue.platform, list);
  }

  const platformNames = platforms.map((p) => p.platform).join(', ');

  let hint: string;
  if (issues.length === 0) {
    hint = `CI/CD configs valid across ${platforms.length} platform(s): ${platformNames}`;
  } else {
    const parts: string[] = [];
    for (const [platform, platformIssues] of byPlatform) {
      parts.push(`${platform}: ${platformIssues.length} issue(s)`);
    }
    hint = `${issues.length} CI/CD config issue(s) found — ${parts.join(', ')}`;
  }

  const threshold = 0;

  return {
    id: 'cicd-config',
    projectId: 'sample-project',
    type: 'build-config',
    severity: issues.length > 0 ? highestSeverity(issues) : 'info',
    hint,
    value: issues.length,
    threshold,
    passed: issues.length <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
