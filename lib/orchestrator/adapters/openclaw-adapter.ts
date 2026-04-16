import { spawn } from 'node:child_process';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent,
} from '../types.js';
import { detectCli, type AgentAdapter } from './index.js';

const ADDDIR_REQUIRED_AGENTS = new Set([
  'ref-doc-verifier',
  'workflow-extractor',
]);

export class OpenClawAdapter implements AgentAdapter {
  readonly name = 'openclaw' as const;
  readonly type = 'cli' as const;
  readonly binary = 'openclaw';

  detect(): DetectionResult {
    return detectCli(this.binary);
  }

  getCapabilities(): AdapterCapabilities {
    return {
      systemPromptFile: false,
      addDir: false,
      agentDeployment: false,
      toolLogging: false,
      toolControl: false,
    };
  }

  checkCompatibility(agent: AgentDefinition, config: OrchestrationConfig): AgentCliCompatibility {
    const adaptations: string[] = [];

    if (agent.systemPrompt) {
      adaptations.push('System prompt inlined into user prompt');
    }

    if (ADDDIR_REQUIRED_AGENTS.has(agent.name) && config.claimsManifestPath) {
      return {
        agentName: agent.name,
        status: 'skipped',
        adaptations: [],
        skipReason: 'Requires --add-dir for qa-data (not supported by OpenClaw)',
      };
    }

    adaptations.push('@agent-name references stripped (OpenClaw does not support agent deployment)');

    if (agent.disableBash) {
      adaptations.push('WARNING: disableBash not enforceable — OpenClaw manages its own tool access');
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

    // OpenClaw accepts a prompt directly
    const args = [combinedPrompt];
    const text = await spawnCli(this.binary, args, config.repoPath);

    status.durationMs = Date.now() - startTime;

    return {
      text,
      usage: { inputTokens: 0, outputTokens: 0 },
      steps: [],
      toolCallLog: [],
      finishReason: 'stop',
      provider: this.name,
      model: this.binary,
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

function spawnCli(binary: string, args: string[], cwd: string): Promise<string> {
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
  });
}
