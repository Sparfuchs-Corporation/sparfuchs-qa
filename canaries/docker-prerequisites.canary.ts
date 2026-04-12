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

interface DockerIssue {
  platform: CiPlatform | 'generic';
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
}

// ---------------------------------------------------------------------------
// Generic Docker checks
// ---------------------------------------------------------------------------

function checkDockerignore(root: string): DockerIssue[] {
  const dockerfiles = findDockerfiles(root);
  if (dockerfiles.length === 0) return [];

  if (!fs.existsSync(path.join(root, '.dockerignore'))) {
    return [{
      platform: 'generic',
      severity: 'medium',
      message: '.dockerignore missing — .git, node_modules, .env may leak into Docker image',
    }];
  }
  return [];
}

function findDockerfiles(root: string): string[] {
  const files: string[] = [];
  const candidates = [
    'Dockerfile',
    'Dockerfile.dev',
    'Dockerfile.prod',
    'Dockerfile.staging',
  ];

  for (const c of candidates) {
    if (fs.existsSync(path.join(root, c))) files.push(c);
  }

  // Check common subdirectories
  for (const dir of ['services', 'apps', 'packages', 'backend', 'frontend']) {
    const dirPath = path.join(root, dir);
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;
      const entries = fs.readdirSync(dirPath);
      for (const entry of entries) {
        const subdir = path.join(dirPath, entry);
        if (!fs.statSync(subdir).isDirectory()) continue;
        if (fs.existsSync(path.join(subdir, 'Dockerfile'))) {
          files.push(path.join(dir, entry, 'Dockerfile'));
        }
      }
    } catch { /* permission or read error */ }
  }

  return files;
}

// ---------------------------------------------------------------------------
// GCP Cloud Build Docker checks
// ---------------------------------------------------------------------------

