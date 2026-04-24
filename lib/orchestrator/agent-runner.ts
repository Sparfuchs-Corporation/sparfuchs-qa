import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, ProviderName, FallbackEvent,
} from './types.js';
import { isCliProvider, isApiProvider } from './types.js';
import { resolveModelForAgent, resolveProviderConstraint } from './config.js';
import { getAdapter } from './adapters/index.js';
import { extractToolCallsFromText } from './adapters/text-coverage-extractor.js';

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

/**
 * Hard-quota exhaustion — distinct from a transient 429. Quotas reset in
 * hours, not seconds, so retries on the same provider are pointless and
 * every future agent should skip this provider for the rest of the run.
 *
 * Matches Gemini CLI's `TerminalQuotaError`, plus prose variants from
 * other providers ("you have exhausted", "quota exceeded", etc.).
 */
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes('TerminalQuotaError') ||
    msg.includes('exhausted your capacity') ||
    /quota\s+(exceeded|exhausted|will\s+reset)/i.test(msg) ||
    /RESOURCE_EXHAUSTED/i.test(msg)
  );
}

// --- Provider failure tracking ---
// Only disable a provider after multiple consecutive auth failures to avoid
// killing a provider for an entire run due to one transient error.
const AUTH_FAIL_THRESHOLD = 3;
const authFailCounts = new Map<ProviderName, number>();

/**
 * Providers that have hit a hard daily quota and will not recover within
 * this run. Populated on the first quota error and consulted on every
 * subsequent fallback-chain walk so we don't waste another 1-2 minutes
 * per agent hitting the same wall. Scoped to the module (shared across
 * all agents in the current process).
 */
const quotaExhaustedProviders = new Set<ProviderName>();

/** Sleep that resolves early if the abort signal fires. */
export function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// Retry config for transient failures
// Rate limits are per-minute, so backoff must be long enough for the window to reset.
const MAX_RETRIES_PER_PROVIDER = 3;
const RATE_LIMIT_RETRY_MS = 30_000; // 30s base for 429s (per-minute limit needs 30-60s)
const SERVER_ERROR_RETRY_MS = 5_000; // 5s base for 5xx (transient, shorter backoff)

// Per-agent hard timeout. Without this, a single hung adapter.run() freezes
// the whole orchestrator (the dispatchJob promise never resolves, the stage's
// Promise.allSettled never returns, downstream stages never dispatch). Worst
// on single-agent / small runs where there's no other progress to watch.
//
// Defaults by tier; override globally via QA_AGENT_TIMEOUT_MS or per-tier via
// QA_AGENT_TIMEOUT_{LIGHT,MID,HEAVY}_MS.
const DEFAULT_AGENT_TIMEOUTS_MS: Record<string, number> = {
  light: 8 * 60_000,   // 8 min  — small focused reviewers
  mid:   15 * 60_000,  // 15 min — standard static analysis
  heavy: 25 * 60_000,  // 25 min — chunked / multi-pass agents
};

function resolveAgentTimeoutMs(tier: string): number {
  const flat = Number(process.env.QA_AGENT_TIMEOUT_MS);
  if (Number.isFinite(flat) && flat > 0) return flat;
  const perTier = Number(process.env[`QA_AGENT_TIMEOUT_${tier.toUpperCase()}_MS`]);
  if (Number.isFinite(perTier) && perTier > 0) return perTier;
  return DEFAULT_AGENT_TIMEOUTS_MS[tier] ?? DEFAULT_AGENT_TIMEOUTS_MS.mid;
}

