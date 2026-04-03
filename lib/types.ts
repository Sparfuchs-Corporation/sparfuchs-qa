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
