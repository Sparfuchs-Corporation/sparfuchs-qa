// agent-scopes — category + scope-pattern map for every agent in the
// registry. Drives the TTY Files column rendering and the per-agent
// coverage grading.
//
// Categories:
//   chunked   — general reviewer, assigned a slice of the full source
//   pattern   — domain reviewer, scoped to files matching specific globs
//   command   — runs shell commands, reads a handful of configs
//   synthesis — reads other agents' findings JSON, not source code
//   probe     — hits a live environment (HTTP, browser)
//   hybrid    — mix of git/shell and pattern-file reads
//
// This is the single source of truth — agent .md frontmatter can override
// via `scope_category:`, but the orchestrator never guesses from the name.

export type ScopeCategory =
  | 'chunked'
  | 'pattern'
  | 'command'
  | 'synthesis'
  | 'probe'
  | 'hybrid';

export interface AgentScope {
  category: ScopeCategory;
  // Glob patterns defining the file scope for `pattern` agents. The
  // preflight enumerates matches to produce the denominator.
  patterns?: readonly string[];
  // Label for the `probe` category number (e.g. "probes", "endpoints").
  probeLabel?: string;
}

export const AGENT_SCOPES: Record<string, AgentScope> = {
  // --- chunked ---
  'code-reviewer': { category: 'chunked' },
  'security-reviewer': { category: 'chunked' },
  'performance-reviewer': { category: 'chunked' },
  'a11y-reviewer': { category: 'chunked' },
  'observability-auditor': { category: 'chunked' },

  // --- pattern ---
  'rbac-reviewer': {
    category: 'pattern',
    patterns: ['**/auth/**', '**/middleware/**', '**/guards/**', '**/permissions.*', 'firestore/*.rules', 'firestore/**/*.rules'],
  },
  'api-spec-reviewer': {
    category: 'pattern',
    patterns: ['**/openapi.yaml', '**/openapi.yml', '**/openapi.json', '**/swagger.yaml', '**/swagger.yml', '**/swagger.json', '**/*.proto', 'api-gateway/**/*.yaml', 'api-gateway/**/*.yml'],
  },
  'iac-reviewer': {
    category: 'pattern',
    patterns: ['**/*.tf', '**/*.tfvars', '**/Dockerfile*', '.github/workflows/**/*.yml', '**/cloudbuild*.yaml', 'helm/**', 'k8s/**/*.yaml', 'infra/**'],
  },
  'schema-migration-reviewer': {
    category: 'pattern',
    patterns: ['**/migrations/**', 'db/migrations/**', '**/drizzle.config.*', 'prisma/schema.prisma', '**/schema.sql', '**/*.entity.ts'],
  },
  'contract-reviewer': {
    category: 'pattern',
    patterns: ['**/api/**/*.ts', '**/api/**/*.js', '**/routes/**', '**/controllers/**', '**/types.ts', '**/types/*.ts'],
  },
  'dead-code-reviewer': {
    category: 'pattern',
    patterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py'],
  },
  'stub-detector': {
    category: 'pattern',
    patterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py'],
  },
  'compliance-reviewer': {
    category: 'pattern',
    patterns: ['**/models/**', '**/entities/**', '**/types.ts', '**/user*.ts', '**/profile*.ts', '**/privacy*.ts'],
  },
  'deploy-readiness-reviewer': {
    category: 'pattern',
    patterns: ['.env*', '**/.env*', '**/config/**', 'Dockerfile*', 'docker-compose*.yml', '.github/workflows/**', 'ci/**'],
  },
  'access-query-validator': {
    category: 'pattern',
    patterns: ['firestore/**/*.rules', '**/queries/**', '**/repositories/**', '**/*.repository.ts', '**/*.dao.ts'],
  },
  'permission-chain-checker': {
    category: 'pattern',
    patterns: ['**/auth/**', '**/permissions/**', '**/roles/**', '**/*.guard.ts', '**/middleware/**'],
  },
  'collection-reference-validator': {
    category: 'pattern',
    patterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.py'],
  },
  'role-visibility-matrix': {
    category: 'pattern',
    patterns: ['**/roles.ts', '**/permissions.ts', '**/rbac.*', 'firestore/**/*.rules', '**/middleware/**'],
  },
  'ui-intent-verifier': {
    category: 'pattern',
    patterns: ['**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.svelte'],
  },
  'doc-reviewer': {
    category: 'pattern',
    patterns: ['**/*.md', '**/*.mdx', '**/*.txt', 'docs/**', 'README*'],
  },
  'ref-doc-verifier': {
    category: 'pattern',
    patterns: ['**/*.md', 'docs/**', 'README*', 'ARCHITECTURE*', 'SPEC*'],
  },
  'spec-verifier': {
    category: 'pattern',
    patterns: ['**/*.md', 'docs/**', 'SPEC*', 'PRD*', 'REQUIREMENTS*'],
  },
  'python-linter': {
    category: 'pattern',
    patterns: ['apps/**/*.py', 'services/**/*.py', 'functions/**/*.py', 'libs/**/*.py', 'scripts/**/*.py'],
  },
  'cost-analyzer': {
    category: 'pattern',
    patterns: ['**/*.tf', '**/*.tfvars', 'helm/**', 'k8s/**/*.yaml', 'serverless.yml', 'infra/**', '.github/workflows/**'],
  },
  'iam-drift-auditor': {
    category: 'pattern',
    patterns: ['firestore/**/*.rules', 'libs/py-auth/**/*.py', 'libs/ts-auth/**/*.ts', '**/auth/**', '**/openapi.yaml'],
  },

  // --- command ---
  'build-verifier': { category: 'command' },
  'semantic-diff-reviewer': { category: 'command' },
  'test-runner': { category: 'command' },
  'smoke-test-runner': { category: 'command' },
  'sca-reviewer': { category: 'command' },
  'dependency-auditor': { category: 'command' },
  'failure-analyzer': { category: 'command' },

  // --- synthesis ---
  'qa-gap-analyzer': { category: 'synthesis' },
  'release-gate-synthesizer': { category: 'synthesis' },

  // --- probe ---
  'api-contract-prober': { category: 'probe', probeLabel: 'probes' },
  'e2e-tester': { category: 'probe', probeLabel: 'journeys' },
  'boundary-fuzzer': { category: 'probe', probeLabel: 'fuzzed' },

  // --- hybrid ---
  'risk-analyzer': { category: 'hybrid' },
  'regression-risk-scorer': { category: 'hybrid' },
  'mock-integrity-checker': { category: 'hybrid' },
  'environment-parity-checker': { category: 'hybrid' },
  'fixture-generator': { category: 'hybrid' },
  'crud-tester': { category: 'hybrid' },
  'workflow-extractor': { category: 'hybrid' },
  'training-system-builder': { category: 'hybrid' },
  'architecture-doc-builder': { category: 'hybrid' },
};

/** Lookup with a conservative default (pattern) so unknown agents still
 *  get a coverage number instead of `—`. */
export function getAgentScope(agentName: string): AgentScope {
  return AGENT_SCOPES[agentName] ?? { category: 'pattern' };
}
