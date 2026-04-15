import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  QaFinding,
  FindingRegistryEntry,
  FindingLifecycle,
  QaRunMeta,
  RunDelta,
  ProjectConfig,
} from '../lib/types.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const QA_DATA_ROOT = join(MODULE_DIR, '..', 'qa-data');

// --- Path helpers ---

function projectDir(projectSlug: string): string {
  return join(QA_DATA_ROOT, projectSlug);
}

function runDir(projectSlug: string, runId: string): string {
  return join(projectDir(projectSlug), 'runs', runId);
}

function baselinePath(projectSlug: string): string {
  return join(projectDir(projectSlug), 'current-baseline.json');
}

function indexPath(projectSlug: string): string {
  return join(projectDir(projectSlug), 'findings', 'index.json');
}

function configPath(projectSlug: string): string {
  return join(projectDir(projectSlug), 'config.json');
}

// --- Finding ID generation ---

export function generateFindingId(agent: string, category: string, rule: string, file: string): string {
  const input = `${agent}:${category}:${rule}:${file}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

// --- Directory initialization ---

export function initRunDirectory(projectSlug: string, runId: string): string {
  const dir = runDir(projectSlug, runId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(projectDir(projectSlug), 'findings'), { recursive: true });
  mkdirSync(join(projectDir(projectSlug), 'evolution'), { recursive: true });

  // Create empty JSONL file
  writeFileSync(join(dir, 'findings.jsonl'), '');

  return dir;
}

// --- Baseline operations ---

export function loadBaseline(projectSlug: string): QaFinding[] | null {
  const path = baselinePath(projectSlug);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function updateBaseline(projectSlug: string, findings: QaFinding[]): void {
  writeFileSync(baselinePath(projectSlug), JSON.stringify(findings, null, 2));
}

// --- Finding index operations ---

export function loadFindingIndex(projectSlug: string): FindingRegistryEntry[] {
  const path = indexPath(projectSlug);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function saveFindingIndex(projectSlug: string, entries: FindingRegistryEntry[]): void {
  writeFileSync(indexPath(projectSlug), JSON.stringify(entries, null, 2));
}

// --- Streaming: append finding to JSONL ---

export function appendFinding(projectSlug: string, runId: string, finding: QaFinding): void {
  const jsonlPath = join(runDir(projectSlug, runId), 'findings.jsonl');
  appendFileSync(jsonlPath, JSON.stringify(finding) + '\n');
}

// --- Finalize: read JSONL, deduplicate, write final JSON ---

export function finalizeFindingsFromJsonl(projectSlug: string, runId: string): QaFinding[] {
  const jsonlPath = join(runDir(projectSlug, runId), 'findings.jsonl');
  if (!existsSync(jsonlPath)) return [];

  const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
  const findingsById = new Map<string, QaFinding>();

  for (const line of lines) {
    const finding: QaFinding = JSON.parse(line);
    const existing = findingsById.get(finding.id);
    // Keep the higher-severity version if duplicate
    if (!existing || severityRank(finding.severity) > severityRank(existing.severity)) {
      findingsById.set(finding.id, finding);
    }
  }

  const findings = Array.from(findingsById.values());
  const finalPath = join(runDir(projectSlug, runId), 'findings-final.json');
  writeFileSync(finalPath, JSON.stringify(findings, null, 2));

  return findings;
}

// --- Delta computation ---

export function computeDelta(
  currentFindings: QaFinding[],
  previousFindings: QaFinding[] | null,
  runId: string,
  previousRunId: string | undefined,
): RunDelta {
  const currentIds = new Set(currentFindings.map((f) => f.id));
  const previousIds = new Set((previousFindings ?? []).map((f) => f.id));

  const newFindings = currentFindings.filter((f) => !previousIds.has(f.id)).map((f) => f.id);
  const recurringFindings = currentFindings.filter((f) => previousIds.has(f.id)).map((f) => f.id);
  const remediatedFindings = (previousFindings ?? []).filter((f) => !currentIds.has(f.id)).map((f) => f.id);

  const previousTotal = previousIds.size || 1; // avoid division by zero

  return {
    runId,
    previousRunId: previousRunId ?? 'none',
    newFindings,
    recurringFindings,
    remediatedFindings,
    closureRate: Math.round((remediatedFindings.length / previousTotal) * 1000) / 10,
    regressionRate: Math.round((newFindings.length / (currentIds.size || 1)) * 1000) / 10,
  };
}

// --- Update finding index with lifecycle transitions ---

export function updateFindingIndex(
  projectSlug: string,
  runId: string,
  currentFindings: QaFinding[],
  delta: RunDelta,
): FindingRegistryEntry[] {
  const index = loadFindingIndex(projectSlug);
  const indexById = new Map(index.map((e) => [e.id, e]));
  const now = new Date().toISOString();

  const newIds = new Set(delta.newFindings);
  const recurringIds = new Set(delta.recurringFindings);
  const remediatedIds = new Set(delta.remediatedFindings);

  // Process current findings (new + recurring)
  for (const finding of currentFindings) {
    const existing = indexById.get(finding.id);
    if (existing) {
      // Recurring — update last seen
      existing.lastSeenRunId = runId;
      existing.lastSeenAt = now;
      existing.occurrenceCount += 1;
      existing.finding = finding;
      existing.lifecycle = 'open';
      // Clear any remediation timestamps since it's back
      existing.remediatedAt = undefined;
      existing.verifiedAt = undefined;
    } else {
      // New finding
      indexById.set(finding.id, {
        id: finding.id,
        lifecycle: 'open',
        firstSeenRunId: runId,
        firstSeenAt: now,
        lastSeenRunId: runId,
        lastSeenAt: now,
        occurrenceCount: 1,
        finding,
      });
    }
  }

  // Process remediated findings (were in previous, not in current)
  for (const id of remediatedIds) {
    const entry = indexById.get(id);
    if (!entry) continue;

    const previousLifecycle = entry.lifecycle;
    if (previousLifecycle === 'wont-fix') continue; // don't touch wont-fix entries

    if (previousLifecycle === 'remediated') {
      entry.lifecycle = 'verified';
      entry.verifiedAt = now;
    } else if (previousLifecycle === 'verified') {
      entry.lifecycle = 'closed';
      entry.closedAt = now;
    } else {
      entry.lifecycle = 'remediated';
      entry.remediatedAt = now;
    }
  }

  const result = Array.from(indexById.values());
  saveFindingIndex(projectSlug, result);
  return result;
}

// --- Write run metadata ---

export function writeRunMeta(projectSlug: string, runId: string, meta: QaRunMeta): void {
  const metaPath = join(runDir(projectSlug, runId), 'meta.json');
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// --- Write delta ---

export function writeDelta(projectSlug: string, runId: string, delta: RunDelta): void {
  const deltaPath = join(runDir(projectSlug, runId), 'delta.json');
  writeFileSync(deltaPath, JSON.stringify(delta, null, 2));
}

// --- Project config ---

export function loadProjectConfig(projectSlug: string): ProjectConfig | null {
  const path = configPath(projectSlug);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function saveProjectConfig(projectSlug: string, config: ProjectConfig): void {
  writeFileSync(configPath(projectSlug), JSON.stringify(config, null, 2));
}

// --- Parse finding tags from agent output ---

const FINDING_TAG_REGEX = /<!-- finding: ({.*?}) -->/g;

export function parseFindingTags(agentOutput: string, agentName: string): QaFinding[] {
  const findings: QaFinding[] = [];
  let match;

  while ((match = FINDING_TAG_REGEX.exec(agentOutput)) !== null) {
    try {
      const raw = JSON.parse(match[1]);
      const id = generateFindingId(
        agentName,
        raw.category ?? 'unknown',
        raw.rule ?? 'unknown',
        raw.file ?? 'unknown',
      );
      findings.push({
        id,
        agent: agentName,
        severity: raw.severity ?? 'medium',
        category: raw.category ?? 'unknown',
        rule: raw.rule ?? 'unknown',
        file: raw.file ?? 'unknown',
        line: raw.line,
        title: raw.title ?? '',
        description: raw.description ?? raw.title ?? '',
        fix: raw.fix ?? '',
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Skip malformed tags — don't crash the pipeline
    }
  }

  return findings;
}

// --- Utilities ---

function severityRank(severity: string): number {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}
