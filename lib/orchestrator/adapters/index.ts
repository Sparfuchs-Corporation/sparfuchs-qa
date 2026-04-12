import { execFileSync } from 'node:child_process';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, ProviderName, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, ProviderConfig,
  ModelsYaml, FallbackEvent,
} from '../types.js';
import { isCliProvider } from '../types.js';

// --- Adapter Interface ---

export interface AgentAdapter {
  readonly name: ProviderName;
  readonly type: 'api' | 'cli';
  readonly binary?: string;

  detect(): DetectionResult;
  getCapabilities(): AdapterCapabilities;
  checkCompatibility(agent: AgentDefinition, config: OrchestrationConfig): AgentCliCompatibility;

  run(
    agent: AgentDefinition,
    delegationPrompt: string,
    config: OrchestrationConfig,
    status: AgentRunStatus,
    onStatusChange: (s: AgentRunStatus) => void,
    onFallback: (e: FallbackEvent) => void,
  ): Promise<AgentRunResult>;
}

// --- Registry ---

const registry = new Map<string, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  registry.set(adapter.name, adapter);
}

export function getAdapter(name: ProviderName): AgentAdapter {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(
      `No adapter registered for provider "${name}". ` +
      `Available: ${[...registry.keys()].join(', ')}`
    );
  }
  return adapter;
}

export function getAllAdapters(): AgentAdapter[] {
  return [...registry.values()];
}

export function getRegisteredNames(): string[] {
  return [...registry.keys()];
}

// --- CLI Detection ---

export function detectCli(binary: string): DetectionResult {
  try {
    const path = execFileSync('which', [binary], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    let version: string | undefined;
    try {
      const versionOutput = execFileSync(binary, ['--version'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      // Extract first line, trim to reasonable length
      version = versionOutput.split('\n')[0].slice(0, 80);
    } catch {
      // --version not supported or errored
    }

    return { installed: true, path, version };
  } catch {
    return { installed: false };
  }
}

/**
 * Auto-detect CLI providers in config and update their enabled state.
 * Returns a map of provider name → detection result.
 */
export function resolveCliProviders(config: ModelsYaml): Map<string, DetectionResult> {
  const results = new Map<string, DetectionResult>();

  for (const [name, provider] of Object.entries(config.providers)) {
    if (!isCliProvider(provider)) continue;

    const result = detectCli(provider.binary);
    results.set(name, result);

    if (result.installed) {
      provider.enabled = true;
      provider.detectedPath = result.path;
      provider.detectedVersion = result.version;
    } else {
      provider.enabled = false;
    }
  }

  return results;
}

// --- Capability Report ---

export function printCapabilityReport(
  providerName: ProviderName,
  agents: AgentDefinition[],
  config: OrchestrationConfig,
): void {
  const adapter = getAdapter(providerName);
  const caps = adapter.getCapabilities();
  const providerConfig = config.modelsConfig.providers[providerName];

  const versionStr = isCliProvider(providerConfig) && providerConfig.detectedVersion
    ? ` (${providerConfig.detectedVersion})`
    : '';

  process.stderr.write(`\n=== Provider Capability Report ===\n`);
  process.stderr.write(`Engine: ${providerName}${versionStr}\n\n`);

  // Supported capabilities
  const capLabels: [keyof AdapterCapabilities, string][] = [
    ['systemPromptFile', 'System prompt file injection'],
    ['addDir', 'Mount external directories (--add-dir)'],
    ['agentDeployment', '@agent-name deployment'],
    ['toolLogging', 'Tool call visibility/logging'],
    ['toolControl', 'Per-agent tool restrictions'],
  ];

  const supported = capLabels.filter(([key]) => caps[key]);
  const unsupported = capLabels.filter(([key]) => !caps[key]);

  if (supported.length > 0) {
    process.stderr.write('Supported:\n');
    for (const [, label] of supported) {
      process.stderr.write(`  [x] ${label}\n`);
    }
  }
  if (unsupported.length > 0) {
    process.stderr.write('\nNot supported:\n');
    for (const [, label] of unsupported) {
      process.stderr.write(`  [ ] ${label}\n`);
    }
  }

  // Per-agent compatibility
  const skipped: AgentCliCompatibility[] = [];
  const adapted: AgentCliCompatibility[] = [];

  for (const agent of agents) {
    const compat = adapter.checkCompatibility(agent, config);
    if (compat.status === 'skipped') skipped.push(compat);
    else if (compat.status === 'adapted') adapted.push(compat);
  }

  if (skipped.length > 0) {
    process.stderr.write(`\nAgents skipped (${skipped.length}):\n`);
    for (const s of skipped) {
      process.stderr.write(`  - ${s.agentName}: ${s.skipReason}\n`);
    }
  }
  if (adapted.length > 0) {
    process.stderr.write(`\nAgents adapted (${adapted.length}): system prompts inlined\n`);
  }

  process.stderr.write('\n');
}
