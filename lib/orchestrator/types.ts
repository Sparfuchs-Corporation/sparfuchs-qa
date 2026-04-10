import type { QaFinding } from '../types.js';

// --- Provider & Model ---

export type ModelTier = 'heavy' | 'mid' | 'light';
export type ProviderName = 'xai' | 'google' | 'anthropic';
export type DataClassification = 'public' | 'internal' | 'restricted';

export interface ProviderConfig {
  enabled: boolean;
  apiKeyEnvVar: string;
}

export interface TierModels {
  xai: string;
  google: string;
  anthropic: string;
}

export interface AgentOverride {
  provider?: ProviderName;
  tier?: ModelTier;
  disableBash?: boolean;
}

export interface ModelsYaml {
  defaultProvider: ProviderName;
  dataClassification: DataClassification;
  redactSecrets: boolean;
  approvedProviders?: ProviderName[];
  providers: Record<ProviderName, ProviderConfig>;
  fallbackChain: ProviderName[];
  tiers: Record<ModelTier, TierModels>;
  agentOverrides: Record<string, AgentOverride>;
}

// --- Agent ---

export interface AgentDefinition {
  name: string;
  description: string;
  tier: ModelTier;
  tools: string[];
  systemPrompt: string;
  disableBash: boolean;
  sourcePath: string;
  contentHash: string;
}

// --- Run Status ---

export interface AgentRunStatus {
  agentName: string;
  status: 'queued' | 'running' | 'retrying' | 'complete' | 'failed';
  provider: ProviderName;
  model: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  findingCount: number;
  tokenUsage: { input: number; output: number };
  retryCount: number;
  fallbacksUsed: ProviderName[];
  toolCallCount: number;
  outputFilePath: string | null;
  outputFileExists: boolean;
  outputSizeBytes: number;
  error: string | null;
}

export interface AgentRunResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  steps: Array<{
    toolCalls: Array<{ toolName: string }>;
    toolResults: Array<{ toolName: string }>;
  }>;
  finishReason: string;
  provider: ProviderName;
  model: string;
}

// --- Quality ---

export type QualityIssueType =
  | 'concatenation'
  | 'hallucination'
  | 'give-up'
  | 'missed-files'
  | 'batched-findings';

export interface QualityIssue {
  type: QualityIssueType;
  severity: 'error' | 'warning';
  description: string;
  evidence: string;
}

export interface QualityAuditResult {
  agentName: string;
  issues: QualityIssue[];
  score: number;
  passed: boolean;
  auditProvider?: ProviderName;
}

// --- Orchestration Config ---

export interface OrchestrationConfig {
  repoPath: string;
  sparfuchsRoot: string;
  reportsDir: string;
  qaDataRoot: string;
  sessionLogDir: string;
  runId: string;
  projectSlug: string;
  mode: 'full' | 'tier1' | 'tier2' | 'diff';
  providerOverride?: ProviderName;
  modelsConfig: ModelsYaml;
  userPrompt: string;
}

// --- Credential Store ---

export type KeychainPlatform = 'macos' | 'windows' | 'linux' | 'unknown';

export interface CredentialResult {
  value: string;
  source: 'keychain' | 'env';
}

// --- Observability ---

export interface FallbackEvent {
  agentName: string;
  fromProvider: ProviderName;
  toProvider: ProviderName;
  reason: string;
  timestamp: string;
}

export interface ToolCallLogEntry {
  tool: string;
  args: Record<string, unknown>;
  timestamp: string;
}
