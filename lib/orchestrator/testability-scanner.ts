import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type {
  RepoProfile, LanguageProfile, UncheckableReport,
  TestInfraReport, AgentSkipPrediction, TestingRecommendation,
  TestabilityReport,
} from './types.js';
import {
  countFilesByExtension as sharedCountFilesByExtension,
  countAllFiles,
  excludePathArgsForFind,
  excludeDirArgsForGrep,
} from './file-discovery.js';

const READ_TOOL_LINE_LIMIT = 2000;

const LANG_MAP: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin',
  '.rb': 'Ruby',
  '.vue': 'Vue', '.svelte': 'Svelte', '.astro': 'Astro',
  '.swift': 'Swift',
  '.cs': 'C#',
  '.php': 'PHP',
};

// --- Public API ---

export async function scanTestability(
  repoPath: string,
  moduleScope?: string,
): Promise<TestabilityReport> {
  const searchRoot = moduleScope ? join(repoPath, moduleScope) : repoPath;

  const repoProfile = profileRepo(searchRoot, repoPath);
  const uncheckable = detectUncheckable(searchRoot);
  const testInfra = assessTestInfra(searchRoot, repoPath);
  const agentPredictions = predictAgentEffectiveness(repoProfile, uncheckable, testInfra);
  const recommendations = generateRecommendations(repoProfile, uncheckable, testInfra);

  return {
    repoProfile,
    uncheckable,
    testInfra,
    agentPredictions,
    recommendations,
    scannedAt: new Date().toISOString(),
  };
}

export function writeTestabilityReport(report: TestabilityReport, runDir: string): void {
  writeFileSync(join(runDir, 'testability.json'), JSON.stringify(report, null, 2));
}

export function printTestabilitySummary(report: TestabilityReport): void {
  const { repoProfile, uncheckable, testInfra, agentPredictions, recommendations } = report;

  process.stderr.write('\n--- Testability Pre-Flight ---\n');
  process.stderr.write(`Languages: ${repoProfile.languages.map(l => `${l.lang} (${l.percentage}%)`).join(', ')}\n`);
  process.stderr.write(`Source files: ${repoProfile.totalSourceFiles}`);
  if (repoProfile.isMonorepo) {
    process.stderr.write(` | Monorepo: ${repoProfile.moduleCount} modules`);
  }
  process.stderr.write('\n');
  process.stderr.write(`Checkability: ${uncheckable.checkabilityScore}% (${uncheckable.totalCheckable} checkable, ${uncheckable.totalUncheckable} excluded)\n`);

  if (testInfra.hasTestFramework) {
    process.stderr.write(`Tests: ${testInfra.testFramework} (${testInfra.testFileCount} files, ratio ${testInfra.testToCodeRatio.toFixed(2)})`);
    if (testInfra.testCoverage !== null) {
      process.stderr.write(` | Coverage: ${testInfra.testCoverage}%`);
    }
    process.stderr.write('\n');
  } else {
    process.stderr.write('Tests: NONE DETECTED\n');
  }

  const skipped = agentPredictions.filter(p => !p.effective);
  if (skipped.length > 0) {
    process.stderr.write(`Agents to skip: ${skipped.map(s => s.agentName).join(', ')}\n`);
  }

  const criticalRecs = recommendations.filter(r => r.priority === 'critical');
  for (const rec of criticalRecs) {
    process.stderr.write(`  CRITICAL: ${rec.title}\n`);
  }

  process.stderr.write('---\n\n');
}

// --- Repo Profiling ---

function profileRepo(searchRoot: string, repoPath: string): RepoProfile {
  const fileCounts = countFilesByExtension(searchRoot);
  const languages = buildLanguageProfile(fileCounts);
  const totalSourceFiles = languages.reduce((sum, l) => sum + l.fileCount, 0);

  return {
    languages,
    frameworks: detectFrameworks(repoPath),
    buildTools: detectBuildTools(repoPath),
    packageManager: detectPackageManager(repoPath),
    isMonorepo: detectMonorepo(repoPath),
    moduleCount: countMonorepoModules(repoPath),
    totalSourceFiles,
  };
}

