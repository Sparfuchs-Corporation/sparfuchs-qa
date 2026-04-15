import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AgentDefinition, AgentOverride } from './types.js';
import { mapLegacyTier } from './config.js';

export const PHASE1_AGENTS = [
  'code-reviewer',
  'security-reviewer',
  'observability-auditor',
  'workflow-extractor',
  'ui-intent-verifier',
  'qa-gap-analyzer',
  'release-gate-synthesizer',
  'contract-reviewer',
  'spec-verifier',
] as const;

export function parseAgentFile(
  filePath: string,
  overrides: Record<string, AgentOverride> = {},
): AgentDefinition {
  if (!existsSync(filePath)) {
    throw new Error(`Agent file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');

  // Split frontmatter from body
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error(`Invalid agent file format (no YAML frontmatter): ${filePath}`);
  }

  const [, frontmatterStr, body] = match;

  // Parse simple YAML frontmatter (key: value + list items)
  const frontmatter: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (const line of frontmatterStr.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      const trimmed = value.trim();
      if (trimmed === '') {
        // Empty value — next lines may be list items
        currentListKey = key;
        frontmatter[key] = [];
      } else {
        frontmatter[key] = trimmed;
        currentListKey = null;
      }
      continue;
    }

    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && currentListKey) {
      const arr = frontmatter[currentListKey];
      if (Array.isArray(arr)) {
        arr.push(listItem[1].trim());
      }
    }
  }

  const name = frontmatter.name as string;
  if (!name) throw new Error(`Agent file missing "name" in frontmatter: ${filePath}`);

  const modelStr = frontmatter.model as string;
  if (!modelStr) throw new Error(`Agent file missing "model" in frontmatter: ${filePath}`);

  const tier = mapLegacyTier(modelStr);
  const tools = Array.isArray(frontmatter.tools) ? frontmatter.tools : ['Read', 'Grep', 'Glob', 'Bash'];
  const agentOverride = overrides[name] ?? {};
  const disableBash = agentOverride.disableBash ?? false;

  return {
    name,
    description: (frontmatter.description as string) ?? '',
    tier: agentOverride.tier ?? tier,
    tools: disableBash ? tools.filter(t => t !== 'Bash') : tools,
    systemPrompt: body.trim(),
    disableBash,
    sourcePath: filePath,
    contentHash: hash,
  };
}

export function parsePhase1Agents(
  agentsDir: string,
  overrides: Record<string, AgentOverride>,
): AgentDefinition[] {
  return PHASE1_AGENTS.map(name =>
    parseAgentFile(join(agentsDir, `${name}.md`), overrides),
  );
}

export function parseAllAgents(
  agentsDir: string,
  overrides: Record<string, AgentOverride>,
): AgentDefinition[] {
  if (!existsSync(agentsDir)) return [];
  const files = readdirSync(agentsDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  const agents: AgentDefinition[] = [];
  for (const f of files) {
    const filePath = join(agentsDir, f);
    const raw = readFileSync(filePath, 'utf8');
    // Skip files without YAML frontmatter (e.g. .agent.md, README)
    if (!raw.startsWith('---\n')) {
      process.stderr.write(`Skipping non-agent file: ${f}\n`);
      continue;
    }
    agents.push(parseAgentFile(filePath, overrides));
  }
  return agents;
}

export function parseAgentsByNames(
  agentsDir: string,
  agentNames: string[],
  overrides: Record<string, AgentOverride>,
): AgentDefinition[] {
  return agentNames.map(name =>
    parseAgentFile(join(agentsDir, `${name}.md`), overrides),
  );
}

export function validateAgentIntegrity(
  agents: AgentDefinition[],
  hashesPath: string,
): { valid: boolean; mismatches: string[] } {
  if (!existsSync(hashesPath)) {
    return { valid: true, mismatches: [] };
  }

  const knownHashes: Record<string, string> = JSON.parse(readFileSync(hashesPath, 'utf8'));
  const mismatches: string[] = [];

  for (const agent of agents) {
    const known = knownHashes[agent.name];
    if (known && known !== agent.contentHash) {
      mismatches.push(
        `${agent.name}: expected ${known.slice(0, 12)}... got ${agent.contentHash.slice(0, 12)}...`
      );
    }
  }

  return { valid: mismatches.length === 0, mismatches };
}

export function generateAgentHashes(agents: AgentDefinition[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const agent of agents) {
    hashes[agent.name] = agent.contentHash;
  }
  return hashes;
}
