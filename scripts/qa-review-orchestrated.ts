#!/usr/bin/env npx tsx
// qa-review-orchestrated.ts — CLI entry point for the multi-LLM orchestrated engine.
// Invoked by qa-review-remote.sh when ENGINE=orchestrated.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOrchestration } from '../lib/orchestrator/index.js';
import { slugify } from '../lib/project-id.js';
import type { OrchestrationConfig, ProviderName, CoverageStrategy } from '../lib/orchestrator/types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const BOOLEAN_FLAGS = new Set(['no-git']);

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = 'true';
      continue;
    }
    if (i + 1 < argv.length) {
      args[key] = argv[++i];
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const repoPath = args['repo'];
  if (!repoPath) {
    process.stderr.write('Error: --repo is required\n');
    process.exit(1);
  }

  const sparfuchsRoot = args['sparfuchs-root'] ?? join(MODULE_DIR, '..');
  const reportsDir = args['reports-dir'] ?? join(sparfuchsRoot, 'qa-reports');
  const runId = args['run-id'] ?? `qa-${new Date().toISOString().replace(/[T:.-]/g, '').slice(0, 12)}-${Math.random().toString(16).slice(2, 6)}`;
  const mode = (args['mode'] ?? 'full') as OrchestrationConfig['mode'];
  const provider = args['provider'] as ProviderName | undefined;
  const userPrompt = args['user-prompt'] ?? `Run a QA review for this repository.`;
  const moduleScope = args['module'];
  const selectedAgents = args['selected-agents']
    ? args['selected-agents'].split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const composeRules = args['compose-rules'] === 'true' || process.env.COMPOSE_RULES === 'true';
  const autoComplete = args['auto-complete'] === 'true' || process.env.QA_AUTO_COMPLETE === 'true';
  const baseline = args['baseline'] === 'true' || process.env.QA_BASELINE === 'true';
  const coverageArg = args['coverage'] ?? process.env.COVERAGE;
  const coverageStrategy = coverageArg && coverageArg !== 'off'
    ? coverageArg as CoverageStrategy
    : coverageArg === 'off' ? undefined : undefined;
  const concurrencyArg = args['concurrency'] ?? process.env.CONCURRENCY;
  const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : undefined;
  const isGitRepo = args['no-git'] !== 'true';

  if (args['project']) process.env.PROJECT = args['project'];
  process.env.TARGET_REPO = process.env.TARGET_REPO ?? repoPath;
  const projectSlug = slugify(
    args['project'] ?? repoPath.split('/').pop()!,
  );
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16).replace(':', '');
  const sessionLogDir = join(reportsDir, `${dateStr}_${timeStr}_${projectSlug}_session-log`);

  const config: OrchestrationConfig = {
    repoPath,
    sparfuchsRoot,
    reportsDir,
    qaDataRoot: join(sparfuchsRoot, 'qa-data'),
    sessionLogDir,
    runId,
    projectSlug,
    mode,
    providerOverride: provider,
    modelsConfig: undefined as never, // loaded by runOrchestration
    userPrompt,
    selectedAgents,
    moduleScope,
    composeRules,
    autoComplete,
    baseline,
    coverageStrategy,
    concurrency,
    isGitRepo,
  };

  try {
    await runOrchestration(config);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nOrchestration failed: ${msg}\n`);
    process.exit(1);
  }
}

main();
