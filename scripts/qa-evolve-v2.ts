/**
 * qa-evolve-v2 — Analyze finding patterns and generate evolution artifacts
 *
 * Replaces qa-evolve.ts. Uses local qa-data/ instead of Firestore.
 *
 * Usage:
 *   npx tsx scripts/qa-evolve-v2.ts --project the-forge
 *   QA_EVOLVE_DRY=1 npx tsx scripts/qa-evolve-v2.ts --project the-forge
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { FindingRegistryEntry, EvolutionPattern, FindingSeverity, QaRunMeta } from '../lib/types.js';

const QA_DATA_ROOT = join(import.meta.dirname, '..', 'qa-data');
const DRY_RUN = process.env.QA_EVOLVE_DRY === '1';

function parseArgs(): { project: string } {
  const args = process.argv.slice(2);
  let project = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) project = args[++i];
  }
  if (!project) {
    console.error('Usage: npx tsx scripts/qa-evolve-v2.ts --project <slug>');
    process.exit(1);
  }
  return { project };
}

function loadJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function severityToNumber(s: FindingSeverity): number {
  switch (s) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function numberToSeverity(n: number): FindingSeverity {
  if (n >= 3.5) return 'critical';
  if (n >= 2.5) return 'high';
  if (n >= 1.5) return 'medium';
  return 'low';
}

function main() {
  const { project } = parseArgs();
  const projectDir = join(QA_DATA_ROOT, project);

  // Load finding index
  const indexPath = join(projectDir, 'findings', 'index.json');
  const index: FindingRegistryEntry[] = loadJson(indexPath) ?? [];

  if (index.length === 0) {
    console.log('No findings in index — nothing to evolve. Run a QA review first.');
    return;
  }

  // Count total runs
  const runsDir = join(projectDir, 'runs');
  const runIds = existsSync(runsDir) ? readdirSync(runsDir).filter((d) => d.startsWith('qa-')).sort() : [];

  // Aggregate patterns by rule
  const patternMap = new Map<string, {
    rule: string;
    category: string;
    occurrences: number;
    runs: Set<string>;
    severities: number[];
    remediatedCount: number;
  }>();

  for (const entry of index) {
    const key = `${entry.finding.category}:${entry.finding.rule}`;
    let pattern = patternMap.get(key);
    if (!pattern) {
      pattern = {
        rule: entry.finding.rule,
        category: entry.finding.category,
        occurrences: 0,
        runs: new Set(),
        severities: [],
        remediatedCount: 0,
      };
      patternMap.set(key, pattern);
    }
    pattern.occurrences += entry.occurrenceCount;
    pattern.runs.add(entry.firstSeenRunId);
    if (entry.lastSeenRunId !== entry.firstSeenRunId) pattern.runs.add(entry.lastSeenRunId);
    pattern.severities.push(severityToNumber(entry.finding.severity));
    if (entry.lifecycle === 'remediated' || entry.lifecycle === 'verified' || entry.lifecycle === 'closed') {
      pattern.remediatedCount++;
    }
  }

  // Build EvolutionPattern[]
  const patterns: EvolutionPattern[] = Array.from(patternMap.values()).map((p) => {
    const avgSev = p.severities.reduce((a, b) => a + b, 0) / p.severities.length;
    const totalForRule = index.filter((e) => e.finding.rule === p.rule).length;
    const fixRate = totalForRule > 0 ? Math.round((p.remediatedCount / totalForRule) * 100) : 0;

    // Trend: compare first half of runs to second half
    const trend: 'improving' | 'stable' | 'worsening' = fixRate > 50 ? 'improving' : fixRate < 20 ? 'worsening' : 'stable';

    return {
      rule: p.rule,
      category: p.category,
      totalOccurrences: p.occurrences,
      runsAppeared: p.runs.size,
      averageSeverity: numberToSeverity(avgSev),
      fixRate,
      trend,
      lastSeen: new Date().toISOString(),
    };
  }).sort((a, b) => b.totalOccurrences - a.totalOccurrences);

  // Write patterns.json
  const evolutionDir = join(projectDir, 'evolution');
  writeFileSync(join(evolutionDir, 'patterns.json'), JSON.stringify(patterns, null, 2));
  console.log(`Wrote ${patterns.length} patterns to evolution/patterns.json`);

  // Generate suggestions.md
  const suggestions = generateSuggestions(patterns, runIds.length);
  writeFileSync(join(evolutionDir, 'suggestions.md'), suggestions);
  console.log('Wrote evolution/suggestions.md');

  // Generate prd-checklist.md
  const checklist = generatePrdChecklist(patterns, project);
  writeFileSync(join(evolutionDir, 'prd-checklist.md'), checklist);
  console.log('Wrote evolution/prd-checklist.md');

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Artifacts written locally. No Claude invocation.');
  }
}

function generateSuggestions(patterns: EvolutionPattern[], totalRuns: number): string {
  const lines: string[] = [];
  lines.push(`# Evolution Suggestions`);
  lines.push(`Generated: ${new Date().toISOString().split('T')[0]} | Based on ${totalRuns} runs`);
  lines.push('');

  // Never-fixed rules
  const neverFixed = patterns.filter((p) => p.fixRate === 0 && p.runsAppeared >= 2);
  if (neverFixed.length > 0) {
    lines.push('## Never Fixed (escalate severity or convert to blocking)');
    for (const p of neverFixed.slice(0, 10)) {
      lines.push(`- **${p.rule}** (${p.category}): ${p.totalOccurrences} occurrences across ${p.runsAppeared} runs, 0% fix rate`);
    }
    lines.push('');
  }

  // High fix rate rules
  const wellFixed = patterns.filter((p) => p.fixRate > 80);
  if (wellFixed.length > 0) {
    lines.push('## Well-Fixed (consider tightening thresholds or retiring)');
    for (const p of wellFixed.slice(0, 10)) {
      lines.push(`- **${p.rule}** (${p.category}): ${p.fixRate}% fix rate — developers fix this consistently`);
    }
    lines.push('');
  }

  // Worsening trends
  const worsening = patterns.filter((p) => p.trend === 'worsening');
  if (worsening.length > 0) {
    lines.push('## Worsening Trends');
    for (const p of worsening.slice(0, 10)) {
      lines.push(`- **${p.rule}** (${p.category}): ${p.totalOccurrences} occurrences, ${p.fixRate}% fix rate — getting worse`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generatePrdChecklist(patterns: EvolutionPattern[], project: string): string {
  const lines: string[] = [];
  lines.push(`# QA-Informed PRD Checklist`);
  lines.push(`Generated from QA reviews of ${project}`);
  lines.push('');
  lines.push('Based on recurring findings, ensure your PRD addresses:');
  lines.push('');

  // Group by category
  const byCategory = new Map<string, EvolutionPattern[]>();
  for (const p of patterns.filter((p) => p.totalOccurrences >= 2)) {
    const list = byCategory.get(p.category) ?? [];
    list.push(p);
    byCategory.set(p.category, list);
  }

  const categoryLabels: Record<string, string> = {
    security: 'Security & Authentication',
    a11y: 'Accessibility',
    perf: 'Performance',
    code: 'Code Quality',
    contract: 'API Contracts',
    deploy: 'Deployment & Configuration',
    intent: 'UI Intent & Feature Completeness',
    compliance: 'Data Privacy & Compliance',
    rbac: 'Authorization & Roles',
    iac: 'Infrastructure',
  };

  for (const [category, categoryPatterns] of byCategory) {
    const label = categoryLabels[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`## ${label}`);
    for (const p of categoryPatterns.slice(0, 5)) {
      // Convert rule ID to human-readable checklist item
      const readable = p.rule.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`- [ ] Address: ${readable} (found ${p.totalOccurrences}x, ${p.fixRate}% fix rate)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

main();
