import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

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

interface HygieneIssue {
  framework: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
}

type ServerlessFramework = 'firebase-functions' | 'aws-sam' | 'azure-functions';

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

interface DetectedFramework {
  framework: ServerlessFramework;
  configPath: string;
}

function detectFrameworks(root: string): DetectedFramework[] {
  const detected: DetectedFramework[] = [];

  // Firebase Functions
  const firebaseJson = path.join(root, 'firebase.json');
  const functionsDir = path.join(root, 'functions');
  if (fs.existsSync(firebaseJson) && fs.existsSync(functionsDir)) {
    detected.push({ framework: 'firebase-functions', configPath: 'firebase.json' });
  }

  // AWS SAM
  for (const f of ['template.yaml', 'template.yml']) {
    const samPath = path.join(root, f);
    if (fs.existsSync(samPath)) {
      try {
        const content = fs.readFileSync(samPath, 'utf-8');
        if (/AWSTemplateFormatVersion|Transform.*Serverless/i.test(content)) {
          detected.push({ framework: 'aws-sam', configPath: f });
        }
      } catch { /* read error */ }
    }
  }

  // Azure Functions
  const hostJson = path.join(root, 'host.json');
  if (fs.existsSync(hostJson)) {
    detected.push({ framework: 'azure-functions', configPath: 'host.json' });
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Firebase Functions checks
// ---------------------------------------------------------------------------

function checkFirebaseFunctions(root: string): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  const indexPath = path.join(root, 'functions', 'src', 'index.ts');

  if (!fs.existsSync(indexPath)) {
    // Try index.js fallback
    const jsPath = path.join(root, 'functions', 'src', 'index.js');
    if (!fs.existsSync(jsPath)) {
      issues.push({
        framework: 'Firebase Functions',
        severity: 'high',
        message: 'functions/src/index.ts (or .js) not found — functions cannot be deployed without an entry point',
      });
      return issues;
    }
  }

  const entryFile = fs.existsSync(indexPath) ? indexPath : path.join(root, 'functions', 'src', 'index.js');
  const entryContent = fs.readFileSync(entryFile, 'utf-8');

  // Extract exported names
  const exportedNames = new Set<string>();
  // Named exports: export const name = ...
  for (const m of entryContent.matchAll(/export\s+const\s+(\w+)/g)) {
    exportedNames.add(m[1]);
  }
  // Re-exports: export { name } from ... or export { name as alias } from ...
  for (const m of entryContent.matchAll(/export\s*\{([^}]+)\}/g)) {
    const names = m[1].split(',').map((n) => {
      const parts = n.trim().split(/\s+as\s+/);
      return parts[parts.length - 1].trim();
    });
    for (const name of names) {
      if (name) exportedNames.add(name);
    }
  }
  // exports.name = ...
  for (const m of entryContent.matchAll(/exports\.(\w+)\s*=/g)) {
    exportedNames.add(m[1]);
  }

  // Check for duplicate export names (shouldn't compile, but check anyway)
  const exportCounts = new Map<string, number>();
  for (const m of entryContent.matchAll(/export\s+(?:const|function|class)\s+(\w+)/g)) {
    exportCounts.set(m[1], (exportCounts.get(m[1]) || 0) + 1);
  }
  for (const [name, count] of exportCounts) {
    if (count > 1) {
      issues.push({
        framework: 'Firebase Functions',
        severity: 'high',
        message: `Duplicate export '${name}' found ${count} times in index — deploy will fail`,
      });
    }
  }

  // Check for mixed v1/v2 imports
  let hasV1 = false;
  let hasV2 = false;
  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.js' -E "from ['\"]firebase-functions" functions/src/ 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    for (const line of output.split('\n').filter(Boolean)) {
      if (/firebase-functions\/v2/.test(line) || /firebase-functions\/https/.test(line)) {
        hasV2 = true;
      } else if (/from\s+['"]firebase-functions['"]/.test(line)) {
        hasV1 = true;
      }
    }
  } catch { /* grep fails */ }

  if (hasV1 && hasV2) {
    issues.push({
      framework: 'Firebase Functions',
      severity: 'medium',
      message: 'Mixed firebase-functions v1 and v2 imports — can cause deployment issues with function invoker permissions',
    });
  }

  // Check for functions defined but not exported from index
  try {
    const output = execSync(
      `grep -rn --include='*.ts' --include='*.js' -E "(onRequest|onCall|onSchedule|onDocument|onObject|onMessage)\\(" functions/src/ 2>/dev/null || true`,
      { cwd: root, encoding: 'utf-8' },
    );
    const definedInFiles = new Map<string, string[]>();
    for (const line of output.split('\n').filter(Boolean)) {
      const fileMatch = line.match(/^functions\/src\/([^:]+):/);
      if (!fileMatch) continue;
      // Skip index file itself and test files
      if (/index\.(ts|js)$/.test(fileMatch[1])) continue;
      if (/\.(test|spec)\.(ts|js)$/.test(fileMatch[1])) continue;

      const funcMatch = line.match(/(?:const|let|var|export\s+const)\s+(\w+)\s*=/);
      if (funcMatch) {
        const file = fileMatch[1];
        if (!definedInFiles.has(file)) definedInFiles.set(file, []);
        definedInFiles.get(file)!.push(funcMatch[1]);
      }
    }

    // Check if any source file with functions is imported by index
    for (const [file, funcNames] of definedInFiles) {
      const moduleName = file.replace(/\.(ts|js)$/, '');
      const isImported = entryContent.includes(`./${moduleName}`) || entryContent.includes(`./${file}`);
      if (!isImported) {
        issues.push({
          framework: 'Firebase Functions',
          severity: 'low',
          message: `functions/src/${file} defines ${funcNames.length} function(s) but is not imported by index — they won't be deployed`,
        });
      }
    }
  } catch { /* grep fails */ }

  // Check for invalid function names
  for (const name of exportedNames) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      issues.push({
        framework: 'Firebase Functions',
        severity: 'high',
        message: `Function name '${name}' contains invalid characters — deploy will fail`,
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// AWS SAM checks
// ---------------------------------------------------------------------------

function checkAwsSam(root: string, configPath: string): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  const templatePath = path.join(root, configPath);

  try {
    const doc = parseYaml(fs.readFileSync(templatePath, 'utf-8')) as Record<string, unknown>;
    const resources = (doc.Resources as Record<string, Record<string, unknown>>) || {};

    const functionNames = new Set<string>();
    const runtimes = new Set<string>();

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== 'AWS::Serverless::Function' && resource.Type !== 'AWS::Lambda::Function') continue;

      const props = (resource.Properties as Record<string, unknown>) || {};

      // Check for duplicate FunctionName
      const funcName = props.FunctionName as string;
      if (funcName) {
        if (functionNames.has(funcName)) {
          issues.push({
            framework: 'AWS SAM',
            severity: 'high',
            message: `Duplicate FunctionName '${funcName}' in template — deploy will fail`,
          });
        }
        functionNames.add(funcName);
      }

      // Check Handler resolves to actual file
      const handler = props.Handler as string;
      if (handler && !/\$\{/.test(handler)) {
        // Handler format: path/to/file.functionName
        const lastDot = handler.lastIndexOf('.');
        if (lastDot > 0) {
          const filePath = handler.substring(0, lastDot);
          const codeUri = (props.CodeUri as string) || '.';
          const resolvedBase = path.join(root, codeUri);

          // Check common extensions
          const extensions = ['.ts', '.js', '.mjs', '.py', '.go'];
          const exists = extensions.some((ext) =>
            fs.existsSync(path.join(resolvedBase, filePath + ext)),
          );
          if (!exists && !fs.existsSync(path.join(resolvedBase, filePath))) {
            issues.push({
              framework: 'AWS SAM',
              severity: 'high',
              message: `Handler '${handler}' in ${logicalId} — file '${filePath}' not found under '${codeUri}'`,
            });
          }
        }
      }

      // Track runtimes
      const runtime = props.Runtime as string;
      if (runtime) runtimes.add(runtime);
    }

    // Check for mixed runtimes (same language, different versions)
    const nodeRuntimes = [...runtimes].filter((r) => r.startsWith('nodejs'));
    if (nodeRuntimes.length > 1) {
      issues.push({
        framework: 'AWS SAM',
        severity: 'medium',
        message: `Mixed Node.js runtimes in template: ${nodeRuntimes.join(', ')} — consider standardizing`,
      });
    }
    const pyRuntimes = [...runtimes].filter((r) => r.startsWith('python'));
    if (pyRuntimes.length > 1) {
      issues.push({
        framework: 'AWS SAM',
        severity: 'medium',
        message: `Mixed Python runtimes in template: ${pyRuntimes.join(', ')} — consider standardizing`,
      });
    }
  } catch { /* parse error */ }

  return issues;
}

// ---------------------------------------------------------------------------
// Azure Functions checks
// ---------------------------------------------------------------------------

function checkAzureFunctions(root: string): HygieneIssue[] {
  const issues: HygieneIssue[] = [];
  const hostPath = path.join(root, 'host.json');

  try {
    const host = JSON.parse(fs.readFileSync(hostPath, 'utf-8')) as Record<string, unknown>;

    // Check host.json version
    if (!host.version) {
      issues.push({
        framework: 'Azure Functions',
        severity: 'medium',
        message: 'host.json missing version field — may cause deployment issues',
      });
    }

    // Check for function.json files in subdirectories (v3 programming model)
    const entries = fs.readdirSync(root);
    const functionDirs: string[] = [];
    for (const entry of entries) {
      const funcJsonPath = path.join(root, entry, 'function.json');
      if (fs.existsSync(funcJsonPath)) {
        functionDirs.push(entry);

        try {
          const funcJson = JSON.parse(fs.readFileSync(funcJsonPath, 'utf-8')) as Record<string, unknown>;
          const bindings = (funcJson.bindings as Array<Record<string, unknown>>) || [];

          // Check each binding has required type field
          for (const binding of bindings) {
            if (!binding.type) {
              issues.push({
                framework: 'Azure Functions',
                severity: 'high',
                message: `${entry}/function.json has a binding without 'type' field — function will fail to load`,
              });
            }
          }

          // Check scriptFile exists
          const scriptFile = funcJson.scriptFile as string;
          if (scriptFile) {
            const resolved = path.join(root, entry, scriptFile);
            if (!fs.existsSync(resolved)) {
              issues.push({
                framework: 'Azure Functions',
                severity: 'high',
                message: `${entry}/function.json references scriptFile '${scriptFile}' which does not exist`,
              });
            }
          }
        } catch { /* malformed function.json */ }
      }
    }

    // Check for duplicate function names
    const names = new Set<string>();
    for (const dir of functionDirs) {
      if (names.has(dir)) {
        issues.push({
          framework: 'Azure Functions',
          severity: 'high',
          message: `Duplicate function directory '${dir}' — deploy will fail`,
        });
      }
      names.add(dir);
    }
  } catch { /* host.json parse error */ }

  return issues;
}

// ---------------------------------------------------------------------------
// Main canary
// ---------------------------------------------------------------------------

export default async function serverlessHygiene(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const frameworks = detectFrameworks(root);

  if (frameworks.length === 0) {
    return {
      id: 'serverless-hygiene',
      projectId: 'the-forge',
      type: 'deploy-readiness',
      severity: 'info',
      hint: 'No serverless framework detected (checked: Firebase Functions, AWS SAM, Azure Functions)',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  const allIssues: HygieneIssue[] = [];

  for (const fw of frameworks) {
    switch (fw.framework) {
      case 'firebase-functions':
        allIssues.push(...checkFirebaseFunctions(root));
        break;
      case 'aws-sam':
        allIssues.push(...checkAwsSam(root, fw.configPath));
        break;
      case 'azure-functions':
        allIssues.push(...checkAzureFunctions(root));
        break;
    }
  }

  const hasCritical = allIssues.some((i) => i.severity === 'critical');
  const hasHigh = allIssues.some((i) => i.severity === 'high');
  const hasMedium = allIssues.some((i) => i.severity === 'medium');

  const frameworkNames = frameworks.map((f) => f.framework).join(', ');

  let hint: string;
  if (allIssues.length === 0) {
    hint = `Serverless hygiene clean — ${frameworkNames}`;
  } else {
    const msgs = allIssues.slice(0, 3).map((i) => `[${i.framework}] ${i.message}`);
    hint = `${allIssues.length} serverless issue(s): ${msgs.join('; ')}`;
    if (allIssues.length > 3) hint += ` (+${allIssues.length - 3} more)`;
  }

  const threshold = 0;

  return {
    id: 'serverless-hygiene',
    projectId: 'the-forge',
    type: 'deploy-readiness',
    severity: hasCritical ? 'critical' : hasHigh ? 'high' : hasMedium ? 'medium' : allIssues.length > 0 ? 'low' : 'info',
    hint,
    value: allIssues.length,
    threshold,
    passed: allIssues.length <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
