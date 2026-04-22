import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CiPlatform =
  | 'gcp-cloudbuild'
  | 'aws-codebuild'
  | 'azure-devops'
  | 'github-actions';

export interface PlatformDetection {
  platform: CiPlatform;
  configFiles: string[];
  confidence: 'high' | 'medium';
}

export interface ValidationResult {
  platform: CiPlatform;
  rule: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  message: string;
  fix: string;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

interface PlatformDetector {
  platform: CiPlatform;
  /** Globs are resolved relative to the repo root. */
  find(root: string): string[];
  /** Return true if file content confirms this platform. */
  confirm(content: string): boolean;
}

const DETECTORS: PlatformDetector[] = [
  {
    platform: 'gcp-cloudbuild',
    find: (root) => listFiles(root, /^cloudbuild.*\.ya?ml$/),
    confirm: (c) => /^steps\s*:/m.test(c),
  },
  {
    platform: 'aws-codebuild',
    find: (root) => listFiles(root, /^buildspec.*\.ya?ml$/),
    confirm: (c) => /^version\s*:\s*0\.2/m.test(c) && /^phases\s*:/m.test(c),
  },
  {
    platform: 'azure-devops',
    find: (root) => [
      ...listFiles(root, /^azure-pipelines.*\.ya?ml$/),
      ...listDir(path.join(root, '.azure-pipelines'), /\.ya?ml$/),
    ],
    confirm: (c) => /^(trigger|pool|stages|jobs)\s*:/m.test(c),
  },
  {
    platform: 'github-actions',
    find: (root) => listDir(path.join(root, '.github', 'workflows'), /\.ya?ml$/),
    confirm: (c) => /^on\s*:/m.test(c) && /^jobs\s*:/m.test(c),
  },
];

function listFiles(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => pattern.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function listDir(dir: string, pattern: RegExp): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => pattern.test(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function detectPlatforms(root: string): PlatformDetection[] {
  const results: PlatformDetection[] = [];

  for (const detector of DETECTORS) {
    const files = detector.find(root);
    if (files.length === 0) continue;

    let confirmed = false;
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        if (detector.confirm(content)) {
          confirmed = true;
          break;
        }
      } catch {
        // unreadable file — skip
      }
    }

    results.push({
      platform: detector.platform,
      configFiles: files,
      confidence: confirmed ? 'high' : 'medium',
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Top-level validate — dispatches to per-platform validators
// ---------------------------------------------------------------------------

export function validateCiConfigs(root: string): ValidationResult[] {
  const platforms = detectPlatforms(root);
  const results: ValidationResult[] = [];

  for (const p of platforms) {
    switch (p.platform) {
      case 'gcp-cloudbuild':
        results.push(...validateGcpCloudBuild(root, p.configFiles));
        break;
      case 'aws-codebuild':
        results.push(...validateAwsCodeBuild(root, p.configFiles));
        break;
      case 'azure-devops':
        results.push(...validateAzureDevOps(root, p.configFiles));
        break;
      case 'github-actions':
        results.push(...validateGitHubActions(root, p.configFiles));
        break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseYaml(file: string): unknown | null {
  try {
    return parseYaml(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function relPath(root: string, file: string): string {
  return path.relative(root, file);
}

/** Recursively collect all string values from a nested structure. */
function collectStrings(obj: unknown): string[] {
  const out: string[] = [];
  if (typeof obj === 'string') {
    out.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) out.push(...collectStrings(item));
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) out.push(...collectStrings(val));
  }
  return out;
}

// ---------------------------------------------------------------------------
// GCP Cloud Build
// ---------------------------------------------------------------------------

export function validateGcpCloudBuild(
  root: string,
  files: string[],
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const file of files) {
    const doc = safeParseYaml(file) as Record<string, unknown> | null;
    if (!doc) {
      results.push({
        platform: 'gcp-cloudbuild',
        rule: 'yaml-parse',
        severity: 'high',
        file: relPath(root, file),
        message: 'Failed to parse YAML',
        fix: 'Fix YAML syntax errors',
      });
      continue;
    }

    const rel = relPath(root, file);

    // 1. Substitution references
    const declaredSubs = new Set(Object.keys((doc.substitutions as Record<string, unknown>) || {}));
    const allStrings = collectStrings(doc.steps);
    const GCP_BUILTINS = new Set([
      'PROJECT_ID', 'BUILD_ID', 'COMMIT_SHA', 'SHORT_SHA',
      'BRANCH_NAME', 'TAG_NAME', 'REPO_NAME', 'REVISION_ID',
      'TRIGGER_NAME', 'TRIGGER_BUILD_CONFIG_PATH', 'SERVICE_ACCOUNT_EMAIL',
      'LOCATION', 'SERVICE_ACCOUNT',
    ]);

    for (const s of allStrings) {
      const refs = s.matchAll(/\$_([A-Z][A-Z0-9_]*)/g);
      for (const m of refs) {
        if (!declaredSubs.has(`_${m[1]}`)) {
          results.push({
            platform: 'gcp-cloudbuild',
            rule: 'undefined-substitution',
            severity: 'high',
            file: rel,
            message: `Substitution $_${m[1]} is used but not declared in substitutions: block`,
            fix: `Add _${m[1]} to the substitutions: section or remove the reference`,
          });
        }
      }
    }

    // 2. secretEnv vs availableSecrets
    const steps = (doc.steps as Array<Record<string, unknown>>) || [];
    const availableSecrets = (doc.availableSecrets as Record<string, unknown>) || {};
    const smEntries = (availableSecrets.secretManager as Array<Record<string, unknown>>) || [];
    const declaredSecretEnvs = new Set(smEntries.map((e) => e.env).filter(Boolean));

    for (const step of steps) {
      const secretEnvArr = (step.secretEnv as string[]) || [];
      for (const se of secretEnvArr) {
        if (!declaredSecretEnvs.has(se)) {
          results.push({
            platform: 'gcp-cloudbuild',
            rule: 'orphaned-secret-env',
            severity: 'high',
            file: rel,
            message: `Step "${step.id || step.name}" uses secretEnv '${se}' but no matching availableSecrets.secretManager entry exists`,
            fix: `Add a secretManager entry with env: '${se}' to availableSecrets`,
          });
        }
      }
    }

    // 3. waitFor step ID references
    const declaredIds = new Set(steps.map((s) => s.id as string).filter(Boolean));
    for (const step of steps) {
      const waitFor = (step.waitFor as string[]) || [];
      for (const dep of waitFor) {
        if (dep !== '-' && !declaredIds.has(dep)) {
          results.push({
            platform: 'gcp-cloudbuild',
            rule: 'invalid-wait-for',
            severity: 'high',
            file: rel,
            message: `Step "${step.id || step.name}" has waitFor: '${dep}' but no step has id: '${dep}'`,
            fix: `Fix the step id reference or add a step with id: '${dep}'`,
          });
        }
      }
    }

    // 4. $SHORT_SHA in Docker image tags
    for (const s of allStrings) {
      if (/\$SHORT_SHA/.test(s) && /docker.*build|gcr\.io|pkg\.dev/i.test(s)) {
        results.push({
          platform: 'gcp-cloudbuild',
          rule: 'short-sha-in-tag',
          severity: 'medium',
          file: rel,
          message: '$SHORT_SHA used in Docker image tag — empty when build is triggered manually',
          fix: 'Add a fallback: ${SHORT_SHA:-$BUILD_ID} or use $COMMIT_SHA instead',
        });
        break; // one warning per file
      }
    }

    // 5. images: block vs docker push steps
    const imagesBlock = (doc.images as string[]) || [];
    for (const step of steps) {
      const args = (step.args as string[]) || [];
      const pushIdx = args.indexOf('push');
      if (pushIdx >= 0 && pushIdx + 1 < args.length) {
        const pushedImage = args[pushIdx + 1];
        if (imagesBlock.length > 0 && !imagesBlock.some((img) => pushedImage.includes(img) || img.includes(pushedImage))) {
          results.push({
            platform: 'gcp-cloudbuild',
            rule: 'image-not-in-images-block',
            severity: 'low',
            file: rel,
            message: `docker push target '${pushedImage}' is not listed in images: block`,
            fix: 'Add the image to the images: block so Cloud Build tracks it',
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// AWS CodeBuild
// ---------------------------------------------------------------------------

export function validateAwsCodeBuild(
  root: string,
  files: string[],
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const file of files) {
    const doc = safeParseYaml(file) as Record<string, unknown> | null;
    if (!doc) {
      results.push({
        platform: 'aws-codebuild',
        rule: 'yaml-parse',
        severity: 'high',
        file: relPath(root, file),
        message: 'Failed to parse YAML',
        fix: 'Fix YAML syntax errors',
      });
      continue;
    }

    const rel = relPath(root, file);

    // 1. version check
    if (doc.version !== 0.2) {
      results.push({
        platform: 'aws-codebuild',
        rule: 'buildspec-version',
        severity: 'high',
        file: rel,
        message: `Buildspec version is ${doc.version ?? 'missing'} — must be 0.2`,
        fix: 'Set version: 0.2 at the top of the buildspec',
      });
    }

    // 2. ECR login before docker push
    const phases = (doc.phases as Record<string, Record<string, unknown>>) || {};
    const phaseOrder = ['install', 'pre_build', 'build', 'post_build'];
    const allCommands: { phase: string; cmd: string }[] = [];
    for (const phaseName of phaseOrder) {
      const phase = phases[phaseName];
      if (!phase) continue;
      const cmds = (phase.commands as string[]) || [];
      for (const cmd of cmds) {
        allCommands.push({ phase: phaseName, cmd });
      }
    }

    const hasDockerPush = allCommands.some((c) => /docker\s+push/i.test(c.cmd));
    const hasEcrLogin = allCommands.some((c) => /ecr\s+(get-login-password|get-login)/i.test(c.cmd));

    if (hasDockerPush && !hasEcrLogin) {
      results.push({
        platform: 'aws-codebuild',
        rule: 'ecr-login-missing',
        severity: 'high',
        file: rel,
        message: 'docker push found but no aws ecr get-login-password command precedes it',
        fix: 'Add "aws ecr get-login-password | docker login" to pre_build phase',
      });
    }

    if (hasDockerPush && hasEcrLogin) {
      const pushPhaseIdx = phaseOrder.indexOf(
        allCommands.find((c) => /docker\s+push/i.test(c.cmd))!.phase,
      );
      const loginPhaseIdx = phaseOrder.indexOf(
        allCommands.find((c) => /ecr\s+(get-login-password|get-login)/i.test(c.cmd))!.phase,
      );
      if (loginPhaseIdx > pushPhaseIdx) {
        results.push({
          platform: 'aws-codebuild',
          rule: 'ecr-login-ordering',
          severity: 'high',
          file: rel,
          message: 'ECR login appears in a later phase than docker push',
          fix: 'Move ECR login to pre_build phase (before build/post_build)',
        });
      }
    }

    // 3. secrets-manager format
    const envBlock = (doc.env as Record<string, unknown>) || {};
    const smVars = (envBlock['secrets-manager'] as Record<string, string>) || {};
    for (const [varName, ref] of Object.entries(smVars)) {
      if (typeof ref !== 'string') continue;
      // Valid: secret-id:json-key:version-stage:version-id (colons separate, some fields optional)
      const parts = ref.split(':');
      if (parts.length < 1 || parts[0].trim() === '') {
        results.push({
          platform: 'aws-codebuild',
          rule: 'secrets-manager-format',
          severity: 'high',
          file: rel,
          message: `env.secrets-manager.${varName} has invalid format: '${ref}'`,
          fix: 'Use format: secret-id:json-key:version-stage:version-id',
        });
      }
    }

    // 4. parameter-store format
    const psVars = (envBlock['parameter-store'] as Record<string, string>) || {};
    for (const [varName, ref] of Object.entries(psVars)) {
      if (typeof ref !== 'string') continue;
      if (!ref.startsWith('/')) {
        results.push({
          platform: 'aws-codebuild',
          rule: 'parameter-store-format',
          severity: 'medium',
          file: rel,
          message: `env.parameter-store.${varName} value '${ref}' should start with /`,
          fix: 'Use full SSM parameter path starting with /',
        });
      }
    }

    // 5. on-failure: CONTINUE on build phase
    for (const phaseName of ['build', 'post_build']) {
      const phase = phases[phaseName] as Record<string, unknown> | undefined;
      if (!phase) continue;
      if (phase['on-failure'] === 'CONTINUE') {
        results.push({
          platform: 'aws-codebuild',
          rule: 'silent-failure',
          severity: 'medium',
          file: rel,
          message: `${phaseName} phase has on-failure: CONTINUE — failures will be swallowed`,
          fix: `Remove on-failure: CONTINUE from ${phaseName} or change to ABORT`,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Azure DevOps Pipelines
// ---------------------------------------------------------------------------

const AZURE_PREDEFINED_VARS = new Set([
  'Build.BuildId', 'Build.BuildNumber', 'Build.SourceBranch',
  'Build.SourceBranchName', 'Build.SourceVersion', 'Build.Repository.Name',
  'Build.Repository.Uri', 'Build.DefinitionName', 'Build.Reason',
  'Build.RequestedFor', 'Build.RequestedForEmail', 'Build.ArtifactStagingDirectory',
  'Build.BinariesDirectory', 'Build.SourcesDirectory',
  'System.TeamProject', 'System.CollectionUri', 'System.PullRequest.SourceBranch',
  'System.PullRequest.TargetBranch', 'System.PullRequest.PullRequestId',
  'System.DefaultWorkingDirectory', 'System.JobId', 'System.StageId',
  'Agent.OS', 'Agent.Name', 'Agent.BuildDirectory', 'Agent.TempDirectory',
  'Agent.WorkFolder', 'Agent.HomeDirectory',
  'Pipeline.Workspace', 'Environment.Name', 'Environment.ResourceName',
]);

const AZURE_DEPRECATED_TASKS: Record<string, string> = {
  'Docker@0': 'Docker@2',
  'AzureKeyVault@1': 'AzureKeyVault@2',
  'AzureFunctionApp@1': 'AzureFunctionApp@2',
  'AzureWebApp@0': 'AzureWebApp@1',
  'PublishBuildArtifacts@1': 'PublishPipelineArtifact@1',
  'DownloadBuildArtifacts@0': 'DownloadPipelineArtifact@2',
};

export function validateAzureDevOps(
  root: string,
  files: string[],
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const file of files) {
    const doc = safeParseYaml(file) as Record<string, unknown> | null;
    if (!doc) {
      results.push({
        platform: 'azure-devops',
        rule: 'yaml-parse',
        severity: 'high',
        file: relPath(root, file),
        message: 'Failed to parse YAML',
        fix: 'Fix YAML syntax errors',
      });
      continue;
    }

    const rel = relPath(root, file);

    // 1. Variable references
    const declaredVars = new Set(Object.keys((doc.variables as Record<string, unknown>) || {}));
    // Also collect parameter names
    const params = (doc.parameters as Array<Record<string, unknown>>) || [];
    const declaredParams = new Set(params.map((p) => p.name as string).filter(Boolean));

    const allStrings = collectStrings(doc);
    for (const s of allStrings) {
      // Macro syntax: $(varName)
      const macroRefs = s.matchAll(/\$\(([^)]+)\)/g);
      for (const m of macroRefs) {
        const varName = m[1];
        if (
          !declaredVars.has(varName) &&
          !AZURE_PREDEFINED_VARS.has(varName) &&
          !declaredParams.has(varName) &&
          !varName.startsWith('Build.') &&
          !varName.startsWith('System.') &&
          !varName.startsWith('Agent.') &&
          !varName.startsWith('Pipeline.') &&
          !varName.startsWith('Environment.')
        ) {
          results.push({
            platform: 'azure-devops',
            rule: 'undefined-variable',
            severity: 'medium',
            file: rel,
            message: `Variable $(${varName}) is referenced but not defined in variables: block or as a parameter`,
            fix: `Add '${varName}' to the variables: section, a variable group, or define it as a parameter`,
          });
        }
      }
    }

    // 2. Pool validation
    const hasPool = 'pool' in doc;
    const jobs = extractAzureJobs(doc);
    const jobsHavePool = jobs.every((j) => 'pool' in j);
    if (!hasPool && !jobsHavePool && jobs.length > 0) {
      results.push({
        platform: 'azure-devops',
        rule: 'missing-pool',
        severity: 'medium',
        file: rel,
        message: 'No pool: defined at pipeline or job level',
        fix: 'Add pool: { vmImage: "ubuntu-latest" } at pipeline or job level',
      });
    }

    // 3. Template references
    const templateRefs = collectTemplateRefs(doc);
    for (const ref of templateRefs) {
      // Skip remote template references (they contain @)
      if (ref.includes('@')) continue;
      const templatePath = path.join(root, ref);
      if (!fs.existsSync(templatePath)) {
        results.push({
          platform: 'azure-devops',
          rule: 'missing-template',
          severity: 'high',
          file: rel,
          message: `Template reference '${ref}' points to a file that does not exist`,
          fix: `Create the template file at '${ref}' or fix the reference path`,
        });
      }
    }

    // 4. Deprecated task versions
    const taskRefs = collectTaskRefs(doc);
    for (const taskRef of taskRefs) {
      if (AZURE_DEPRECATED_TASKS[taskRef]) {
        results.push({
          platform: 'azure-devops',
          rule: 'deprecated-task',
          severity: 'medium',
          file: rel,
          message: `Task '${taskRef}' is deprecated`,
          fix: `Upgrade to '${AZURE_DEPRECATED_TASKS[taskRef]}'`,
        });
      }
    }
  }

  return results;
}

function extractAzureJobs(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  const jobs: Array<Record<string, unknown>> = [];
  const stages = (doc.stages as Array<Record<string, unknown>>) || [];
  for (const stage of stages) {
    const stageJobs = (stage.jobs as Array<Record<string, unknown>>) || [];
    jobs.push(...stageJobs);
  }
  const topJobs = (doc.jobs as Array<Record<string, unknown>>) || [];
  jobs.push(...topJobs);
  return jobs;
}

function collectTemplateRefs(obj: unknown): string[] {
  const refs: string[] = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object' && 'template' in item) {
        const val = (item as Record<string, unknown>).template;
        if (typeof val === 'string') refs.push(val);
      }
      refs.push(...collectTemplateRefs(item));
    }
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      refs.push(...collectTemplateRefs(val));
    }
  }
  return refs;
}

function collectTaskRefs(obj: unknown): string[] {
  const refs: string[] = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object' && 'task' in item) {
        const val = (item as Record<string, unknown>).task;
        if (typeof val === 'string') refs.push(val);
      }
      refs.push(...collectTaskRefs(item));
    }
  } else if (obj && typeof obj === 'object') {
    for (const val of Object.values(obj)) {
      refs.push(...collectTaskRefs(val));
    }
  }
  return refs;
}

// ---------------------------------------------------------------------------
// GitHub Actions
// ---------------------------------------------------------------------------

export function validateGitHubActions(
  root: string,
  files: string[],
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const file of files) {
    const doc = safeParseYaml(file) as Record<string, unknown> | null;
    if (!doc) {
      results.push({
        platform: 'github-actions',
        rule: 'yaml-parse',
        severity: 'high',
        file: relPath(root, file),
        message: 'Failed to parse YAML',
        fix: 'Fix YAML syntax errors',
      });
      continue;
    }

    const rel = relPath(root, file);
    const rawContent = fs.readFileSync(file, 'utf-8');

    // 1. Secret leak in run blocks
    const jobs = (doc.jobs as Record<string, Record<string, unknown>>) || {};
    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = (job.steps as Array<Record<string, unknown>>) || [];
      for (const step of steps) {
        const run = step.run as string | undefined;
        if (!run) continue;
        if (/\$\{\{\s*secrets\.[^}]+\}\}/.test(run)) {
          results.push({
            platform: 'github-actions',
            rule: 'secret-in-run',
            severity: 'high',
            file: rel,
            message: `Job '${jobName}' step '${step.name || step.id || '(unnamed)'}' references secrets directly in run: block — risk of log exposure`,
            fix: 'Map secrets to env: variables on the step, then reference $ENV_VAR in run:',
          });
        }
      }
    }

    // 2. Missing permissions block
    if (!('permissions' in doc)) {
      results.push({
        platform: 'github-actions',
        rule: 'missing-permissions',
        severity: 'medium',
        file: rel,
        message: 'Workflow has no top-level permissions: block — defaults may be overly broad',
        fix: 'Add a permissions: block with least-privilege access (e.g., contents: read)',
      });
    }

    // 3. Unpinned action versions
    for (const [jobName, job] of Object.entries(jobs)) {
      const steps = (job.steps as Array<Record<string, unknown>>) || [];
      for (const step of steps) {
        const uses = step.uses as string | undefined;
        if (!uses) continue;
        // Skip local actions (./path) and Docker actions (docker://)
        if (uses.startsWith('./') || uses.startsWith('docker://')) continue;
        const atIdx = uses.lastIndexOf('@');
        if (atIdx < 0) continue;
        const ref = uses.substring(atIdx + 1);
        // SHA-pinned refs are 40 hex chars
        if (!/^[0-9a-f]{40}$/.test(ref)) {
          results.push({
            platform: 'github-actions',
            rule: 'unpinned-action',
            severity: 'low',
            file: rel,
            message: `Job '${jobName}' uses '${uses}' — not pinned to a commit SHA`,
            fix: `Pin to a specific commit SHA: ${uses.substring(0, atIdx)}@<full-sha>`,
          });
        }
      }
    }

    // 4. needs dependency validation
    for (const [jobName, job] of Object.entries(jobs)) {
      const needs = (job.needs as string | string[]) || [];
      const needsArr = Array.isArray(needs) ? needs : [needs];
      const jobNames = new Set(Object.keys(jobs));
      for (const dep of needsArr) {
        if (!jobNames.has(dep)) {
          results.push({
            platform: 'github-actions',
            rule: 'invalid-needs',
            severity: 'high',
            file: rel,
            message: `Job '${jobName}' declares needs: '${dep}' but no job with that name exists`,
            fix: `Fix the job name in needs: or add a job named '${dep}'`,
          });
        }
      }

      // Check needs.*.outputs references
      const stepsArr = (job.steps as Array<Record<string, unknown>>) || [];
      for (const step of stepsArr) {
        const allStepStrings = collectStrings(step);
        for (const s of allStepStrings) {
          const needsOutputRefs = s.matchAll(/\$\{\{\s*needs\.([^.]+)\./g);
          for (const m of needsOutputRefs) {
            if (!needsArr.includes(m[1])) {
              results.push({
                platform: 'github-actions',
                rule: 'needs-output-without-dependency',
                severity: 'high',
                file: rel,
                message: `Job '${jobName}' references needs.${m[1]} but does not declare it in needs:`,
                fix: `Add '${m[1]}' to the needs: array of job '${jobName}'`,
              });
            }
          }
        }
      }
    }
  }

  return results;
}
