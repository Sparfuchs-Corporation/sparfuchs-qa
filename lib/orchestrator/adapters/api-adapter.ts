import { generateText, stepCountIs } from 'ai';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, ApiProviderName, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent, ToolCallLogEntry,
} from '../types.js';
import { resolveApiKey } from '../credential-store.js';
import { createToolSet, type ToolSetOptions } from '../tool-implementations.js';
import type { AgentAdapter } from './index.js';
import type { ProviderRegistry } from '../provider-registry.js';

const DEFAULT_MAX_STEPS = 50;

const ENV_MAP: Record<string, string> = {
  xai: 'XAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export class ApiAdapter implements AgentAdapter {
  readonly type = 'api' as const;
  readonly name: ApiProviderName;
  private readonly registry: ProviderRegistry | null;

  constructor(name: ApiProviderName, registry?: ProviderRegistry) {
    this.name = name;
    this.registry = registry ?? null;
  }

  detect(): DetectionResult {
    const envVar = ENV_MAP[this.name] ?? `${this.name.toUpperCase()}_API_KEY`;
    const key = resolveApiKey(envVar, envVar);
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
    _onFallback: (e: FallbackEvent) => void,
  ): Promise<AgentRunResult> {
    if (!this.registry) {
      throw new Error(`ApiAdapter "${this.name}": no provider registry — cannot create model`);
    }

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

    // Create model via proxy — keys never enter this process
    const model = this.registry.createModel(this.name, status.model, status.agentName);

    const result = await generateText({
      model,
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
      status.error = `Context window limit reached (finishReason=length). Output may be truncated.`;
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
      toolCallLog,
      finishReason: result.finishReason,
      provider: this.name,
      model: status.model,
    };
  }
}
