#!/usr/bin/env npx tsx
// qa-review-orchestrated.ts — CLI entry point for the multi-LLM orchestrated engine.
// Invoked by qa-review-remote.sh when ENGINE=orchestrated.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOrchestration } from '../lib/orchestrator/index.js';
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
  // MODULE env knob: restrict discovery to a subpath (e.g., libs/shared).
  // Used by preflight's fail+script mode to target gap-healing runs at a
  // single under-covered directory.
  const moduleScope = args['module'] ?? process.env.MODULE ?? undefined;
  // AGENT_ONLY env knob: narrow the agent roster to a single name. Used
  // by preflight's fail+script mode to re-run e.g. a timed-out agent on a
  // longer per-agent budget without re-dispatching the whole wave.
  const agentOnly = process.env.AGENT_ONLY?.trim();
  const selectedAgentsRaw = args['selected-agents'];
  const selectedAgents = agentOnly
    ? [agentOnly]
    : selectedAgentsRaw
      ? selectedAgentsRaw.split(',').map(s => s.trim()).filter(Boolean)
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

  // Derive project slug from repo directory name
  const projectSlug = repoPath.split('/').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  // Session-log dir uses LOCAL time so its timestamp matches the HH-MM-SS
  // prefixes on the per-agent files inside (formatTime() in orchestrator/index.ts
  // is already local). Canonical UTC lives in meta.json.startedAt.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}${pad(now.getMinutes())}`;
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
