import { generateText, stepCountIs } from 'ai';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, ProviderName, FallbackEvent, ToolCallLogEntry,
} from './types.js';
import { resolveModelForAgent } from './config.js';
import { createToolSet, type ToolSetOptions } from './tool-implementations.js';

// --- Provider String ID ---
// AI SDK v6 accepts string model IDs like "xai:grok-3" which are resolved
// via the globally registered providers from the @ai-sdk/* packages.

export function toModelId(provider: ProviderName, modelName: string): string {
  switch (provider) {
    case 'xai': return `xai:${modelName}`;
    case 'google': return `google:${modelName}`;
    case 'anthropic': return `anthropic:${modelName}`;
  }
}

// --- Error Classification ---

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes('429') || err.message.toLowerCase().includes('rate limit')
  );
}

function isAuthError(err: unknown): boolean {
  return err instanceof Error && (
    err.message.includes('401') || err.message.includes('403') ||
    err.message.toLowerCase().includes('unauthorized') || err.message.toLowerCase().includes('forbidden')
  );
}

function isServerError(err: unknown): boolean {
  return err instanceof Error && /5\d{2}/.test(err.message);
}

// --- Runner ---

export async function runAgent(
  agent: AgentDefinition,
  delegationPrompt: string,
  config: OrchestrationConfig,
  status: AgentRunStatus,
  onStatusChange: (status: AgentRunStatus) => void,
  onFallback: (event: FallbackEvent) => void,
): Promise<AgentRunResult> {
  const toolCallLog: ToolCallLogEntry[] = [];
  const toolOpts: ToolSetOptions = {
    repoRoot: config.repoPath,
    qaDataRoot: config.qaDataRoot,
    sessionLogDir: config.sessionLogDir,
    redactSecretsEnabled: config.modelsConfig.redactSecrets,
    toolCallLog,
  };
  const tools = createToolSet(agent, toolOpts);

  // Build fallback chain
  const { provider: preferredProvider, model: preferredModel } =
    resolveModelForAgent(agent.name, agent.tier, config.modelsConfig, config.providerOverride);

  const fallbackChain = [
    { provider: preferredProvider, model: preferredModel },
    ...config.modelsConfig.fallbackChain
      .filter(p => p !== preferredProvider && config.modelsConfig.providers[p]?.enabled)
      .map(p => ({
        provider: p,
        model: config.modelsConfig.tiers[agent.tier][p],
      })),
  ];

  let lastError: Error | null = null;

  for (const { provider, model: modelName } of fallbackChain) {
    status.provider = provider;
    status.model = modelName;
    status.status = status.retryCount > 0 ? 'retrying' : 'running';
    onStatusChange(status);

    try {
      const modelId = toModelId(provider, modelName);

      const result = await generateText({
        model: modelId,
        system: agent.systemPrompt,
        prompt: delegationPrompt,
        tools,
        stopWhen: stepCountIs(50),
        temperature: 0.1,
        onStepFinish: (event) => {
          if (event.usage) {
            status.tokenUsage.input += event.usage.inputTokens ?? 0;
            status.tokenUsage.output += event.usage.outputTokens ?? 0;
          }
          status.toolCallCount += (event.toolCalls?.length ?? 0);
          onStatusChange(status);
        },
      });

      if (!result.text || result.text.trim().length === 0) {
        throw new Error('Empty response from model');
      }

      return {
        text: result.text,
        usage: {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        },
        steps: result.steps.map(s => ({
          toolCalls: s.toolCalls.map(tc => ({ toolName: tc.toolName })),
          toolResults: s.toolResults.map(tr => ({ toolName: tr.toolName })),
        })),
        finishReason: result.finishReason,
        provider,
        model: modelName,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      status.retryCount++;

      const reason = isRateLimitError(err) ? 'rate-limit'
        : isAuthError(err) ? 'auth-error'
        : isServerError(err) ? 'server-error'
        : 'unknown';

      if (isAuthError(err)) {
        config.modelsConfig.providers[provider].enabled = false;
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
