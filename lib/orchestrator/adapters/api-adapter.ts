import { generateText, stepCountIs } from 'ai';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, ApiProviderName, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent, ToolCallLogEntry,
} from '../types.js';
import { resolveApiKey } from '../credential-store.js';
import { createToolSet, type ToolSetOptions } from '../tool-implementations.js';
import type { AgentAdapter } from './index.js';

const DEFAULT_MAX_STEPS = 50;

export function toModelId(provider: ApiProviderName, modelName: string): string {
  return `${provider}:${modelName}`;
}

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

export class ApiAdapter implements AgentAdapter {
  readonly type = 'api' as const;
  readonly name: ApiProviderName;

  constructor(name: ApiProviderName) {
    this.name = name;
  }

  detect(): DetectionResult {
    const providerConfig = { apiKeyEnvVar: this.getEnvVar() };
    const key = resolveApiKey(providerConfig.apiKeyEnvVar, providerConfig.apiKeyEnvVar);
    return { installed: key !== null, path: key ? '(API key available)' : undefined };
  }

  getCapabilities(): AdapterCapabilities {
    return {
      systemPromptFile: true,
      addDir: true,
      agentDeployment: true,
      toolLogging: true,
      toolControl: true,
    };
  }

  checkCompatibility(agent: AgentDefinition): AgentCliCompatibility {
    return { agentName: agent.name, status: 'full', adaptations: [] };
  }

  async run(
    agent: AgentDefinition,
    delegationPrompt: string,
    config: OrchestrationConfig,
    status: AgentRunStatus,
    onStatusChange: (s: AgentRunStatus) => void,
    onFallback: (e: FallbackEvent) => void,
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

    const agentOverride = config.modelsConfig.agentOverrides[agent.name];
    const maxSteps = agentOverride?.maxSteps ?? DEFAULT_MAX_STEPS;
    const modelId = toModelId(this.name, status.model);

    const result = await generateText({
      model: modelId,
      system: agent.systemPrompt,
      prompt: delegationPrompt,
      tools,
      stopWhen: stepCountIs(maxSteps),
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

    if (result.finishReason === 'length') {
      process.stderr.write(
        `  WARNING: ${agent.name} hit context window limit (finishReason=length). Output may be truncated.\n`,
      );
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
      provider: this.name,
      model: status.model,
    };
  }

  private getEnvVar(): string {
    const ENV_MAP: Record<string, string> = {
      xai: 'XAI_API_KEY',
      google: 'GOOGLE_GENERATIVE_AI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
    };
    return ENV_MAP[this.name] ?? `${this.name.toUpperCase()}_API_KEY`;
  }
}
