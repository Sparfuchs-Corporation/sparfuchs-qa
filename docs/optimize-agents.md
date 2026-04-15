# Plan: Optimize Agents & Skills for 2026 Best Practices

## Context

Audit found ~41K tokens of recoverable waste per orchestrated run across 43 agents and 18 skills. This plan applies the 2026 universal prompt structure, platform-specific caching, and full agent/skill compression.

**Sequencing**: Commit current cross-model composition PR first, then start this on a new branch.

---

## Universal Prompt Structure (enforced by prompt-composer.ts)

Every composed agent prompt will follow this exact layout:

```
┌─────────────────────────────────────────────────────┐
│ STATIC / HIGHLY CACHEABLE (top — cheapest to cache)  │
│                                                       │
│ 1. System instructions / persona (safety-notice.md)   │
│ 2. Tool definitions with strict schemas, enums,       │
│    "when to use / not to use", 1-2 examples           │
│ 3. Reusable knowledge (severity-rubric.md,            │
│    agent-base.md, security/quality/testing rules)     │
│ 4. Few-shot examples for desired output format        │
├─────────────────────────────────────────────────────┤
│ SEMI-STATIC / SESSION CONTEXT (cache where possible)  │
│                                                       │
│ 5. Model guidance (provider-specific)                 │
│ 6. Shared templates (finding-tags, step-budget, etc.) │
│ 7. Agent-specific instructions (the .md body)         │
├─────────────────────────────────────────────────────┤
│ DYNAMIC / FRESH CONTENT (bottom — never cache)        │
│                                                       │
│ 8. Delegation prompt (repo path, run ID, output path) │
│ 9. Baseline findings (if BASELINE=true)               │
│ 10. Chunk/module scope (if applicable)                │
│ 11. Current task instruction                          │
└─────────────────────────────────────────────────────┘
```

**Key rule**: Static content always at top, dynamic always at bottom. This maximizes prefix cache hits across all providers.

---

## Platform-Specific Caching Implementation

### Anthropic (Claude 4.6)

In `api-adapter.ts`, use `cache_control: {type: "ephemeral"}` on static blocks:

```typescript
const result = await generateText({
  model: modelId,
  system: agent.systemPrompt,
  prompt: delegationPrompt,
  tools,
  stopWhen: stepCountIs(maxSteps),
  temperature: 0.1,
  providerOptions: {
    anthropic: { cacheControl: true },
  },
  onStepFinish: (event) => {
    if (event.usage) {
      status.tokenUsage.input += event.usage.inputTokens ?? 0;
      status.tokenUsage.output += event.usage.outputTokens ?? 0;
      status.tokenUsage.cacheRead = (status.tokenUsage.cacheRead ?? 0)
        + (event.usage.cacheReadTokens ?? 0);
      status.tokenUsage.cacheCreation = (status.tokenUsage.cacheCreation ?? 0)
        + (event.usage.cacheCreationTokens ?? 0);
    }
    status.toolCallCount += (event.toolCalls?.length ?? 0);
    onStatusChange(status);
  },
});
```

Cache read tokens cost ~10% of normal input — up to 90% savings on repeated system prompts.

### xAI (Grok 4.x)

Prompt caching is automatic. Add stable session header for maximum hits:

```typescript
// In api-adapter.ts, for xai provider:
const headers: Record<string, string> = {};
if (this.name === 'xai') {
  headers['x-grok-conv-id'] = `sparfuchs-${config.runId}`;
}

const result = await generateText({
  model: modelId,
  system: agent.systemPrompt,
  prompt: delegationPrompt,
  tools,
  headers,
  // ...
});
```

Rules: never modify/reorder earlier messages — only append. Front-load static content aggressively. Grok 4.1 Fast for most agent loops; 4.20 only for deep reasoning.

### Google (Gemini 3.x)

Implicit caching by keeping exact same prefix across requests. Explicit Context Caching for large static blocks:

```typescript
// For google provider, set caching options:
if (this.name === 'google') {
  providerOptions.google = {
    cachedContent: {
      model: modelId,
      contents: [{ role: 'user', parts: [{ text: agent.systemPrompt }] }],
      ttlSeconds: 3600,
    },
  };
}
```

Cost tip: Route routine summarization/routing to Flash models; use Pro only for final synthesis.

