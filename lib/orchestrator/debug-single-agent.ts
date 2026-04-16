/**
 * Debug script: runs a single agent through the auth proxy to capture the exact failure reason.
 * Usage: npx tsx lib/orchestrator/debug-single-agent.ts <agent-name> <repo-path>
 */

import { generateText, stepCountIs } from 'ai';
import { ProviderRegistry } from './provider-registry.js';
import { loadModelsConfig, enforceDataClassification, resolveProviderKeys, resolveModelForAgent } from './config.js';
import { parseAllAgents } from './agent-parser.js';
import { createToolSet, type ToolSetOptions } from './tool-implementations.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ToolCallLogEntry } from './types.js';

const agentName = process.argv[2] ?? 'dependency-auditor';
const repoPath = process.argv[3] ?? '/Users/bob/Development-local/clone-Theforge-merge-prep';

async function main() {
  console.log(`\n=== Debug Single Agent: ${agentName} ===`);
  console.log(`Repo: ${repoPath}\n`);

  // 1. Load config
  const modelsConfig = loadModelsConfig();
  enforceDataClassification(modelsConfig);
  const { available, disabled } = resolveProviderKeys(modelsConfig);
  console.log(`Available providers: ${available.join(', ')}`);
  console.log(`Disabled: ${disabled.join('; ')}\n`);

  // 2. Start auth proxy
  const registry = new ProviderRegistry();
  console.log('Starting auth proxy...');
  const proxyProviders = await registry.startProxy();
  console.log(`Proxy providers: ${proxyProviders.join(', ')}\n`);

  // 3. Parse agent
  const agentsDir = join(repoPath, '.claude', 'agents');
  const agents = parseAllAgents(agentsDir, modelsConfig.agentOverrides);
  const agent = agents.find(a => a.name === agentName);
  if (!agent) {
    console.error(`Agent "${agentName}" not found. Available: ${agents.map(a => a.name).join(', ')}`);
    await registry.shutdown();
    process.exit(1);
  }

  console.log(`Agent: ${agent.name}`);
  console.log(`Tier: ${agent.tier}`);
  console.log(`Tools: ${agent.tools.join(', ')}`);
  console.log(`System prompt: ${agent.systemPrompt.length} chars\n`);

  // 4. Resolve model
  const resolved = resolveModelForAgent(agent.name, agent.tier, modelsConfig, 'API' as any);
  console.log(`Provider: ${resolved.provider}`);
  console.log(`Model: ${resolved.model}\n`);

  // 5. Create tools
  const toolCallLog: ToolCallLogEntry[] = [];
  const tmpDir = join('/tmp', `sparfuchs-debug-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const toolOpts: ToolSetOptions = {
    repoRoot: repoPath,
    qaDataRoot: tmpDir,
    sessionLogDir: tmpDir,
    redactSecretsEnabled: true,
    toolCallLog,
  };
  const tools = createToolSet(agent, toolOpts);
  console.log(`Tools created: ${Object.keys(tools).join(', ')}\n`);

  // 6. Create model via proxy
  console.log('Creating model via proxy...');
  const model = registry.createModel(
    resolved.provider as 'anthropic' | 'xai' | 'google' | 'openai',
    resolved.model,
    agentName,
  );
  console.log('Model created.\n');

  // 7. Build delegation prompt (minimal)
  const delegationPrompt = `You are reviewing the repository at ${repoPath}.

Analyze the codebase and produce your findings. Use the Read, Grep, Glob, and Bash tools to examine the code.

Focus on your area of expertise as described in your system prompt. Be thorough but concise.

IMPORTANT: When you are done, output your findings as a text summary.`;

  // 8. Run
  console.log('--- Running agent ---');
  const startTime = Date.now();
  let totalInput = 0;
  let totalOutput = 0;
  let stepCount = 0;

  try {
    const maxSteps = modelsConfig.agentOverrides[agent.name]?.maxSteps ?? 50;
    console.log(`Max steps: ${maxSteps}`);

    const result = await generateText({
      model,
      system: agent.systemPrompt,
      prompt: delegationPrompt,
      tools,
      stopWhen: stepCountIs(maxSteps),
      temperature: 0.1,
      onStepFinish: (event) => {
        stepCount++;
        const inputTk = event.usage?.inputTokens ?? 0;
        const outputTk = event.usage?.outputTokens ?? 0;
        totalInput += inputTk;
        totalOutput += outputTk;
        const toolCalls = event.toolCalls?.map(tc => tc.toolName).join(', ') ?? 'none';
        console.log(`  Step ${stepCount}: +${inputTk}/${outputTk} tokens | tools: ${toolCalls}`);
      },
    });

    const elapsed = Date.now() - startTime;
    console.log(`\n--- Agent completed ---`);
    console.log(`Duration: ${Math.round(elapsed / 1000)}s`);
    console.log(`Steps: ${stepCount}`);
    console.log(`Tokens: ${totalInput} input / ${totalOutput} output`);
    console.log(`Finish reason: ${result.finishReason}`);
    console.log(`Text length: ${result.text?.length ?? 0} chars`);
    console.log(`Tool calls: ${result.steps.flatMap(s => s.toolCalls).length}`);

    if (!result.text || result.text.trim().length === 0) {
      console.log('\n*** EMPTY RESPONSE — this is what causes the "Empty response from model" error ***');
      console.log('Steps with tool calls:');
      for (const step of result.steps) {
        if (step.toolCalls.length > 0) {
          console.log(`  ${step.toolCalls.map(tc => tc.toolName).join(', ')}`);
        }
      }
    } else {
      console.log(`\nFirst 500 chars of output:\n${result.text.slice(0, 500)}`);
    }
  } catch (err: unknown) {
    const elapsed = Date.now() - startTime;
    console.error(`\n*** AGENT FAILED after ${Math.round(elapsed / 1000)}s ***`);
    console.error(`Steps completed: ${stepCount}`);
    console.error(`Tokens used: ${totalInput} input / ${totalOutput} output`);

    if (err instanceof Error) {
      console.error(`\nError type: ${err.constructor.name}`);
      console.error(`Error message: ${err.message}`);
      console.error(`\nStack trace:\n${err.stack}`);

      // Check for nested cause
      if ('cause' in err && err.cause) {
        console.error(`\nCause: ${err.cause}`);
      }
    } else {
      console.error(`Error: ${String(err)}`);
    }
  }

  // 9. Tool call log summary
  console.log(`\nTool call log (${toolCallLog.length} entries):`);
  const toolCounts: Record<string, number> = {};
  for (const entry of toolCallLog) {
    toolCounts[entry.tool] = (toolCounts[entry.tool] ?? 0) + 1;
  }
  for (const [tool, count] of Object.entries(toolCounts)) {
    console.log(`  ${tool}: ${count} calls`);
  }

  await registry.shutdown();
  console.log('\nProxy shut down.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
