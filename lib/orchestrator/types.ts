import type { QaFinding } from '../types.js';

// --- Provider & Model ---

export type ModelTier = 'heavy' | 'mid' | 'light';
export type ApiProviderName = 'xai' | 'google' | 'anthropic' | 'openai';
export type CliProviderName = 'claude-cli' | 'gemini-cli' | 'codex-cli' | 'openclaw';
export type ProviderName = ApiProviderName | CliProviderName;
export type ProviderType = 'api' | 'cli';
export type DataClassification = 'public' | 'internal' | 'restricted';

export interface ApiProviderConfig {
  type: 'api';
  enabled: boolean;
  apiKeyEnvVar: string;
}

export interface CliProviderConfig {
  type: 'cli';
  enabled: boolean;
  binary: string;
  detectedPath?: string;
  detectedVersion?: string;
}

export type ProviderConfig = ApiProviderConfig | CliProviderConfig;

export function isApiProvider(config: ProviderConfig): config is ApiProviderConfig {
  return config.type === 'api';
}

export function isCliProvider(config: ProviderConfig): config is CliProviderConfig {
  return config.type === 'cli';
}

export interface TierModels {
  xai: string;
  google: string;
  anthropic: string;
  openai: string;
}

// --- Adapter Capabilities ---

export interface AdapterCapabilities {
  systemPromptFile: boolean;
  addDir: boolean;
  agentDeployment: boolean;
  toolLogging: boolean;
  toolControl: boolean;
}

export interface AgentCliCompatibility {
  agentName: string;
  status: 'full' | 'adapted' | 'skipped';
  adaptations: string[];
  skipReason?: string;
}

export interface DetectionResult {
  installed: boolean;
  path?: string;
  version?: string;
}

// --- Token Budget ---

export interface TokenBudgetPresets {
  full: 'all' | string[];
  standard: string[];
  lite: string[];
}

export interface TokenPricing {
  xai: number;
  google: number;
  anthropic: number;
  openai: number;
}

export interface TokenBudgetConfig {
  presets: TokenBudgetPresets;
  pricing: TokenPricing;
  defaultCap: number;
}

export interface TokenBudget {
  cap: number;
  used: number;
  preset: 'full' | 'standard' | 'lite' | 'custom';
  agentSet: string[];
  forceAll?: boolean;
}

export interface TokenEstimate {
  agentCount: number;
  estimatedTokens: number;
  costByProvider: Record<string, number>;
  isCliProvider: boolean;
}

export interface AgentOverride {
  provider?: ProviderName;
  tier?: ModelTier;
  disableBash?: boolean;
  maxSteps?: number;
}

export interface ModelsYaml {
  defaultProvider: ProviderName;
  dataClassification: DataClassification;
  redactSecrets: boolean;
  approvedProviders?: ProviderName[];
  providers: Record<string, ProviderConfig>;
  fallbackChain: ProviderName[];
  tiers: Record<ModelTier, TierModels>;
  agentOverrides: Record<string, AgentOverride>;
  tokenBudget?: TokenBudgetConfig;
  coverageStrategy?: CoverageStrategy;
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

export type AgentStatus = 'queued' | 'awaiting-data' | 'running' | 'retrying' | 'complete' | 'failed';

export interface AgentRunStatus {
  agentName: string;
  status: AgentStatus;
  provider: ProviderName;
  model: string;
  startedAt: string | null;
  completedAt: string | null;
  lastHeartbeat: number | null;
  durationMs: number;
  findingCount: number;
  tokenUsage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  retryCount: number;
  fallbacksUsed: ProviderName[];
  toolCallCount: number;
  outputFilePath: string | null;
  outputFileExists: boolean;
  outputSizeBytes: number;
  coveragePercent: number | null;
  filesAssigned: number | null;
  error: string | null;
}

export interface AgentRunResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  steps: Array<{
    toolCalls: Array<{ toolName: string }>;
    toolResults: Array<{ toolName: string }>;
  }>;
  toolCallLog: ToolCallLogEntry[];
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
  mode: 'full' | 'review' | 'tier1' | 'tier2' | 'diff' | 'selective' | 'training' | 'docs';
  providerOverride?: ProviderName;
  modelsConfig: ModelsYaml;
  userPrompt: string;
  selectedAgents?: string[];
  moduleScope?: string;
  referenceDocPaths?: string[];
  claimsManifestPath?: string;
  composeRules: boolean;
  autoComplete: boolean;
  baseline: boolean;
  previousFindingsPath?: string;
  coverageStrategy?: CoverageStrategy;
  concurrency?: number;
}