### OpenAI (GPT-5.4)

Automatic prefix caching on prefixes > ~1K tokens. Keep static system/tools at beginning. No special headers needed — just maintain consistent prefix ordering.

For Codex CLI: keep reusable guidance in AGENTS.md (highly cacheable) and repeated instructions as Skills.

### Ollama / Local Models

No per-token cost. Key settings:
- `num_ctx`: 16K-32K sweet spot (higher only when needed)
- Quantization: Q5_K_M or Q6_K
- Embed static system prompt + tool schemas in Modelfile
- Implement summarization in orchestrator (no native caching layer)
- Tool-native models: Qwen2.5-Coder or Llama 4 variants for strict JSON

---

## Phase 1: Prompt Caching + Shared Templates (~14K tokens saved)

### 1a. Restructure `prompt-composer.ts` for cache-optimal ordering

Update `composeAgentPrompt` to follow the universal structure:

```typescript
export function composeAgentPrompt(
  originalPrompt: string,
  rulesCache: Map<string, string>,
  model: string,
  agentName: string,
): string {
  // === STATIC BLOCK (top — maximizes cache hits) ===
  const safetyNotice = /* safety-notice.md with AUTO_COMPLETE resolved */;
  const severityRubric = rulesCache.get('severity-rubric.md') ?? '';
  const agentBase = rulesCache.get('agent-base.md') ?? '';
  let alwaysApplyRules = '';
  for (const rule of ALWAYS_APPLY_RULES) {
    alwaysApplyRules += rulesCache.get(rule) ?? '';
  }
  const fewShotExample = getFewShotExample(agentName); // NEW

  // === SEMI-STATIC BLOCK (session context) ===
  const modelGuidance = getModelSpecificGuidance(model);
  const sharedTemplates = getSharedTemplates(agentName, rulesCache); // NEW
  const toolGuidance = getToolGuidance(agentName); // NEW

  // === AGENT-SPECIFIC (semi-static) ===
  // originalPrompt goes here — dynamic content appended by orchestrator AFTER this

  return [
    '<!-- cache:static -->',
    safetyNotice,
    severityRubric,
    agentBase,
    alwaysApplyRules,
    fewShotExample,
    '<!-- cache:session -->',
    `# Model Guidance\nYou are running on **${model}**.\n${modelGuidance}`,
    toolGuidance,
    sharedTemplates,
    '<!-- cache:agent -->',
    '---',
    originalPrompt,
  ].filter(Boolean).join('\n\n');
}
```

### 1b. Add tool-specific guidance per agent

Since tools are already selected at agent parse time (frontmatter `tools: [Read, Grep, Glob, Bash]`), add tool-specific "when to use / not to use" guidance:

**New function `getToolGuidance(agentName)`** in prompt-composer.ts:

```typescript
function getToolGuidance(agentName: string): string {
  // All agents get the same 4 tools, but usage guidance differs
  return `# Tool Usage Guidelines

**Read** — Read file contents. Use ONLY after a Grep/Glob match confirms relevance.
- When to use: examining specific files identified by Grep hits
- When NOT to use: scanning entire directories (use Glob first)
- Return: file content with line numbers

**Grep** — Search file contents by regex. ALWAYS use before Read.
- When to use: finding specific patterns, validating presence/absence of code
- When NOT to use: listing files (use Glob instead)
- Return: matching lines with file paths

**Glob** — Find files by name pattern. Use for discovery.
- When to use: finding files by extension, name, or directory
- When NOT to use: searching file contents (use Grep instead)
- Return: file paths sorted by modification time

**Bash** — Run shell commands. Use sparingly.
- When to use: git diff, git log, npm/build commands, file operations not covered by other tools
- When NOT to use: reading files (use Read), searching (use Grep/Glob)
- Always append \`2>&1 || true\` to prevent failures from stopping analysis

Output ONLY structured findings matching the finding tag schema. No explanations outside findings.`;
}
```

### 1c. Add few-shot examples for key agents

**New function `getFewShotExample(agentName)`**:

```typescript
const FEW_SHOT_EXAMPLES: Record<string, string> = {
  'code-reviewer': `## Example Finding

**File:Line**: src/auth/middleware.ts:42
**Issue**: Catch block swallows error — \`catch (e) { return null }\` loses stack trace
**Suggestion**: \`catch (e) { logger.error('auth failed', { error: e }); throw e; }\`

<!-- finding: {"severity":"medium","category":"code","rule":"swallowed-error","file":"src/auth/middleware.ts","line":42,"title":"Catch block swallows error without logging","fix":"Add logger.error before return"} -->`,

  'security-reviewer': `## Example Finding

**File:Line**: src/api/users.ts:18
**Issue**: SQL query uses string concatenation — \`\`WHERE id = '\${userId}'\`\` is vulnerable to injection
**Suggestion**: Use parameterized query: \`WHERE id = $1\` with \`[userId]\`

<!-- finding: {"severity":"critical","category":"security","rule":"sql-injection","file":"src/api/users.ts","line":18,"title":"SQL injection via string concatenation","fix":"Use parameterized query"} -->`,
};

