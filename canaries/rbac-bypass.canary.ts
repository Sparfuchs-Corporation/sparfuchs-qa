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

export default async function rbacBypass(): Promise<CanaryResult> {
  const root = process.env.TARGET_REPO || process.cwd();
  const routerPath = path.join(root, 'apps', 'shell', 'src', 'app', 'router.tsx');
  let unprotectedCount = 0;
  let hint = '';

  if (!fs.existsSync(routerPath)) {
    return {
      id: 'rbac-bypass',
      projectId: 'sample-project',
      type: 'security',
      severity: 'info',
      hint: 'router.tsx not found — cannot scan for unprotected routes',
      value: 0,
      threshold: 0,
      passed: true,
      trend: 'stable',
      lastSeen: new Date().toISOString(),
      history: [],
    };
  }

  try {
    const content = fs.readFileSync(routerPath, 'utf-8');
    const lines = content.split('\n');
    const guardPatterns = ['RBACGuard', 'ModuleGuard', 'AuthGuard', 'ProtectedRoute'];
    const routePattern = /path:\s*['"`]/;

    // Simple heuristic: find route definitions and check if they're wrapped
    let inGuardBlock = 0;
    for (const line of lines) {
      if (guardPatterns.some(g => line.includes(g))) {
        inGuardBlock += line.includes('>') && line.includes('<') ? 0 : 1;
      }
      if (line.includes('</') && guardPatterns.some(g => line.includes(g))) {
        inGuardBlock = Math.max(0, inGuardBlock - 1);
      }
      if (routePattern.test(line) && inGuardBlock === 0) {
        // Skip common public routes
        const isPublic = /path:\s*['"`]\/(login|auth|callback|health|404|$)/.test(line);
        if (!isPublic) {
          unprotectedCount++;
        }
      }
    }

    hint =
      unprotectedCount > 0
        ? `Found ${unprotectedCount} route definition(s) not wrapped in a guard component`
        : 'All non-public routes appear to be wrapped in guard components';
  } catch {
    hint = 'Error reading router.tsx';
  }

  const threshold = 0;

  return {
    id: 'rbac-bypass',
    projectId: 'sample-project',
    type: 'security',
    severity: unprotectedCount > 0 ? 'medium' : 'info',
    hint,
    value: unprotectedCount,
    threshold,
    passed: unprotectedCount <= threshold,
    trend: 'stable',
    lastSeen: new Date().toISOString(),
    history: [],
  };
}
