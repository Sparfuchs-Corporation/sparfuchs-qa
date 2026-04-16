import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, ProviderName, FallbackEvent,
} from './types.js';
import { isCliProvider, isApiProvider } from './types.js';
import { resolveModelForAgent, resolveProviderConstraint } from './config.js';
import { getAdapter } from './adapters/index.js';

// --- Error Classification (used for fallback decisions) ---

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes('429') || err.message.toLowerCase().includes('rate limit')
  );
}

function isAuthError(err: unknown): boolean {
  // Only treat 401 (invalid credentials) as auth errors.
  // 403 can be rate-limit or permission — don't disable the provider for those.
  return err instanceof Error && (
    err.message.includes('401') ||
    err.message.toLowerCase().includes('unauthorized')
  );
}

function isServerError(err: unknown): boolean {
  return err instanceof Error && /5\d{2}/.test(err.message);
}

// --- Provider failure tracking ---
// Only disable a provider after multiple consecutive auth failures to avoid
// killing a provider for an entire run due to one transient error.
const AUTH_FAIL_THRESHOLD = 3;
const authFailCounts = new Map<ProviderName, number>();

// --- Runner ---

export async function runAgent(
  agent: AgentDefinition,
  delegationPrompt: string,
  config: OrchestrationConfig,
  status: AgentRunStatus,
  onStatusChange: (status: AgentRunStatus) => void,
  onFallback: (event: FallbackEvent) => void,
): Promise<AgentRunResult> {
  // Build fallback chain
  const { provider: preferredProvider, model: preferredModel } =
    resolveModelForAgent(agent.name, agent.tier, config.modelsConfig, config.providerOverride);

  const providerConstraint = resolveProviderConstraint(config.providerOverride as string | undefined);
  const fallbackChain = buildFallbackChain(
    preferredProvider, preferredModel, agent, config, providerConstraint,
  );

  let lastError: Error | null = null;

  for (const { provider, model: modelName } of fallbackChain) {
    status.provider = provider;
    status.model = modelName;
    status.status = status.retryCount > 0 ? 'retrying' : 'running';
    onStatusChange(status);

    try {
      const adapter = getAdapter(provider);

      // Check compatibility for CLI providers
      if (adapter.type === 'cli') {
        const compat = adapter.checkCompatibility(agent, config);
        if (compat.status === 'skipped') {
          throw new Error(`Agent ${agent.name} incompatible with ${provider}: ${compat.skipReason}`);
        }
      }

      const result = await adapter.run(
        agent, delegationPrompt, config, status, onStatusChange, onFallback,
      );

      return result;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      status.retryCount++;

      const reason = isRateLimitError(err) ? 'rate-limit'
        : isAuthError(err) ? 'auth-error'
        : isServerError(err) ? 'server-error'
        : 'unknown';

      if (isAuthError(err)) {
        const count = (authFailCounts.get(provider) ?? 0) + 1;
        authFailCounts.set(provider, count);
        if (count >= AUTH_FAIL_THRESHOLD) {
          const providerConfig = config.modelsConfig.providers[provider];
          if (providerConfig) providerConfig.enabled = false;
        }
      }

      const nextIdx = fallbackChain.findIndex(f => f.provider === provider) + 1;
      const nextProvider = nextIdx < fallbackChain.length ? fallbackChain[nextIdx].provider : provider;

      onFallback({
        agentName: agent.name,
        fromProvider: provider,
        toProvider: nextProvider,
        reason,
        timestamp: new Date().toISOString(),
      });

      status.fallbacksUsed.push(provider);
      continue;
    }
  }

  status.status = 'failed';
  status.error = lastError?.message ?? 'All providers exhausted';
  onStatusChange(status);
  throw new Error(`Agent ${agent.name} failed on all providers: ${lastError?.message}`);
}

// --- Helpers ---

const API_PROVIDER_NAMES = new Set(['xai', 'google', 'anthropic', 'openai']);

function buildFallbackChain(
  preferredProvider: ProviderName,
  preferredModel: string,
  agent: AgentDefinition,
  config: OrchestrationConfig,
  providerConstraint?: 'api' | 'cli' | undefined,
): Array<{ provider: ProviderName; model: string }> {
  const chain = [{ provider: preferredProvider, model: preferredModel }];

  for (const p of config.modelsConfig.fallbackChain) {
    if (p === preferredProvider) continue;
    const pConfig = config.modelsConfig.providers[p];
    if (!pConfig?.enabled) continue;

    if (isCliProvider(pConfig)) {
      if (providerConstraint === 'api') continue;
      chain.push({ provider: p, model: pConfig.binary });
    } else if (API_PROVIDER_NAMES.has(p)) {
      if (providerConstraint === 'cli') continue;
      chain.push({
        provider: p,
        model: config.modelsConfig.tiers[agent.tier][p as 'xai' | 'google' | 'anthropic'],
      });
    }
  }

  return chain;
}