// --- Credential Store ---

export type KeychainPlatform = 'macos' | 'windows' | 'linux' | 'unknown';

export interface CredentialResult {
  value: string;
  source: 'keychain' | 'env';
}

export interface TestProfileResult {
  profileName: string;
  source: 'keychain';
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

// --- Chunking ---

export interface FileChunk {
  id: number;
  files: string[];
  primaryDirectory: string;
}

export interface ChunkPlan {
  totalFiles: number;
  checkableFiles: number;
  chunkSize: number;
  chunks: FileChunk[];
  chunkedAgents: string[];
  unchunkedAgents: string[];
  excludedFiles: string[];
  strategy: CoverageStrategy;
}

// --- Coverage Strategy ---

export type CoverageStrategy = 'sweep' | 'balanced' | 'thorough' | 'exhaustive';

export interface CoverageStrategyConfig {
  chunkSize: number;
  maxChunkSize: number;
  maxChunksPerAgent: number | null;
  targetCoveragePercent: number;
  retryLowCoverageChunks: boolean;
  lowCoverageThreshold: number;
  maxRetriesPerChunk: number;
  retryBackoffMs: number;
  unchunkedScopeHint: boolean;
  requireApiProvider: boolean;
}

export interface CoverageEstimate {
  strategy: CoverageStrategy;
  totalFiles: number;
  checkableFiles: number;
  chunksPerAgent: number;
  totalChunkedInvocations: number;
  estimatedCoveragePercent: number;
  warnings: string[];
}

export interface CoverageReport {
  strategy: CoverageStrategy;
  targetPercent: number;
  actualPercent: number;
  totalFiles: number;
  filesExaminedCount: number;
  uncoveredFiles: string[];
  retriesExecuted: number;
  byAgent: Array<{ agent: string; filesExamined: number }>;
}

// --- Agent Output Envelope (inter-agent data exchange) ---

export interface AgentOutputEnvelope {
  agent: string;
  runId: string;
  completedAt: string;
  status: 'complete' | 'failed' | 'partial';
  data: Record<string, unknown>;
  findingSummary: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
  };
}

// --- Testability Pre-Flight ---

export interface LanguageProfile {
  lang: string;
  fileCount: number;
  lineCount: number;
  percentage: number;
}

export interface RepoProfile {
  languages: LanguageProfile[];
  frameworks: string[];
  buildTools: string[];
  packageManager: string | null;
  isMonorepo: boolean;
  moduleCount: number;
  totalSourceFiles: number;
}

export interface UncheckableReport {
  minifiedFiles: string[];
  generatedFiles: string[];
  binaryAssets: string[];
  vendoredCode: string[];
  largeFiles: string[];
  totalUncheckable: number;
  totalCheckable: number;
  checkabilityScore: number;
}

export interface TestInfraReport {
  hasTestFramework: boolean;
  testFramework: string | null;
  testFileCount: number;
  testCoverage: number | null;
  hasE2E: boolean;
  hasCICD: boolean;
  hasLinting: boolean;
  hasTypeChecking: boolean;
  testToCodeRatio: number;
}

export interface AgentSkipPrediction {
  agentName: string;
  effective: boolean;
  reason: string;
}

export interface TestingRecommendation {
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'test-infra' | 'coverage' | 'agent-config' | 'code-quality' | 'scope';
  title: string;
  description: string;
  action: string;
}

export interface TestabilityReport {
  repoProfile: RepoProfile;
  uncheckable: UncheckableReport;
  testInfra: TestInfraReport;
  agentPredictions: AgentSkipPrediction[];
  recommendations: TestingRecommendation[];
  scannedAt: string;
}

// --- Reference Document Verification ---

export type DocClaimType =
  | 'behavior'
  | 'architecture'
  | 'workflow'
  | 'security'
  | 'api-contract'
  | 'data-model'
  | 'config'
  | 'integration'
  | 'marketing';

export interface DocClaim {
  id: string;
  sourceDoc: string;
  sourceSection: string;
  claimType: DocClaimType;
  claim: string;
  verifiable: boolean;
  keywords: string[];
}

export type DocVerificationStatus =
  | 'confirmed'
  | 'stale'
  | 'contradicted'
  | 'unverifiable'
  | 'missing-from-code'
  | 'undocumented';
