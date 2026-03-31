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
