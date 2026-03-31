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

export default async function bddSmoke(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const playwrightConfig = path.join(root, 'playwright.config.ts');
  const configExists = fs.existsSync(playwrightConfig);

  let bddTestCount = 0;
  const featuresDir = path.join(root, 'tests', 'features');
  if (fs.existsSync(featuresDir)) {
    try {
      const files = fs.readdirSync(featuresDir, { recursive: true }) as string[];
      bddTestCount = files.filter(f => String(f).endsWith('.feature')).length;
    } catch {
      bddTestCount = 0;
    }
  }

  const passed = configExists;

  return {
    id: 'bdd-smoke',
    projectId: 'the-forge',
    type: 'test-infrastructure',
    severity: configExists ? 'info' : 'medium',
    hint: configExists
      ? `Playwright config found. ${bddTestCount} BDD feature file(s) detected.`
      : 'playwright.config.ts not found — BDD test infrastructure missing',
    value: configExists ? 1 : 0,
    threshold: 1,
    passed,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