/**
 * Run an adapter invocation under a hard timeout. If the timeout fires, the
 * returned promise rejects with an Error that the caller treats like any
 * other adapter failure (fall back, mark status failed, move on). We cannot
 * force the underlying child process or HTTP call to stop from here, but we
 * CAN stop waiting for it and let the next agent / stage proceed.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${Math.round(timeoutMs / 1000)}s hard timeout`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- Universal coverage fallback ---
//
// When an adapter returns empty structured telemetry (toolCallLog.length=0)
// but the agent produced substantial prose output, regex-extract file paths
// from the text so the coverage babysitter still credits the agent. This
// catches:
//   - pre-e6e21ed Gemini streams where tool_use events weren't parsed
//   - Codex outputs that use shell commands we don't yet recognize
//   - Openclaw (no structured output at all)
//   - Any future provider whose event schema drifts
//
// Below this threshold we assume the agent genuinely did no file-touching
// work (e.g., refused, returned an error message) and leave the log empty.
const EMPTY_TELEMETRY_TEXT_THRESHOLD = 5_000;

function applyUniversalCoverageFallback(
  result: AgentRunResult,
  provider: ProviderName,
  config: OrchestrationConfig,
): AgentRunResult {
  if (result.toolCallLog.length > 0) return result;
  if (result.text.length < EMPTY_TELEMETRY_TEXT_THRESHOLD) return result;
  if (!config.sourceFiles || config.sourceFiles.size === 0) return result;

  const recovered = extractToolCallsFromText(result.text, config.repoPath, config.sourceFiles);
  if (recovered.length === 0) return result;

  process.stderr.write(
    `[${provider}] structured telemetry empty (${result.text.length} bytes text); ` +
    `recovered ${recovered.length} file references from text\n`,
  );
  return { ...result, toolCallLog: recovered };
}

// --- Runner ---

export async function runAgent(
  agent: AgentDefinition,
  delegationPrompt: string,
  config: OrchestrationConfig,
  status: AgentRunStatus,
  onStatusChange: (status: AgentRunStatus) => void,
  onFallback: (event: FallbackEvent) => void,
  abortSignal?: AbortSignal,
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
    // Skip providers that already hit a daily quota in this run — don't
    // waste the spawn / API call (and the user's patience) on a wall that
    // won't reset for hours.
    if (quotaExhaustedProviders.has(provider)) {
      lastError = new Error(`Provider ${provider} is quota-exhausted for this run`);
      status.fallbacksUsed.push(provider);
      continue;
    }

    status.provider = provider;
    status.model = modelName;

    const adapter = getAdapter(provider);

    // Check compatibility for CLI providers
    if (adapter.type === 'cli') {
      const compat = adapter.checkCompatibility(agent, config);
      if (compat.status === 'skipped') {
        lastError = new Error(`Agent ${agent.name} incompatible with ${provider}: ${compat.skipReason}`);
        status.fallbacksUsed.push(provider);
        continue;
      }
    }

    // Retry loop within the same provider for transient failures
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_PROVIDER; attempt++) {
      if (abortSignal?.aborted) break;
      status.status = attempt > 0 ? 'retrying' : (status.retryCount > 0 ? 'retrying' : 'running');
      onStatusChange(status);

      try {
        const timeoutMs = resolveAgentTimeoutMs(agent.tier);
        const result = await withTimeout(
          adapter.run(
            agent, delegationPrompt, config, status, onStatusChange, onFallback,
          ),
          timeoutMs,
          `${agent.name} (${provider}/${modelName})`,
        );
        return applyUniversalCoverageFallback(result, provider, config);
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        const isQuota = isQuotaError(err);
        const isRateLimit = isRateLimitError(err);
        const isServer = isServerError(err);

        // Quota exhausted — do NOT retry (resets in hours) and mark the
        // whole provider off-limits for the rest of the run so future
        // agents skip it immediately in the outer fallback walk.
        if (isQuota) {
          quotaExhaustedProviders.add(provider);
          process.stderr.write(
            `\n[QUOTA] ${provider} daily quota exhausted — falling back to next provider in chain for remaining agents\n`,
          );
          // fall through to the "move to next provider" block below
        }

        if (!isQuota && (isRateLimit || isServer) && attempt < MAX_RETRIES_PER_PROVIDER) {
          // Rate limits need long backoff (per-minute window): 30s, 60s, 120s
          // Server errors need shorter backoff: 5s, 10s, 20s
          const baseMs = isRateLimit ? RATE_LIMIT_RETRY_MS : SERVER_ERROR_RETRY_MS;
          const delay = baseMs * Math.pow(2, attempt);
          // Sleep is interruptible via abort signal (quit requested)
          await interruptibleSleep(delay, abortSignal);
          if (abortSignal?.aborted) break;
          continue; // retry same provider
        }

        // Non-retryable or retries exhausted — log and move to next provider
        status.retryCount++;

        const reason = isQuota ? 'quota-exhausted'
          : isRateLimit ? 'rate-limit'
          : isAuthError(err) ? 'auth-error'
          : isServer ? 'server-error'
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
        break; // move to next provider in chain
      }
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

  // Specific provider selected → zero fallback, that provider only
  const override = config.providerOverride as string | undefined;
  if (override && override !== 'api' && override !== 'cli') {
    return chain;
  }

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