function checkGcpDocker(root: string, files: string[]): DockerIssue[] {
  const issues: DockerIssue[] = [];

  for (const file of files) {
    try {
      const doc = parseYaml(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const steps = (doc.steps as Array<Record<string, unknown>>) || [];

      for (const step of steps) {
        const name = step.name as string || '';
        const args = (step.args as string[]) || [];

        // Detect docker build steps
        const isDockerBuilder = /cloud-builders\/docker/.test(name) || /kaniko/.test(name);
        const hasBuildArg = args.includes('build');

        if (isDockerBuilder && hasBuildArg) {
          // Extract Dockerfile path
          const fIdx = args.indexOf('-f');
          const dockerfilePath = fIdx >= 0 && fIdx + 1 < args.length
            ? args[fIdx + 1]
            : 'Dockerfile';

          // Skip paths with substitution variables (can't validate at static time)
          if (!/\$/.test(dockerfilePath)) {
            const resolved = path.join(root, dockerfilePath);
            if (!fs.existsSync(resolved)) {
              issues.push({
                platform: 'gcp-cloudbuild',
                severity: 'critical',
                message: `Dockerfile '${dockerfilePath}' referenced in Cloud Build step does not exist`,
              });
            }
          }

          // Check for SHORT_SHA in -t flag
          const tIdx = args.indexOf('-t');
          if (tIdx >= 0 && tIdx + 1 < args.length) {
            const tag = args[tIdx + 1];
            if (/\$SHORT_SHA/.test(tag) && !/\$\{SHORT_SHA:-/.test(tag)) {
              issues.push({
                platform: 'gcp-cloudbuild',
                severity: 'high',
                message: `Docker tag uses $SHORT_SHA without fallback — empty when triggered manually (tag: ${tag})`,
              });
            }
          }
        }
      }
    } catch { /* parse error */ }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// AWS CodeBuild Docker checks
// ---------------------------------------------------------------------------

function checkAwsDocker(root: string, files: string[]): DockerIssue[] {
  const issues: DockerIssue[] = [];

  for (const file of files) {
    try {
      const doc = parseYaml(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const phases = (doc.phases as Record<string, Record<string, unknown>>) || {};
      const phaseOrder = ['install', 'pre_build', 'build', 'post_build'];

      const allCommands: { phase: string; cmd: string }[] = [];
      for (const phaseName of phaseOrder) {
        const phase = phases[phaseName];
        if (!phase) continue;
        const cmds = (phase.commands as string[]) || [];
        for (const cmd of cmds) allCommands.push({ phase: phaseName, cmd });
      }

      const hasPush = allCommands.some((c) => /docker\s+push/i.test(c.cmd));
      const hasLogin = allCommands.some((c) => /ecr\s+(get-login-password|get-login)/i.test(c.cmd));

      if (hasPush && !hasLogin) {
        issues.push({
          platform: 'aws-codebuild',
          severity: 'high',
          message: 'docker push found but no ECR login command — push will fail with auth error',
        });
      }

      // Check for docker build referencing Dockerfiles
      for (const { cmd } of allCommands) {
        const buildMatch = cmd.match(/docker\s+build\s+.*-f\s+(\S+)/);
        if (buildMatch) {
          const dockerfilePath = buildMatch[1];
          if (!/\$/.test(dockerfilePath) && !fs.existsSync(path.join(root, dockerfilePath))) {
            issues.push({
              platform: 'aws-codebuild',
              severity: 'critical',
              message: `Dockerfile '${dockerfilePath}' referenced in buildspec does not exist`,
            });
          }
        }
      }
    } catch { /* parse error */ }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// GitHub Actions Docker checks
// ---------------------------------------------------------------------------

function checkGhActionsDocker(root: string, files: string[]): DockerIssue[] {
  const issues: DockerIssue[] = [];

  for (const file of files) {
    try {
      const doc = parseYaml(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const jobs = (doc.jobs as Record<string, Record<string, unknown>>) || {};

      for (const [_jobName, job] of Object.entries(jobs)) {
        const steps = (job.steps as Array<Record<string, unknown>>) || [];

        let hasLoginAction = false;
        let hasBuildPush = false;

        for (const step of steps) {
          const uses = step.uses as string || '';
          if (/docker\/login-action/.test(uses)) hasLoginAction = true;
          if (/docker\/build-push-action/.test(uses)) hasBuildPush = true;
        }

        if (hasBuildPush && !hasLoginAction) {
          issues.push({
            platform: 'github-actions',
            severity: 'high',
            message: `docker/build-push-action used without docker/login-action — push will fail`,
          });
        }
      }
    } catch { /* parse error */ }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Azure DevOps Docker checks
// ---------------------------------------------------------------------------

function checkAzureDocker(root: string, files: string[]): DockerIssue[] {
  const issues: DockerIssue[] = [];

  for (const file of files) {
    try {
      const doc = parseYaml(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
      const allStrings = collectStrings(doc);

      // Check for Docker@2 push without containerRegistry
      const steps = extractAllSteps(doc);
      for (const step of steps) {
        const task = step.task as string || '';
        if (/^Docker@\d+$/.test(task)) {
          const inputs = (step.inputs as Record<string, unknown>) || {};
          const command = inputs.command as string || '';
          if (/push/i.test(command) && !inputs.containerRegistry) {
            issues.push({
              platform: 'azure-devops',
              severity: 'high',
              message: 'Docker task push command used without containerRegistry service connection',
            });
          }
        }
      }
    } catch { /* parse error */ }
  }

  return issues;
}

function collectStrings(obj: unknown): string[] {
  const out: string[] = [];
  if (typeof obj === 'string') out.push(obj);
  else if (Array.isArray(obj)) for (const item of obj) out.push(...collectStrings(item));
  else if (obj && typeof obj === 'object') for (const val of Object.values(obj)) out.push(...collectStrings(val));
  return out;
}

function extractAllSteps(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>>[] = [];
  // Top-level steps
  if (Array.isArray(doc.steps)) steps.push(doc.steps as Array<Record<string, unknown>>);
  // Jobs
  const jobs = (doc.jobs as Array<Record<string, unknown>>) || [];
  for (const job of jobs) {
    if (Array.isArray(job.steps)) steps.push(job.steps as Array<Record<string, unknown>>);
  }
  // Stages > jobs
  const stages = (doc.stages as Array<Record<string, unknown>>) || [];
  for (const stage of stages) {
    const stageJobs = (stage.jobs as Array<Record<string, unknown>>) || [];
    for (const job of stageJobs) {
      if (Array.isArray(job.steps)) steps.push(job.steps as Array<Record<string, unknown>>);
    }
  }
  return steps.flat();
}

// ---------------------------------------------------------------------------
// Main canary
// ---------------------------------------------------------------------------

export default async function dockerPrerequisites(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const platforms = detectPlatforms(root);
  const dockerfiles = findDockerfiles(root);

  // No Dockerfiles and no CI configs referencing Docker → skip
  if (dockerfiles.length === 0 && platforms.length === 0) {
    return {
      id: 'docker-prerequisites',
      projectId: 'the-forge',
      type: 'build-config',
      severity: 'info',
      hint: 'No Dockerfiles or CI/CD configs found — Docker checks skipped',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  const allIssues: DockerIssue[] = [];

  // Generic checks
  allIssues.push(...checkDockerignore(root));

  // Platform-specific checks
  for (const p of platforms) {
    switch (p.platform) {
      case 'gcp-cloudbuild':
        allIssues.push(...checkGcpDocker(root, p.configFiles));
        break;
      case 'aws-codebuild':
        allIssues.push(...checkAwsDocker(root, p.configFiles));
        break;
      case 'github-actions':
        allIssues.push(...checkGhActionsDocker(root, p.configFiles));
        break;
      case 'azure-devops':
        allIssues.push(...checkAzureDocker(root, p.configFiles));
        break;
    }
  }

  const hasCritical = allIssues.some((i) => i.severity === 'critical');
  const hasHigh = allIssues.some((i) => i.severity === 'high');

  let hint: string;
  if (allIssues.length === 0) {
    hint = `Docker prerequisites valid — ${dockerfiles.length} Dockerfile(s) found`;
  } else {
    const msgs = allIssues.slice(0, 3).map((i) => i.message);
    hint = `${allIssues.length} Docker issue(s): ${msgs.join('; ')}`;
    if (allIssues.length > 3) hint += ` (+${allIssues.length - 3} more)`;
  }

  const threshold = 0;

  return {
    id: 'docker-prerequisites',
    projectId: 'the-forge',
    type: 'build-config',
    severity: hasCritical ? 'critical' : hasHigh ? 'high' : allIssues.length > 0 ? 'medium' : 'info',
    hint,
    value: allIssues.length,
    threshold,
    passed: allIssues.length <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