function getFewShotExample(agentName: string): string {
  const example = FEW_SHOT_EXAMPLES[agentName];
  return example ? `# Output Example\n${example}` : '';
}
```

Add examples for: code-reviewer, security-reviewer, stub-detector, release-gate-synthesizer, observability-auditor.

### 1d. Create shared template files

**`rules/shared-templates/finding-tags.md`** (~25 lines):
```markdown
# Structured Finding Tag Format

After each finding, emit a machine-readable tag:

\`\`\`
<!-- finding: {"severity":"critical","category":"security","rule":"rule-id","file":"path","line":42,"title":"summary","fix":"fix"} -->
\`\`\`

Rules:
- One tag per file:line pair. 11 files = 11 tags.
- severity: critical / high / medium / low
- category: security, code, perf, build, test, a11y, contract, deps, deploy, intent, spec, dead-code, compliance, rbac, iac, doc
- rule: kebab-case pattern ID
- group (optional): shared root cause ID
- **Completeness**: End output with "Finding tags emitted: {n}"
```

**`rules/shared-templates/step-budget.md`** (~12 lines):
```markdown
# Step Budget Strategy

Maximize coverage within your tool call budget:
1. Batch discovery: Glob + Grep first to find all targets
2. Grep before Read: never Read a file without a Grep match
3. Batch dimension checks: one Grep per pattern, not per file
4. Read selectively: only files with confirmed pattern matches
5. Emit findings as you go: don't accumulate then dump
```

**`rules/shared-templates/output-format.md`** (~15 lines):
```markdown
# Standard Output Format

Structure your output as:
1. **Discovery log**: what you searched, what matched
2. **Findings**: each with evidence + finding tag
3. **Clean checks**: patterns checked that found no issues
4. **Summary**: total findings by severity
5. **Completeness**: "Finding tags emitted: {n}"

Output ONLY valid findings. No preamble, no apologies, no meta-commentary.
```

**`rules/shared-templates/discovery-patterns.md`** (~15 lines):
```markdown
# Discovery Phase

1. Run `git diff --name-only` to find changed files
2. Use Glob to map directory structure (src/, test/, lib/, config/)
3. Use Grep to detect tech stack markers (package.json, tsconfig, Dockerfile)
4. Identify entry points, API routes, auth boundaries
5. Log all discovery to your output — this IS the forensic record
```

### 1e. Update `loadRulesCache` for subdirectories

```typescript
export function loadRulesCache(rulesDir: string): Map<string, string> {
  const cache = new Map<string, string>();
  if (!existsSync(rulesDir)) return cache;
  loadDir(rulesDir, '', cache);
  return cache;
}

function loadDir(dir: string, prefix: string, cache: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      loadDir(join(dir, entry.name), `${prefix}${entry.name}/`, cache);
    } else if (entry.name.endsWith('.md')) {
      const raw = readFileSync(join(dir, entry.name), 'utf8');
      const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      cache.set(`${prefix}${entry.name}`, match ? match[1].trim() : raw.trim());
    }
  }
}
```

---

## Phase 2: Agent Compression (Top 10 → ~7.6K tokens saved)

### Compression technique for all agents

Replace verbose prose with:
- **Checklist format**: "Check X. If found → emit finding (severity: Y, rule: Z)."
- **Table format** for pattern lists (more scannable, fewer tokens)
- **Remove duplicated boilerplate** already covered by shared templates
- **Remove finding tag section** (now in `shared-templates/finding-tags.md`)
- **Remove verbosity preamble** (now in `agent-base.md`)

