import * as fs from 'fs';
import * as path from 'path';

interface CanaryResult {
  id: string;
  projectId: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  hint: string;
  value: number;
  threshold: number;
  passed: boolean;
  trend: 'improving' | 'stable' | 'degrading';
  lastSeen: string;
  history: { date: string; value: number }[];
}

export default async function aiDecay(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const baselinePaths = [
    path.join(root, 'tests', 'ai-baselines'),
    path.join(root, 'tests', 'platform', 'ai-baselines'),
  ];

  const baselineExists = baselinePaths.some(p => fs.existsSync(p));

  return {
    id: 'ai-decay',
    projectId: 'sample-project',
    type: 'ai-quality',
    severity: 'info',
    hint: baselineExists
      ? 'AI baselines seed data found — decay testing available for Phase 2'
      : 'AI baselines not yet created — placeholder canary, always passes',
    value: 0,
    threshold: 0,
    passed: true,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