function countFilesByExtension(searchRoot: string): Map<string, number> {
  // Delegate to the shared file-discovery helper so the exclusion set
  // matches the chunker. Filter down to LANG_MAP keys afterwards.
  const raw = sharedCountFilesByExtension(searchRoot);
  const counts = new Map<string, number>();
  for (const [ext, n] of raw) {
    if (LANG_MAP[ext]) counts.set(ext, n);
  }
  return counts;
}

function buildLanguageProfile(fileCounts: Map<string, number>): LanguageProfile[] {
  const byLang = new Map<string, number>();
  for (const [ext, count] of fileCounts) {
    const lang = LANG_MAP[ext];
    if (lang) {
      byLang.set(lang, (byLang.get(lang) ?? 0) + count);
    }
  }

  const total = [...byLang.values()].reduce((s, c) => s + c, 0) || 1;

  return [...byLang.entries()]
    .map(([lang, fileCount]) => ({
      lang,
      fileCount,
      lineCount: 0, // Skip line counting for speed; can be added if needed
      percentage: Math.round((fileCount / total) * 100),
    }))
    .sort((a, b) => b.fileCount - a.fileCount);
}

function detectFrameworks(repoPath: string): string[] {
  const frameworks: string[] = [];
  const pkgPath = join(repoPath, 'package.json');

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const checks: [string, string][] = [
        ['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'],
        ['@angular/core', 'Angular'], ['svelte', 'Svelte'], ['astro', 'Astro'],
        ['express', 'Express'], ['fastify', 'Fastify'], ['koa', 'Koa'],
        ['hono', 'Hono'], ['nestjs', 'NestJS'], ['@nestjs/core', 'NestJS'],
        ['firebase-functions', 'Firebase Functions'],
        ['firebase-admin', 'Firebase Admin'],
      ];
      for (const [dep, name] of checks) {
        if (allDeps[dep]) frameworks.push(name);
      }
    } catch { /* malformed package.json */ }
  }

  if (existsSync(join(repoPath, 'requirements.txt')) || existsSync(join(repoPath, 'pyproject.toml'))) {
    try {
      const content = existsSync(join(repoPath, 'requirements.txt'))
        ? readFileSync(join(repoPath, 'requirements.txt'), 'utf8')
        : readFileSync(join(repoPath, 'pyproject.toml'), 'utf8');
      if (content.includes('django')) frameworks.push('Django');
      if (content.includes('fastapi')) frameworks.push('FastAPI');
      if (content.includes('flask')) frameworks.push('Flask');
    } catch { /* */ }
  }

  if (existsSync(join(repoPath, 'go.mod'))) frameworks.push('Go');
  if (existsSync(join(repoPath, 'Cargo.toml'))) frameworks.push('Rust');

  return [...new Set(frameworks)];
}

function detectBuildTools(repoPath: string): string[] {
  const tools: string[] = [];
  const checks: [string, string][] = [
    ['webpack.config.js', 'Webpack'], ['webpack.config.ts', 'Webpack'],
    ['vite.config.ts', 'Vite'], ['vite.config.js', 'Vite'],
    ['turbo.json', 'Turborepo'],
    ['nx.json', 'Nx'],
    ['Makefile', 'Make'],
    ['Dockerfile', 'Docker'],
    ['docker-compose.yml', 'Docker Compose'], ['docker-compose.yaml', 'Docker Compose'],
  ];
  for (const [file, tool] of checks) {
    if (existsSync(join(repoPath, file))) tools.push(tool);
  }
  return [...new Set(tools)];
}

