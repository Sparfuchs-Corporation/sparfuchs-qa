/**
 * Package Verification & SBOM Generator
 *
 * Verifies package integrity, checks provenance attestations,
 * and generates a CycloneDX-lite SBOM.
 *
 * Usage:
 *   npx tsx scripts/package-verify.ts [repo-path]
 *   npx tsx scripts/package-verify.ts --dry-run
 *   npx tsx scripts/package-verify.ts --push
 *
 * Environment variables:
 *   QA_PLATFORM_URL  — ingestAgentReport endpoint (for --push)
 *   AGENT_REPORT_KEY — X-Agent-Key header value (for --push)
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface DepEntry {
  version: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, DepEntry>;
}

interface OutdatedEntry {
  current: string;
  wanted: string;
  latest: string;
  dependent: string;
  location: string;
}

interface AuditVuln {
  name: string;
  severity: string;
  title: string;
  url: string;
  range: string;
  fixAvailable: boolean | { name: string; version: string };
}

interface SbomComponent {
  type: 'library';
  name: string;
  version: string;
  purl: string;
  scope: 'required' | 'optional';
}

interface VerifyResult {
  lockfilePresent: boolean;
  missingIntegrity: string[];
  nonStandardRegistries: string[];
  auditSummary: Record<string, number>;
  auditVulns: AuditVuln[];
  sbomComponents: SbomComponent[];
  signatureStatus: string;
}

const EXEC_OPTS = { encoding: 'utf-8' as const, timeout: 60_000 };

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { ...EXEC_OPTS, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return (e as any).stdout || '';
  }
}

function checkLockfile(repoPath: string): { present: boolean; missingIntegrity: string[]; nonStandardRegistries: string[] } {
  const lockPath = join(repoPath, 'package-lock.json');
  if (!existsSync(lockPath)) {
    return { present: false, missingIntegrity: [], nonStandardRegistries: [] };
  }

  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  const packages = lock.packages || {};
  const missingIntegrity: string[] = [];
  const nonStandardRegistries: string[] = [];

  for (const [name, entry] of Object.entries(packages) as [string, DepEntry][]) {
    if (!name || name === '') continue;
    if (!entry.integrity) missingIntegrity.push(name);
    if (entry.resolved && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      nonStandardRegistries.push(`${name}: ${entry.resolved}`);
    }
  }

  return { present: true, missingIntegrity: missingIntegrity.slice(0, 20), nonStandardRegistries };
}

function runAudit(repoPath: string): { summary: Record<string, number>; vulns: AuditVuln[] } {
  const output = run('npm audit --json 2>/dev/null', repoPath);
  if (!output.trim()) return { summary: {}, vulns: [] };

  try {
    const audit = JSON.parse(output);
    const summary: Record<string, number> = {};
    const vulns: AuditVuln[] = [];

    if (audit.metadata?.vulnerabilities) {
      for (const [sev, count] of Object.entries(audit.metadata.vulnerabilities)) {
        if ((count as number) > 0) summary[sev] = count as number;
      }
    }

    if (audit.vulnerabilities) {
      for (const [name, v] of Object.entries(audit.vulnerabilities) as [string, any][]) {
        vulns.push({
          name,
          severity: v.severity || 'unknown',
          title: v.via?.[0]?.title || v.via?.[0] || 'Unknown',
          url: v.via?.[0]?.url || '',
          range: v.range || '',
          fixAvailable: v.fixAvailable || false,
        });
      }
    }

    return { summary, vulns: vulns.slice(0, 30) };
  } catch {
    return { summary: {}, vulns: [] };
  }
}

function buildSbom(repoPath: string): SbomComponent[] {
  const output = run('npm ls --json --depth=0 2>/dev/null', repoPath);
  if (!output.trim()) return [];

  try {
    const tree = JSON.parse(output);
    const components: SbomComponent[] = [];

    for (const [name, dep] of Object.entries(tree.dependencies || {}) as [string, any][]) {
      components.push({
        type: 'library',
        name,
        version: dep.version || 'unknown',
        purl: `pkg:npm/${name}@${dep.version}`,
        scope: 'required',
      });
    }

    return components;
  } catch {
    return [];
  }
}

function checkSignatures(repoPath: string): string {
  const output = run('npm audit signatures 2>&1', repoPath);
  if (output.includes('verified')) return output.trim().split('\n')[0];
  if (output.includes('no signatures')) return 'No provenance signatures found';
  return output.trim().split('\n')[0] || 'Unable to check signatures';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const push = args.includes('--push');
  const repoPath = resolve(args.find(a => !a.startsWith('--')) || '.');

  console.log(`Package Verification: ${repoPath}`);

  if (!existsSync(join(repoPath, 'package.json'))) {
    console.error('No package.json found at', repoPath);
    process.exit(1);
  }

  const lockfile = checkLockfile(repoPath);
  console.log(`  Lockfile: ${lockfile.present ? 'present' : 'MISSING'}`);

  const audit = runAudit(repoPath);
  console.log(`  Audit: ${JSON.stringify(audit.summary)}`);

  const sbom = buildSbom(repoPath);
  console.log(`  SBOM: ${sbom.length} components`);

  const signatures = checkSignatures(repoPath);
  console.log(`  Signatures: ${signatures}`);

  const result: VerifyResult = {
    lockfilePresent: lockfile.present,
    missingIntegrity: lockfile.missingIntegrity,
    nonStandardRegistries: lockfile.nonStandardRegistries,
    auditSummary: audit.summary,
    auditVulns: audit.vulns,
    sbomComponents: sbom,
    signatureStatus: signatures,
  };

  if (dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Output as AgentReport-compatible JSON
  const report = {
    agentSystem: 'sparfuchs-qa',
    reportType: 'package-verification',
    targetProject: repoPath,
    targetEnvironment: 'local',
    runId: randomUUID(),
    status: (audit.summary.critical || 0) > 0 ? 'fail' : (audit.summary.high || 0) > 0 ? 'warn' : 'pass',
    writtenBy: 'package-verify',
    summary: {
      pass: !audit.summary.critical && !audit.summary.high,
      findings: {
        critical: audit.summary.critical || 0,
        high: audit.summary.high || 0,
        medium: audit.summary.moderate || 0,
        low: audit.summary.low || 0,
        info: audit.summary.info || 0,
      },
      headline: `Package verify: ${sbom.length} deps, ${audit.vulns.length} vulns, lockfile ${lockfile.present ? 'OK' : 'MISSING'}`,
    },
    verification: result,
    sbom: { format: 'CycloneDX-lite', components: sbom },
  };

  console.log(JSON.stringify(report, null, 2));

  if (push) {
    const platformUrl = process.env.QA_PLATFORM_URL;
    const agentKey = process.env.AGENT_REPORT_KEY;
    if (!platformUrl || !agentKey) {
      console.error('QA_PLATFORM_URL and AGENT_REPORT_KEY required for --push');
      process.exit(1);
    }

    const resp = await fetch(platformUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Agent-Key': agentKey },
      body: JSON.stringify(report),
    });

    if (!resp.ok) {
      console.error(`POST failed: ${resp.status}`);
      process.exit(1);
    }
    console.log('Pushed to QA Platform');
  }
}

main().catch(console.error);
