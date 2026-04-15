import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent,
} from '../types.js';
import { detectCli, type AgentAdapter } from './index.js';

export class CodexCliAdapter implements AgentAdapter {
  readonly name = 'codex-cli' as const;
  readonly type = 'cli' as const;
  readonly binary = 'codex';

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
    };
  }

  checkCompatibility(agent: AgentDefinition): AgentCliCompatibility {
    const adaptations: string[] = [];

    if (agent.systemPrompt) {
      adaptations.push('System prompt inlined into user prompt');
    }

    adaptations.push('@agent-name references stripped (Codex CLI does not support agent deployment)');

    if (agent.disableBash) {
      adaptations.push('WARNING: disableBash not enforceable — Codex CLI manages its own tool access');
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

    const combinedPrompt = buildInlinedPrompt(agent.systemPrompt, delegationPrompt);
    const tmpId = randomBytes(4).toString('hex');
    const outputFile = join(tmpdir(), `sparfuchs-codex-last-message-${tmpId}.txt`);

    try {
      const args = [
        'exec',
        '--json',
        '--full-auto',
        '--add-dir', config.reportsDir ?? config.sessionLogDir,
        '--add-dir', config.qaDataRoot,
        '-o', outputFile,
        '-',
      ];
      const execution = await spawnCli(this.binary, args, config.repoPath, combinedPrompt);
      const text = readFileSync(outputFile, 'utf8').trim();

      status.durationMs = Date.now() - startTime;
      status.tokenUsage.input = execution.usage.inputTokens;
      status.tokenUsage.output = execution.usage.outputTokens;

      return {
        text,
        usage: execution.usage,
        steps: [],
        toolCallLog: [],
        finishReason: 'stop',
        provider: this.name,
        model: this.binary,
      };
    } finally {
      try { unlinkSync(outputFile); } catch { /* already cleaned */ }
    }
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
): Promise<{ usage: { inputTokens: number; outputTokens: number } }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    let usage = { inputTokens: 0, outputTokens: 0 };

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as {
            type?: string;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          if (event.type === 'turn.completed' && event.usage) {
            usage = {
              inputTokens: event.usage.input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
            };
          }
        } catch {
          // Ignore non-JSON lines; Codex may emit informational text on stdout.
        }
      }
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve({ usage });
      else reject(new Error(`${binary} exited with code ${code}: ${stderr.slice(0, 500)}`));
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });

    proc.stdin.write(stdinInput);
    proc.stdin.end();
  });
}
