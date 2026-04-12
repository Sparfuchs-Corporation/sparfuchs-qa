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
      toolLogging: false,  // CLI manages tools internally
      toolControl: false,
    };
  }

  checkCompatibility(agent: AgentDefinition): AgentCliCompatibility {
    // Claude CLI supports everything — full compatibility
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

    // Write system prompt to temp file
    const tmpId = randomBytes(4).toString('hex');
    const systemPromptFile = join(tmpdir(), `sparfuchs-sysprompt-${tmpId}.md`);
    writeFileSync(systemPromptFile, agent.systemPrompt, { mode: 0o600 });

    try {
      const args = [
        '--append-system-prompt-file', systemPromptFile,
        '--add-dir', config.reportsDir ?? config.sessionLogDir,
        '--add-dir', config.qaDataRoot,
        '--permission-mode', 'default',
        delegationPrompt,
      ];

      const text = await spawnCli(this.binary, args, config.repoPath);

      status.durationMs = Date.now() - startTime;

      return {
        text,
        usage: { inputTokens: 0, outputTokens: 0 }, // CLI doesn't expose token counts
        steps: [],
        finishReason: 'stop',
        provider: this.name,
        model: this.binary,
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
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      // Stream stderr to our stderr for live output
      process.stderr.write(data);
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
