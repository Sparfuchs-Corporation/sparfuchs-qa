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

const EXPECTED_KEYS = ['projectId', 'canaries', 'environments'];

export default async function environmentParity(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const configPath = path.join(root, 'qa-config.json');
  let missingKeys = 0;
  let configExists = false;
  let hint = '';

  if (fs.existsSync(configPath)) {
    configExists = true;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      const missing = EXPECTED_KEYS.filter(k => !(k in config));
      missingKeys = missing.length;

      if (missingKeys > 0) {
        hint = `qa-config.json is missing keys: ${missing.join(', ')}`;
      } else {
        hint = 'qa-config.json found with all expected keys';
      }
    } catch {
      missingKeys = EXPECTED_KEYS.length;
      hint = 'qa-config.json exists but is malformed JSON';
    }
  } else {
    missingKeys = EXPECTED_KEYS.length;
    hint = 'qa-config.json not found at project root';
  }

  const threshold = 0;
  const severity = !configExists ? 'medium' : missingKeys > 0 ? 'medium' : 'info';

  return {
    id: 'environment-parity',
    projectId: 'the-forge',
    type: 'configuration',
    severity,
    hint,
    value: missingKeys,
    threshold,
    passed: missingKeys <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