function detectPackageManager(repoPath: string): string | null {
  if (existsSync(join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoPath, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoPath, 'package-lock.json'))) return 'npm';
  if (existsSync(join(repoPath, 'bun.lockb'))) return 'bun';
  if (existsSync(join(repoPath, 'go.mod'))) return 'go mod';
  if (existsSync(join(repoPath, 'Cargo.lock'))) return 'cargo';
  if (existsSync(join(repoPath, 'requirements.txt'))) return 'pip';
  return null;
}

function detectMonorepo(repoPath: string): boolean {
  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.workspaces) return true;
    } catch { /* */ }
  }
  return existsSync(join(repoPath, 'lerna.json'))
    || existsSync(join(repoPath, 'nx.json'))
    || existsSync(join(repoPath, 'turbo.json'))
    || existsSync(join(repoPath, 'pnpm-workspace.yaml'));
}

function countMonorepoModules(repoPath: string): number {
  if (!detectMonorepo(repoPath)) return 1;

  // Count directories in common monorepo structures
  const candidates = ['apps', 'packages', 'libs', 'services', 'modules'];
  let count = 0;
  for (const dir of candidates) {
    const fullPath = join(repoPath, dir);
    if (existsSync(fullPath)) {
      try {
        const output = execSync(`ls -d "${fullPath}"/*/ 2>/dev/null | wc -l`, { encoding: 'utf8' });
        count += parseInt(output.trim(), 10) || 0;
      } catch { /* */ }
    }
  }
  return Math.max(count, 1);
}

// --- Uncheckable Code Detection ---

function detectUncheckable(searchRoot: string): UncheckableReport {
  const minifiedFiles = findMinifiedFiles(searchRoot);
  const generatedFiles = findGeneratedFiles(searchRoot);
  const binaryAssets = findBinaryAssets(searchRoot);
  const vendoredCode = findVendoredDirs(searchRoot);
  const largeFiles = findLargeFiles(searchRoot);

  const allUncheckable = new Set([
    ...minifiedFiles, ...generatedFiles, ...binaryAssets, ...vendoredCode, ...largeFiles,
  ]);

  const totalFiles = countAllFiles(searchRoot);

  const totalUncheckable = allUncheckable.size;
  const totalCheckable = Math.max(totalFiles - totalUncheckable, 0);
  const checkabilityScore = totalFiles > 0
    ? Math.round((totalCheckable / totalFiles) * 100)
    : 100;

  return {
    minifiedFiles,
    generatedFiles,
    binaryAssets,
    vendoredCode,
    largeFiles,
    totalUncheckable,
    totalCheckable,
    checkabilityScore,
  };
}

