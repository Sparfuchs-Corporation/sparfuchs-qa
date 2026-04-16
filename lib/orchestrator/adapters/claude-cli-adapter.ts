import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent,
} from '../types.js';
import { detectCli, type AgentAdapter } from './index.js';
import { parseStreamJson } from './stream-json-parser.js';

export class ClaudeCliAdapter implements AgentAdapter {
  readonly name = 'claude-cli' as const;
  readonly type = 'cli' as const;
  readonly binary = 'claude';

  detect(): DetectionResult {
    return detectCli(this.binary);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      systemPromptFile: true,
      addDir: true,
      agentDeployment: true,
      toolLogging: true,
      toolControl: false,
      observabilityLevel: 'structured',
    };
  }

  checkCompatibility(agent: AgentDefinition): AgentCliCompatibility {
    return { agentName: agent.name, status: 'full', adaptations: [] };
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

    const tmpId = randomBytes(4).toString('hex');
    const systemPromptFile = join(tmpdir(), `sparfuchs-sysprompt-${tmpId}.md`);
    writeFileSync(systemPromptFile, agent.systemPrompt, { mode: 0o600 });

    try {
      const args = [
        '--print',
        '--verbose',                        // required for --output-format stream-json
        '--output-format', 'stream-json',
        '--append-system-prompt-file', systemPromptFile,
        '--add-dir', config.reportsDir ?? config.sessionLogDir,
        '--add-dir', config.qaDataRoot,
        '--permission-mode', 'bypassPermissions',
        delegationPrompt,                    // positional prompt — last arg
      ];

      const rawOutput = await spawnCli(this.binary, args, config.repoPath);
      const parsed = parseStreamJson(rawOutput);

      status.durationMs = Date.now() - startTime;

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
    } finally {
      try { unlinkSync(systemPromptFile); } catch { /* already cleaned */ }
    }
  }
}

function spawnCli(binary: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],   // ignore stdin — no pipe, no 3s wait
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${binary} exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });
  });
}