### Agents to compress

| Agent | Lines | Target | Remove |
|---|---|---|---|
| training-system-builder | 535 | 300 | Decision tree template → external ref |
| permission-chain-checker | 433 | 250 | 5 validators → parameterized template |
| session-cleanup | 432 | 250 | Workflow template → external ref |
| access-query-validator | 409 | 250 | 3 overlapping validation blocks → unified |
| ui-intent-verifier | 399 | 250 | Element checklists → table format |
| build-verifier | 396 | 250 | Error classification → table format |
| stub-detector | 344 | 220 | Language patterns → table format |
| schema-migration-reviewer | 329 | 220 | DB comparison → unified template |
| role-visibility-matrix | 319 | 200 | Matrix generation → table + template |
| collection-reference-validator | 305 | 200 | DB patterns → table format |

### For ALL 43 agents: remove duplicated sections

After shared templates are injected by the composer, remove these sections from agent files:
1. **"Full verbosity mode" preamble** (28 agents) — covered by `agent-base.md`
2. **"OUTPUT FILE" paragraph** (28 agents) — covered by `agent-base.md`
3. **"Structured Finding Tag" section** (38 agents) — covered by `shared-templates/finding-tags.md`
4. **"Step Budget Strategy" section** (9 agents) — covered by `shared-templates/step-budget.md`

This removes ~25-30 lines per agent × 38 agents = ~1,000 lines total.

**Important**: Agent files must remain self-contained for direct Claude CLI mode. Add a one-line reference comment at the bottom of each:
```markdown
<!-- NOTE: When run via orchestrator with COMPOSE_RULES=true, the finding tag format, verbosity rules, and step budget are injected automatically. The sections below are for standalone/direct CLI use. -->
```

Wait — per earlier decision, we keep agent files self-contained. The composer adds layers ON TOP, not removes from agents. So we DON'T remove sections from agents. Instead:

**Revised approach**: The composer detects and SKIPS injecting `shared-templates/finding-tags.md` if the agent already contains `## Structured Finding Tag`. Same for step budget. This means:
- Agent files stay self-contained (direct CLI works)
- Composer adds templates only for agents missing them
- No breaking changes

For the top 10 bloated agents, we compress **agent-specific prose** (not shared boilerplate):
- Convert verbose paragraphs to checklist format
- Convert inline pattern lists to tables
- Remove redundant explanatory text

---

## Phase 3: Structured Output + Selective Retrieval + Context Compaction

### 3a. Structured output enforcement

Add to `agent-base.md` (already injected for all agents):
```markdown
- Output ONLY structured findings matching the finding tag JSON schema.
- Use temperature 0.0-0.2 for deterministic analysis.
- No explanations, apologies, or meta-commentary outside of findings and clean-check logs.
```

### 3b. Selective retrieval instruction

Add to `shared-templates/discovery-patterns.md`:
```markdown
- NEVER read entire files without a Grep match first
- NEVER dump full directory listings — use targeted Glob patterns
- Only inject top-k relevant snippets, not full files
- When a Grep match confirms a pattern, Read only the surrounding 20 lines (not the whole file)
```

### 3c. Context compaction instruction

Add to `agent-base.md`:
```markdown
- If your analysis exceeds 8,000 tokens, compress earlier discovery logs into a "Key Findings So Far" summary before continuing.
- Keep only the last 4-6 tool results in full detail; summarize older ones as bullet points.
```

### 3d. Add strict JSON output instruction to 6 prose-heavy agents

For: api-contract-prober, crud-tester, e2e-tester, qa-gap-analyzer, spec-verifier, workflow-extractor

Add at the top of their agent-specific instructions:
```markdown
**Output format**: Emit findings as structured <!-- finding: {...} --> tags only.
Do not generate prose descriptions, test plans, or narrative summaries.
Each check result = one finding tag or one "clean check" log line.
```

---

## Skill Optimization

### Split `qa-review` SKILL.md (1,052 → ~500 lines)

