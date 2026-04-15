import * as readline from 'node:readline';
import type {
  AgentDefinition, ModelsYaml, TokenBudget, TokenEstimate,
  TokenBudgetConfig, ProviderName, CoverageStrategy,
} from './types.js';
import { isApiProvider, isCliProvider } from './types.js';
import { getStrategyConfig } from './coverage-babysitter.js';

// Average tokens per agent by tier (empirical estimates from QA runs)
export const AVG_TOKENS_PER_AGENT: Record<string, number> = {
  heavy: 80_000,
  mid: 40_000,
  light: 15_000,
};

export function estimateTokenCost(
  agents: AgentDefinition[],
  config: ModelsYaml,
  primaryProvider: ProviderName,
): TokenEstimate {
  const totalTokens = agents.reduce(
    (sum, agent) => sum + (AVG_TOKENS_PER_AGENT[agent.tier] ?? 40_000),
    0,
  );

  const costByProvider: Record<string, number> = {};
  const pricing = config.tokenBudget?.pricing;
  if (pricing) {
    for (const [name, pricePerMillion] of Object.entries(pricing)) {
      costByProvider[name] = (totalTokens / 1_000_000) * pricePerMillion;
    }
  }

  const primaryConfig = config.providers[primaryProvider];
  const isCli = primaryConfig ? isCliProvider(primaryConfig) : false;

  return {
    agentCount: agents.length,
    estimatedTokens: totalTokens,
    costByProvider,
    isCliProvider: isCli,
  };
}

export async function printBudgetPrompt(
  estimate: TokenEstimate,
  agents: AgentDefinition[],
  config: ModelsYaml,
): Promise<TokenBudget> {
  const budgetConfig = config.tokenBudget;

  process.stderr.write('\n=== Token Budget Estimate ===\n');
  process.stderr.write(`Agents: ${estimate.agentCount} | Estimated: ~${formatTokens(estimate.estimatedTokens)}\n\n`);

  if (estimate.isCliProvider) {
    process.stderr.write('Note: CLI providers manage billing through their own accounts.\n');
    process.stderr.write('Token estimates shown for reference only.\n\n');
  } else {
    process.stderr.write('Estimated API costs:\n');
    for (const [provider, cost] of Object.entries(estimate.costByProvider)) {
      process.stderr.write(`  ${provider}: ~$${cost.toFixed(2)}\n`);
    }
    process.stderr.write('\n');
  }

  if (!budgetConfig) {
    // No budget config — run all agents with no limit
    return {
      cap: 0,
      used: 0,
      preset: 'full',
      agentSet: agents.map(a => a.name),
    };
  }

  // Show presets
  const standardCount = budgetConfig.presets.standard.length;
  const liteCount = budgetConfig.presets.lite.length;

  process.stderr.write('Select budget mode:\n');
  process.stderr.write(`  1. Full audit (${estimate.agentCount} agents)\n`);
  process.stderr.write(`  2. Standard (${standardCount} core agents)\n`);
  process.stderr.write(`  3. Lite (${liteCount} critical agents)\n`);
  process.stderr.write(`  4. Custom token cap\n`);
  process.stderr.write(`  5. No limit (default)\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => {
    rl.question('\nChoice [1-5, default=5]: ', resolve);
  });

  const choice = parseInt(answer, 10) || 5;

  let budget: TokenBudget;

  switch (choice) {
    case 1:
      budget = {
        cap: 0,
        used: 0,
        preset: 'full',
        agentSet: agents.map(a => a.name),
      };
      break;

    case 2:
      budget = {
        cap: 0,
        used: 0,
        preset: 'standard',
        agentSet: budgetConfig.presets.standard,
      };
      break;

    case 3:
      budget = {
        cap: 0,
        used: 0,
        preset: 'lite',
        agentSet: budgetConfig.presets.lite,
      };
      break;

    case 4: {
      const capAnswer = await new Promise<string>(resolve => {
        rl.question('Token cap (e.g., 500000): ', resolve);
      });
      const cap = parseInt(capAnswer, 10);
      if (isNaN(cap) || cap <= 0) {
        process.stderr.write('Invalid cap — running with no limit.\n');
        budget = { cap: 0, used: 0, preset: 'custom', agentSet: agents.map(a => a.name) };
      } else {
        budget = { cap, used: 0, preset: 'custom', agentSet: agents.map(a => a.name) };
      }
      break;
    }

    default:
      budget = {
        cap: budgetConfig.defaultCap,
        used: 0,
        preset: 'full',
        agentSet: agents.map(a => a.name),
      };
  }

  rl.close();

  const presetLabel = `${budget.preset}${budget.cap > 0 ? ` (cap: ${formatTokens(budget.cap)})` : ''}`;
  process.stderr.write(`\nBudget mode: ${presetLabel} | ${budget.agentSet.length} agents\n`);

  return budget;
}

export function checkBudget(
  budget: TokenBudget,
  additionalTokens: number,
): { ok: boolean; warning?: string } {
  if (budget.cap === 0) return { ok: true };

  const projected = budget.used + additionalTokens;
  const pct = Math.round((projected / budget.cap) * 100);

  if (projected > budget.cap) {
    return {
      ok: false,
      warning: `Token budget exceeded: ${formatTokens(projected)} / ${formatTokens(budget.cap)} (${pct}%)`,
    };
  }

  if (pct > 80) {
    return {
      ok: true,
      warning: `Token budget at ${pct}%: ${formatTokens(projected)} / ${formatTokens(budget.cap)}`,
    };
  }

  return { ok: true };
}

export function updateBudgetUsage(budget: TokenBudget, tokensUsed: number): void {
  budget.used += tokensUsed;
}

export function isAgentInBudget(agentName: string, budget: TokenBudget): boolean {
  return budget.agentSet.includes(agentName);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

// --- Coverage Strategy Selection ---

const STRATEGY_LABELS: Array<{ key: CoverageStrategy; label: string }> = [
  { key: 'sweep', label: 'Sweep     (~40% coverage, fast)' },
  { key: 'balanced', label: 'Balanced  (~65% coverage)' },
  { key: 'thorough', label: 'Thorough  (~85% coverage)' },
  { key: 'exhaustive', label: 'Exhaustive (~95% coverage)' },
];

export async function selectCoverageStrategy(
  defaultStrategy?: CoverageStrategy,
): Promise<CoverageStrategy> {
  const defaultIdx = defaultStrategy
    ? STRATEGY_LABELS.findIndex(s => s.key === defaultStrategy) + 1
    : 2; // balanced

  process.stderr.write('\nCoverage depth:\n');
  for (let i = 0; i < STRATEGY_LABELS.length; i++) {
    const isDefault = i + 1 === defaultIdx;
    process.stderr.write(`  ${i + 1}. ${STRATEGY_LABELS[i].label}${isDefault ? '  [default]' : ''}\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>(resolve => {
    rl.question(`\nChoice [1-4, default=${defaultIdx}]: `, resolve);
  });
  rl.close();

  const choice = parseInt(answer, 10);
  if (choice >= 1 && choice <= STRATEGY_LABELS.length) {
    return STRATEGY_LABELS[choice - 1].key;
  }
  return STRATEGY_LABELS[defaultIdx - 1].key;
}