function findMinifiedFiles(searchRoot: string): string[] {
  try {
    const output = execSync(
      `find "${searchRoot}" -type f \\( -name "*.min.js" -o -name "*.min.css" -o -name "*.bundle.js" -o -name "*.bundle.css" \\) ${excludePathArgsForFind()} 2>/dev/null`,
      { maxBuffer: 1024 * 1024, encoding: 'utf8' },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function findGeneratedFiles(searchRoot: string): string[] {
  try {
    const output = execSync(
      `grep -rl ${excludeDirArgsForGrep()} --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" -m 1 -E "(// @generated|DO NOT EDIT|Auto-generated|This file is generated|GENERATED CODE)" "${searchRoot}" 2>/dev/null | head -100`,
      { maxBuffer: 1024 * 1024, encoding: 'utf8' },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function findBinaryAssets(searchRoot: string): string[] {
  try {
    const output = execSync(
      `find "${searchRoot}" -type f \\( -name "*.wasm" -o -name "*.so" -o -name "*.dll" -o -name "*.pyc" -o -name "*.class" -o -name "*.o" \\) ${excludePathArgsForFind()} 2>/dev/null`,
      { maxBuffer: 1024 * 1024, encoding: 'utf8' },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function findVendoredDirs(searchRoot: string): string[] {
  const dirs: string[] = [];
  const candidates = ['vendor', 'third_party', 'third-party', 'external', 'copied'];
  for (const dir of candidates) {
    const fullPath = join(searchRoot, dir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      dirs.push(fullPath);
    }
  }
  return dirs;
}

function findLargeFiles(searchRoot: string): string[] {
  try {
    const output = execSync(
      `find "${searchRoot}" -type f \\( ${Object.keys(LANG_MAP).map(e => `-name "*${e}"`).join(' -o ')} \\) ${excludePathArgsForFind()} -exec sh -c 'wc -l "$1" | awk "\\$1 > ${READ_TOOL_LINE_LIMIT} {print \\$2}"' _ {} \\; 2>/dev/null | head -50`,
      { maxBuffer: 1024 * 1024, encoding: 'utf8', timeout: 10000 },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

// --- Test Infrastructure Assessment ---

function assessTestInfra(searchRoot: string, repoPath: string): TestInfraReport {
  const framework = detectTestFramework(repoPath);
  const testFileCount = countTestFiles(searchRoot);
  const sourceFileCount = countSourceFiles(searchRoot);

  return {
    hasTestFramework: framework !== null,
    testFramework: framework,
    testFileCount,
    testCoverage: readCoverageIfPresent(repoPath),
    hasE2E: detectE2E(repoPath),
    hasCICD: detectCICD(repoPath),
    hasLinting: detectLinting(repoPath),
    hasTypeChecking: detectTypeChecking(repoPath),
    testToCodeRatio: sourceFileCount > 0 ? testFileCount / sourceFileCount : 0,
  };
}

function detectTestFramework(repoPath: string): string | null {
  const checks: [string, string][] = [
    ['vitest.config.ts', 'vitest'], ['vitest.config.js', 'vitest'],
    ['jest.config.ts', 'jest'], ['jest.config.js', 'jest'], ['jest.config.json', 'jest'],
    ['pytest.ini', 'pytest'], ['conftest.py', 'pytest'],
    ['.mocharc.yml', 'mocha'], ['.mocharc.json', 'mocha'],
  ];
  for (const [file, fw] of checks) {
    if (existsSync(join(repoPath, file))) return fw;
  }

  // Check package.json for test framework deps
  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (allDeps['vitest']) return 'vitest';
      if (allDeps['jest']) return 'jest';
      if (allDeps['mocha']) return 'mocha';
      if (allDeps['ava']) return 'ava';
    } catch { /* */ }
  }

  return null;
}

function countTestFiles(searchRoot: string): number {
  try {
    const output = execSync(
      `find "${searchRoot}" -type f \\( -name "*.test.*" -o -name "*.spec.*" -o -name "*_test.*" -o -name "test_*" \\) -not -path "*/node_modules/*" -not -path "*/.claude/*" -not -path "*/generated/*" 2>/dev/null | wc -l`,
      { encoding: 'utf8' },
    );
    return parseInt(output.trim(), 10) || 0;
  } catch { return 0; }
}

function countSourceFiles(searchRoot: string): number {
  try {
    const output = execSync(
      `find "${searchRoot}" -type f \\( ${Object.keys(LANG_MAP).map(e => `-name "*${e}"`).join(' -o ')} \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -not -path "*/.claude/*" -not -path "*/generated/*" -not -name "*.test.*" -not -name "*.spec.*" 2>/dev/null | wc -l`,
      { encoding: 'utf8' },
    );
    return parseInt(output.trim(), 10) || 0;
  } catch { return 0; }
}

function readCoverageIfPresent(repoPath: string): number | null {
  const paths = [
    join(repoPath, 'coverage', 'coverage-summary.json'),
    join(repoPath, 'coverage-summary.json'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        return Math.round(data.total?.lines?.pct ?? data.total?.statements?.pct ?? 0);
      } catch { /* malformed */ }
    }
  }
  return null;
}

function detectE2E(repoPath: string): boolean {
  const configs = [
    'playwright.config.ts', 'playwright.config.js',
    'cypress.config.ts', 'cypress.config.js', 'cypress.json',
  ];
  return configs.some(f => existsSync(join(repoPath, f)));
}

function detectCICD(repoPath: string): boolean {
  return existsSync(join(repoPath, '.github', 'workflows'))
    || existsSync(join(repoPath, '.gitlab-ci.yml'))
    || existsSync(join(repoPath, 'Jenkinsfile'))
    || existsSync(join(repoPath, '.circleci'));
}

function detectLinting(repoPath: string): boolean {
  const configs = [
    '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs',
    'biome.json', 'biome.jsonc',
    '.prettierrc', '.prettierrc.js', '.prettierrc.json',
  ];
  return configs.some(f => existsSync(join(repoPath, f)));
}

function detectTypeChecking(repoPath: string): boolean {
  const tsconfigPath = join(repoPath, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return false;
  try {
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    return tsconfig.compilerOptions?.strict === true
      || tsconfig.compilerOptions?.noImplicitAny === true;
  } catch { return false; }
}

// --- Agent Effectiveness Predictions ---

function predictAgentEffectiveness(
  profile: RepoProfile,
  uncheckable: UncheckableReport,
  testInfra: TestInfraReport,
): AgentSkipPrediction[] {
  const predictions: AgentSkipPrediction[] = [];
  const hasTS = profile.languages.some(l => l.lang === 'TypeScript' || l.lang === 'JavaScript');
  const hasFrontend = profile.frameworks.some(f =>
    ['React', 'Vue', 'Angular', 'Svelte', 'Astro', 'Next.js'].includes(f),
  );

  const rules: { agent: string; effective: boolean; reason: string }[] = [
    {
      agent: 'ui-intent-verifier',
      effective: hasFrontend,
      reason: hasFrontend
        ? 'Frontend framework detected'
        : 'No frontend framework detected — agent analyzes JSX/TSX UI elements',
    },
    {
      agent: 'stale-closure',
      effective: hasTS && hasFrontend,
      reason: hasTS && hasFrontend
        ? 'React/Vue with hooks detected'
        : 'No React/Vue hooks — stale closure checks not applicable',
    },
    {
      agent: 'test-runner',
      effective: testInfra.hasTestFramework,
      reason: testInfra.hasTestFramework
        ? `Test framework detected: ${testInfra.testFramework}`
        : 'No test framework detected — nothing to run',
    },
    {
      agent: 'mock-integrity-checker',
      effective: testInfra.testFileCount > 0,
      reason: testInfra.testFileCount > 0
        ? `${testInfra.testFileCount} test files found`
        : 'No test files found — no mocks to validate',
    },
    {
      agent: 'a11y-reviewer',
      effective: hasFrontend,
      reason: hasFrontend
        ? 'Frontend components detected'
        : 'No frontend components — accessibility review not applicable',
    },
    {
      agent: 'schema-migration-reviewer',
      effective: detectMigrations(profile),
      reason: detectMigrations(profile)
        ? 'Database migrations detected'
        : 'No migration files found (prisma, drizzle, knex, sequelize, django)',
    },
    {
      agent: 'iac-reviewer',
      effective: detectIaC(profile),
      reason: detectIaC(profile)
        ? 'Infrastructure-as-code files detected'
        : 'No IaC files (*.tf, Dockerfile, k8s manifests, docker-compose)',
    },
  ];

  for (const rule of rules) {
    predictions.push({
      agentName: rule.agent,
      effective: rule.effective,
      reason: rule.reason,
    });
  }

  return predictions;
}

function detectMigrations(profile: RepoProfile): boolean {
  return profile.frameworks.some(f =>
    ['Prisma', 'Drizzle', 'Django'].includes(f),
  );
  // NOTE: A more thorough check would grep for migration directories,
  // but frameworks detection via package.json is sufficient for pre-flight.
}

function detectIaC(profile: RepoProfile): boolean {
  return profile.buildTools.some(t =>
    ['Docker', 'Docker Compose'].includes(t),
  );
}

// --- Testing Strategy Recommendations ---

function generateRecommendations(
  profile: RepoProfile,
  uncheckable: UncheckableReport,
  testInfra: TestInfraReport,
): TestingRecommendation[] {
  const recs: TestingRecommendation[] = [];

  if (!testInfra.hasTestFramework) {
    recs.push({
      priority: 'critical',
      category: 'test-infra',
      title: 'No test framework detected',
      description: 'QA agents cannot validate behavior without tests. Test-runner, mock-integrity-checker, and failure-analyzer will be skipped.',
      action: 'Add vitest (TypeScript) or pytest (Python) and write initial tests for critical paths.',
    });
  }

  if (uncheckable.largeFiles.length > 0) {
    recs.push({
      priority: 'high',
      category: 'code-quality',
      title: `${uncheckable.largeFiles.length} files exceed ${READ_TOOL_LINE_LIMIT} lines`,
      description: `Agents will only see the first ${READ_TOOL_LINE_LIMIT} lines of these files. Code beyond that limit is invisible to analysis.`,
      action: `Split large files or use --module to scope analysis. Affected: ${uncheckable.largeFiles.slice(0, 5).join(', ')}${uncheckable.largeFiles.length > 5 ? ` (+${uncheckable.largeFiles.length - 5} more)` : ''}`,
    });
  }

  if (profile.isMonorepo && profile.moduleCount > 5) {
    recs.push({
      priority: 'high',
      category: 'scope',
      title: `Large monorepo with ${profile.moduleCount} modules`,
      description: 'Running agents against the full monorepo will spread step budget thin. Use --module to scope analysis to specific packages.',
      action: 'Run per-module: make qa-review REPO=/path MODULE=apps/your-app',
    });
  }

  if (profile.totalSourceFiles > 500) {
    recs.push({
      priority: 'high',
      category: 'scope',
      title: `Large codebase: ${profile.totalSourceFiles} source files`,
      description: 'Automatic chunking will split work across multiple agent instances. Coverage may still be incomplete for very large repos.',
      action: 'Consider using --module to focus on changed or critical areas.',
    });
  }

  const tsPercentage = profile.languages
    .filter(l => l.lang === 'TypeScript' || l.lang === 'JavaScript')
    .reduce((sum, l) => sum + l.percentage, 0);

  if (tsPercentage < 50 && tsPercentage > 0) {
    recs.push({
      priority: 'medium',
      category: 'agent-config',
      title: `Only ${tsPercentage}% TypeScript/JavaScript`,
      description: 'Several agents (ui-intent-verifier, stale-closure, i18n-missing-key) are optimized for JS/TS. Non-JS/TS code relies primarily on code-reviewer and security-reviewer.',
      action: 'Review agent skip predictions in testability report for language-specific gaps.',
    });
  }

  if (uncheckable.generatedFiles.length > 10) {
    recs.push({
      priority: 'medium',
      category: 'code-quality',
      title: `${uncheckable.generatedFiles.length} generated files detected`,
      description: 'Generated code will produce noise findings. These files are auto-excluded from chunk plans.',
      action: 'Verify generated file detection is accurate. Add // @generated markers to any missed generated files.',
    });
  }

  if (!testInfra.hasCICD) {
    recs.push({
      priority: 'medium',
      category: 'test-infra',
      title: 'No CI/CD pipeline detected',
      description: 'QA findings cannot be enforced automatically without a CI/CD pipeline.',
      action: 'Add GitHub Actions or similar CI to run canaries on every push.',
    });
  }

  if (!testInfra.hasTypeChecking) {
    recs.push({
      priority: 'low',
      category: 'code-quality',
      title: 'TypeScript strict mode not enabled',
      description: 'Without strict type checking, more bugs slip past the compiler to agent analysis.',
      action: 'Enable "strict": true in tsconfig.json for better static guarantees.',
    });
  }

  return recs.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return order[a.priority] - order[b.priority];
  });
}