Extract reusable sections into shared skill templates:
- Session log format → `rules/skill-templates/session-log-format.md`
- Discovery phase → `rules/shared-templates/discovery-patterns.md` (already created)
- Agent delegation pattern → stays (it's the core of the skill)
- Report synthesis → compress prose to checklist

### Compress 3 verbose skills

| Skill | Lines | Target | Technique |
|---|---|---|---|
| setupdotclaude | 198 | 120 | Action checklists + YAML schema examples |
| pre-push-check | 178 | 110 | Vendor lookup table replacing prose blocks |
| qa-training | 178 | 120 | Decision tree replacing mode-detection prose |

### Create shared skill templates

**`rules/skill-templates/rules.md`** (~20 lines):
Confirmation rules, commit safety, force-push prohibition — used by hotfix, ship, debug-fix, pr-review.

**`rules/skill-templates/session-log-format.md`** (~15 lines):
File naming, directory structure, metadata headers — used by qa-review, qa-selective, qa-training, qa-docs.

---

## Monitoring: Cache Hit Tracking

### Add to `AgentRunStatus` in `types.ts`

```typescript
tokenUsage: {
  input: number;
  output: number;
  cacheRead: number;    // NEW
  cacheCreation: number; // NEW
};
```

### Log cache metrics in `meta.json`

Add per-agent cache stats to the run metadata:
```json
{
  "agents": [{
    "agentName": "code-reviewer",
    "tokenUsage": {
      "input": 12000,
      "output": 3500,
      "cacheRead": 8500,
      "cacheCreation": 2000
    },
    "cacheHitRate": 0.71
  }]
}
```

### Print cache summary at end of run

```typescript
// After agent loop, compute aggregate cache stats
const totalInput = /* sum all agent input */;
const totalCacheRead = /* sum all agent cacheRead */;
if (totalCacheRead > 0) {
  const hitRate = Math.round((totalCacheRead / (totalInput + totalCacheRead)) * 100);
  process.stderr.write(`Cache hit rate: ${hitRate}% (${totalCacheRead} tokens from cache)\n`);
}
```

---

## Implementation Order

1. Commit current cross-model composition PR
2. Create new branch `feat/token-optimization`
3. Restructure `prompt-composer.ts` for cache-optimal ordering
4. Add provider-specific caching in `api-adapter.ts`
5. Create `rules/shared-templates/` (4 template files)
6. Add tool guidance + few-shot examples to composer
7. Update `loadRulesCache` for recursive subdirectory loading
8. Add cache tracking to `types.ts` + `api-adapter.ts` + `meta.json`
9. Compress top 10 bloated agents
10. Add structured output + selective retrieval instructions
11. Compress 3 verbose skills + split qa-review
12. Create skill template files
13. Typecheck + canaries + verify

## File Summary

| Category | Files | Action |
|---|---|---|
| `lib/orchestrator/prompt-composer.ts` | 1 | MODIFY — cache-optimal ordering, tool guidance, few-shot, recursive loading |
| `lib/orchestrator/adapters/api-adapter.ts` | 1 | MODIFY — provider-specific caching + cache hit tracking |
| `lib/orchestrator/types.ts` | 1 | MODIFY — cacheRead/cacheCreation fields |
| `lib/orchestrator/index.ts` | 1 | MODIFY — cache summary logging |
| `rules/shared-templates/*.md` | 4 | CREATE — finding-tags, step-budget, output-format, discovery-patterns |
| `rules/skill-templates/*.md` | 2 | CREATE — rules, session-log-format |
| `.claude/agents/*.md` (top 10) | 10 | MODIFY — compress prose to checklists/tables |
| `.claude/agents/*.md` (6 prose-heavy) | 6 | MODIFY — add structured output instructions |
| `.claude/skills/qa-review/SKILL.md` | 1 | MODIFY — split/compress |
| `.claude/skills/*/SKILL.md` (3 verbose) | 3 | MODIFY — compress |
| **Total** | **~30** | |

## Expected Token Savings

| Optimization | Tokens saved/run |
|---|---|
| Prompt caching (all providers) | ~8,000 |
| Shared template extraction | ~6,270 |
| Agent compression (top 10) | ~7,600 |
| Structured output enforcement | ~1,200 |
| Selective retrieval | ~3,000-5,000 |
| Skill compression | ~2,000 |
| **Total** | **~28,000-30,000** |
