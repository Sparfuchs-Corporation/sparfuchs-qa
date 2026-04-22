export interface CanaryResult {
  id: string;
  name: string;
  category: 'code-quality' | 'security' | 'performance' | 'i18n' | 'visual' | 'rbac';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  count: number;
  hint: string;
  details?: string;
  timestamp: string;
}

export interface QaFlakyTest {
  testFile: string;
  testName: string;
  status: 'candidate' | 'confirmed' | 'fixed';
  flipCount: number;
  lastFlipAt: any;
  lastPassAt: any;
  lastFailAt: any;
  quarantined: boolean;
  createdAt: any;
}

export interface QaSbomEntry {
  type: 'library';
  name: string;
  version: string;
  purl: string;
  scope: 'required' | 'optional';
}

export interface GeneratedManifestEntry {
  file: string;
  agent: string;
  timestamp: string;
  targetCommit: string;
}

export interface QaCanaryRun {
  runId: string;
  projectId: string;
  branch?: string;
  commitSha?: string;
  environment: 'local' | 'cloud-build' | 'nightly';
  timestamp: any;
  results: CanaryResult[];
  summary: { total: number; passed: number; failed: number; bySeverity: { LOW: number; MEDIUM: number; HIGH: number } };
  source: 'local' | 'cloud-build' | 'nightly';
  forecastNotes?: string;
}

// --- Finding persistence types ---

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export type FindingLifecycle =
  | 'open'
  | 'recurring'
  | 'remediated'
  | 'verified'
  | 'closed'
  | 'wont-fix'
  | 'stale';

export interface QaFinding {
  id: string;
  agent: string;
  severity: FindingSeverity;
  category: string;
  rule: string;
  file: string;
  line?: number;
  title: string;
  description: string;
  fix: string;
  timestamp: string;
}

export interface FindingRegistryEntry {
  id: string;
  lifecycle: FindingLifecycle;
  firstSeenRunId: string;
  firstSeenAt: string;
  lastSeenRunId: string;
  lastSeenAt: string;
  remediatedAt?: string;
  verifiedAt?: string;
  closedAt?: string;
  occurrenceCount: number;
  finding: QaFinding;
}

// --- Run metadata ---

export interface QaRunMeta {
  runId: string;
  projectSlug: string;
  repoPath: string;
  branch?: string;
  commitSha?: string;
  mode: 'full' | 'tier1' | 'tier2' | 'diff';
  startedAt: string;
  completedAt?: string;
  verdict: 'PASS' | 'NEEDS CHANGES' | 'BLOCKED';
  agents: string[];
  stats: {
    total: number;
    bySeverity: Record<FindingSeverity, number>;
    new: number;
    recurring: number;
    remediated: number;
  };
  previousRunId?: string;
}

export interface RunDelta {
  runId: string;
  previousRunId: string;
  newFindings: string[];
  recurringFindings: string[];
  remediatedFindings: string[];
  closureRate: number;
  regressionRate: number;
}

// --- Evolution ---

export interface EvolutionPattern {
  rule: string;
  category: string;
  totalOccurrences: number;
  runsAppeared: number;
  averageSeverity: FindingSeverity;
  fixRate: number;
  trend: 'improving' | 'stable' | 'worsening';
  lastSeen: string;
}

export interface ProjectConfig {
  projectSlug: string;
  displayName: string;
  repoPath: string;
  firstReviewedAt: string;
  lastReviewedAt: string;
  totalRuns: number;
}

// --- File audit cache (incremental auditing) ---

export interface FileAuditEntry {
  lastAuditedRunId: string;
  lastAuditedCommitSha: string;
  contentHash: string;
  findingIds: string[];
  agents: string[];
}

export interface FileAuditCache {
  schemaVersion: 1;
  lastFullAudit: {
    runId: string;
    commitSha: string;
    timestamp: string;
  };
  files: Record<string, FileAuditEntry>;
}

// --- GCP QA Service ingest contract ---

export interface QaIngestPayload {
  version: 1;
  projectSlug: string;
  run: QaRunMeta;
  findings: QaFinding[];
  delta: RunDelta | null;
  evolution: EvolutionPattern[] | null;
}
