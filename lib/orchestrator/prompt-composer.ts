import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALWAYS_APPLY_RULES = [
  'security.md',
  'code-quality.md',
  'testing.md',
];

/**
 * Load and cache all .md files from the rules/ directory.
 * Returns empty map if directory doesn't exist (graceful degradation).
 */
export function loadRulesCache(rulesDir: string): Map<string, string> {
  const cache = new Map<string, string>();
  if (!existsSync(rulesDir)) return cache;

  for (const file of readdirSync(rulesDir)) {
    if (!file.endsWith('.md')) continue;
    const raw = readFileSync(join(rulesDir, file), 'utf8');
    const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    cache.set(file, match ? match[1].trim() : raw.trim());
  }

  return cache;
}

/**
 * Compose a full system prompt by layering:
 *   safety notice -> model guidance -> severity rubric -> agent base -> always-apply rules -> original prompt
 *
 * When COMPOSE_RULES is disabled, this function is never called — the raw systemPrompt is used.
 *
 * @param originalPrompt - The agent's raw systemPrompt from parseAgentFile()
 * @param rulesCache - Pre-loaded rules from loadRulesCache()
 * @param model - Resolved model string (e.g. "grok-4.20-reasoning", "claude-opus-4-6", "gpt-5.4")
 */
export function composeAgentPrompt(
  originalPrompt: string,
  rulesCache: Map<string, string>,
  model: string,
): string {
  const autoCompleteStatus = process.env.QA_AUTO_COMPLETE === 'true' ? 'ENABLED' : 'DISABLED';
  const safetyNotice =
    `<!-- SAFETY NOTICE -->\n` +
    `Cross-Model QA System — Read-only by default.\n` +
    `Auto-complete is ${autoCompleteStatus}.\n` +
    `All operations are restricted to read functions of the local repo.`;

  const modelGuidance =
    `# Model Guidance\n` +
    `You are running on **${model}**.\n` +
    getModelSpecificGuidance(model);

  const severityRubric = rulesCache.get('severity-rubric.md') ?? '';
  const agentBase = rulesCache.get('agent-base.md') ?? '';

  let rulesContent = '';
  for (const rule of ALWAYS_APPLY_RULES) {
    const content = rulesCache.get(rule);
    if (content) {
      rulesContent += `\n\n${content}\n`;
    }
  }

  return `${safetyNotice}

${modelGuidance}

${severityRubric}

${agentBase}

${rulesContent}

---
${originalPrompt}
`;
}

/**
 * Provider-specific model guidance based on model string detection.
 * Each provider's models have different strengths — guidance steers them toward
 * optimal QA output for their capabilities.
 */
function getModelSpecificGuidance(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) {
    return 'Use full verbosity and detailed reasoning. Report every check, even clean ones.';
  }
  if (m.includes('grok')) {
    return 'You are optimized for factual accuracy. Be precise about evidence. Use full verbosity.';
  }
  if (m.includes('gemini')) {
    return 'Keep output structured. List all checks explicitly — do not summarize or omit clean checks.';
  }
  if (m.includes('gpt')) {
    return 'Follow the output format exactly. Use structured reasoning. Report all checks.';
  }
  // Llama, OpenClaw, or unknown models — constrained output
  return 'Keep responses under 12,000 tokens. Prioritize critical findings. Use concise structured output.';
}

/**
 * Compose a skill prompt (same structure, uses skill-base.md instead of agent-base.md).
 * For future use when skills go through the orchestrator.
 */
export function composeSkillPrompt(
  originalPrompt: string,
  rulesCache: Map<string, string>,
  model: string,
): string {
  const autoCompleteStatus = process.env.QA_AUTO_COMPLETE === 'true' ? 'ENABLED' : 'DISABLED';
  const safetyNotice =
    `<!-- SAFETY NOTICE -->\n` +
    `Cross-Model QA System — Read-only by default.\n` +
    `Auto-complete is ${autoCompleteStatus}.\n` +
    `All operations are restricted to read functions of the local repo.`;

  const modelGuidance =
    `# Model Guidance\n` +
    `You are running on **${model}**.\n` +
    getModelSpecificGuidance(model);

  const severityRubric = rulesCache.get('severity-rubric.md') ?? '';
  const skillBase = rulesCache.get('skill-base.md') ?? '';

  let rulesContent = '';
  for (const rule of ALWAYS_APPLY_RULES) {
    const content = rulesCache.get(rule);
    if (content) {
      rulesContent += `\n\n${content}\n`;
    }
  }

  return `${safetyNotice}

${modelGuidance}

${severityRubric}

${skillBase}

${rulesContent}

---
${originalPrompt}
`;
}
