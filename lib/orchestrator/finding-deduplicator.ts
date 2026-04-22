import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QaFinding, FindingSeverity } from '../types.js';

export interface DedupResult {
  original: number;
  deduplicated: number;
  removed: number;
  mergedGroups: Array<{
    rule: string;
    file: string;
    agents: string[];
    keptSeverity: FindingSeverity;
  }>;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const NEAR_LINE_THRESHOLD = 5;

export function deduplicateFindings(findingsPath: string, runDir: string): DedupResult {
  if (!existsSync(findingsPath)) {
    return { original: 0, deduplicated: 0, removed: 0, mergedGroups: [] };
  }

  const lines = readFileSync(findingsPath, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { original: 0, deduplicated: 0, removed: 0, mergedGroups: [] };
  }

  const findings: QaFinding[] = lines.map(line => JSON.parse(line));
  const original = findings.length;

  // Group by file + rule (cross-agent grouping key)
  const groups = new Map<string, QaFinding[]>();
  for (const f of findings) {
    const key = `${f.file}::${f.rule}`;
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }

  const kept: QaFinding[] = [];
  const mergedGroups: DedupResult['mergedGroups'] = [];

  for (const [, group] of groups) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }

    const clusters = clusterByLine(group);

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        kept.push(cluster[0]);
        continue;
      }

      // Keep the finding with the LOWEST severity (rubric: "default to the lower severity")
      cluster.sort(
        (a, b) => (SEVERITY_RANK[a.severity] ?? 0) - (SEVERITY_RANK[b.severity] ?? 0),
      );
      const winner = cluster[0];
      kept.push(winner);

      mergedGroups.push({
        rule: winner.rule,
        file: winner.file,
        agents: [...new Set(cluster.map(f => f.agent))],
        keptSeverity: winner.severity,
      });
    }
  }

  // Overwrite findings.jsonl with deduped set
  const dedupedContent = kept.map(f => JSON.stringify(f)).join('\n') + (kept.length > 0 ? '\n' : '');
  writeFileSync(findingsPath, dedupedContent);

  // Write audit trail
  const report = {
    original,
    deduplicated: kept.length,
    removed: original - kept.length,
    mergedGroups,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(join(runDir, 'dedup-report.json'), JSON.stringify(report, null, 2));

  return {
    original,
    deduplicated: kept.length,
    removed: original - kept.length,
    mergedGroups,
  };
}

function clusterByLine(findings: QaFinding[]): QaFinding[][] {
  const withLine = findings.filter(f => f.line != null).sort((a, b) => a.line! - b.line!);
  const withoutLine = findings.filter(f => f.line == null);

  const clusters: QaFinding[][] = [];
  let current: QaFinding[] = [];

  for (const f of withLine) {
    if (current.length === 0) {
      current.push(f);
    } else {
      const lastLine = current[current.length - 1].line!;
      if (f.line! - lastLine <= NEAR_LINE_THRESHOLD) {
        current.push(f);
      } else {
        clusters.push(current);
        current = [f];
      }
    }
  }
  if (current.length > 0) clusters.push(current);

  if (withoutLine.length > 0) clusters.push(withoutLine);

  return clusters;
}
