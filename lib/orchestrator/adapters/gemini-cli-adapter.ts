import { spawn } from 'node:child_process';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent,
} from '../types.js';
import { detectCli, type AgentAdapter } from './index.js';
import { parseStreamJson } from './stream-json-parser.js';

// Agents that require --add-dir for qa-data or external references
const ADDDIR_REQUIRED_AGENTS = new Set([
  'ref-doc-verifier',
  'workflow-extractor',
]);

export class GeminiCliAdapter implements AgentAdapter {
  readonly name = 'gemini-cli' as const;
  readonly type = 'cli' as const;
  readonly binary = 'gemini';

  detect(): DetectionResult {
    return detectCli(this.binary);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      systemPromptFile: false,
      addDir: true,
      agentDeployment: false,
      toolLogging: true,
      toolControl: false,
      observabilityLevel: 'structured',
    };
  }

  checkCompatibility(agent: AgentDefinition, config: OrchestrationConfig): AgentCliCompatibility {
    const adaptations: string[] = [];

    // System prompt must be inlined
    if (agent.systemPrompt) {
      adaptations.push('System prompt inlined into user prompt');
    }

    // @agent-name references won't work — adapted but functional
    adaptations.push('@agent-name references stripped (Gemini CLI does not support agent deployment)');

    // disableBash agents: CLI may still allow bash — warning
    if (agent.disableBash) {
      adaptations.push('WARNING: disableBash not enforceable — Gemini CLI manages its own tool access');
    }

    return {
      agentName: agent.name,
      status: adaptations.length > 0 ? 'adapted' : 'full',
      adaptations,
    };
  }

  async run(
    agent: AgentDefinition,
    delegationPrompt: string,
    config: OrchestrationConfig,
    status: AgentRunStatus,
    onStatusChange: (s: AgentRunStatus) => void,
    _onFallback: (e: FallbackEvent) => void,
  ): Promise<AgentRunResult> {
    const startTime = Date.now();
    status.status = 'running';
    status.startedAt = new Date().toISOString();
    onStatusChange(status);

    // Inline system prompt since Gemini CLI doesn't support system prompt files
    const combinedPrompt = buildInlinedPrompt(agent.systemPrompt, delegationPrompt);

    // Prompt is passed via stdin to avoid arg-length limits.
    // --yolo auto-approves all tool use (no terminal for approval in headless mode).
    // -p with stdin: Gemini appends stdin to the -p value.
    const args = [
      '--sandbox',
      '--yolo',
      '--output-format', 'stream-json',
      '--include-directories', config.reportsDir ?? config.sessionLogDir,
      '--include-directories', config.qaDataRoot,
    ];

    const rawOutput = await spawnCli(this.binary, args, config.repoPath, combinedPrompt);
    const parsed = parseStreamJson(rawOutput);

    status.durationMs = Date.now() - startTime;

    // Fallback: if stream-json parsing yielded no text, use raw output
    const text = parsed.text || rawOutput;

    return {
      text,
      usage: parsed.usage.inputTokens > 0
        ? parsed.usage
        : { inputTokens: 0, outputTokens: 0 },
      steps: [],
      toolCallLog: parsed.toolCallLog,
      finishReason: 'stop',
      provider: this.name,
      model: parsed.model ?? this.binary,
    };
  }
}

function buildInlinedPrompt(systemPrompt: string, userPrompt: string): string {
  return (
    `--- SYSTEM INSTRUCTIONS (follow these throughout your analysis) ---\n` +
    `${systemPrompt}\n` +
    `--- END SYSTEM INSTRUCTIONS ---\n\n` +
    `${userPrompt}`
  );
}

function spawnCli(
  binary: string,
  args: string[],
  cwd: string,
  stdinInput: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${binary} exited with code ${code}: ${stderr.slice(0, 500)}`));
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });

    // Write prompt via stdin and close — avoids arg-length limits
    proc.stdin.write(stdinInput);
    proc.stdin.end();
  });
}
