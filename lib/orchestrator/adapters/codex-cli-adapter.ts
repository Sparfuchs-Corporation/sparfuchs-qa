import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent,
  ToolCallLogEntry,
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
      observabilityLevel: 'structured',
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

      // Synthesize Read/Write entries for shell + apply_patch tool uses so
      // the coverage babysitter (which doesn't know codex's vocabulary)
      // credits file access. Original entries are preserved for observability.
      const synthesized = expandCodexFileOps(execution.toolCallLog, config.repoPath);

      return {
        text,
        usage: execution.usage,
        steps: [],
        toolCallLog: [...execution.toolCallLog, ...synthesized],
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

interface CodexSpawnResult {
  usage: { inputTokens: number; outputTokens: number };
  toolCallLog: ToolCallLogEntry[];
}

function spawnCli(
  binary: string,
  args: string[],
  cwd: string,
  stdinInput: string,
): Promise<CodexSpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stderr = '';
    let usage = { inputTokens: 0, outputTokens: 0 };
    const toolCallLog: ToolCallLogEntry[] = [];

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;

          // Extract token usage from turn.completed events
          if (event.type === 'turn.completed') {
            const eventUsage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            if (eventUsage) {
              usage = {
                inputTokens: eventUsage.input_tokens ?? 0,
                outputTokens: eventUsage.output_tokens ?? 0,
              };
            }
          }

          // Extract tool calls from function_call / tool_use events
          if (event.type === 'function_call' || event.type === 'tool_use') {
            const name = (event.name ?? event.function ?? '') as string;
            const input = (event.input ?? event.arguments ?? {}) as Record<string, unknown>;
            if (name) {
              toolCallLog.push({
                tool: name,
                args: typeof input === 'string' ? parseJsonSafe(input) : input,
                timestamp: new Date().toISOString(),
              });
            }
          }

          // Also check for tool calls nested in message content
          if (event.type === 'message' || event.type === 'response') {
            const content = event.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }> | undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_use' && block.name) {
                  toolCallLog.push({
                    tool: block.name,
                    args: block.input ?? {},
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }
          }
        } catch {
          // Ignore non-JSON lines; Codex may emit informational text on stdout.
        }
      }
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) resolve({ usage, toolCallLog });
      else reject(new Error(`${binary} exited with code ${code}: ${stderr.slice(0, 500)}`));
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ${binary}: ${err.message}`));
    });

    proc.stdin.write(stdinInput);
    proc.stdin.end();
  });
}

function parseJsonSafe(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return { _raw: str };
  }
}

// --- Codex tool-use → babysitter vocabulary translation ---
//
// Codex exposes file access primarily through `shell` (with commands like
// `cat`, `grep`, `sed`, `rg`) and `apply_patch` (unified-diff style patch
// application). The coverage babysitter only speaks Claude / Gemini tool
// names (Read, Grep, Glob, read_file, ...), so we synthesize equivalent
// Read-style entries per file path mentioned. False positives are filtered
// downstream by Set.has() against allSourceFiles, so erring wide is safe.

// Commands that consume individual files — treat each non-flag positional
// argument as a Read.
const READ_LIKE_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'wc',
  'md5', 'md5sum', 'sha1sum', 'sha256sum', 'stat', 'file',
  'xxd', 'hexdump', 'od',
]);

// Commands that scan a directory — treat the first non-flag positional arg
// as a Grep-like scan.
const SCAN_LIKE_COMMANDS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ripgrep',
  'find', 'fd', 'ls', 'tree',
]);

function expandCodexFileOps(
  entries: ReadonlyArray<ToolCallLogEntry>,
  repoPath: string,
): ToolCallLogEntry[] {
  const out: ToolCallLogEntry[] = [];
  const ts = new Date().toISOString();
  for (const e of entries) {
    if (e.tool === 'shell') {
      const command = extractShellCommand(e.args);
      if (!command || command.length === 0) continue;
      const cmdName = basenameOf(command[0] ?? '');
      const positional = command.slice(1).filter(a => !a.startsWith('-') && a.length > 0);
      if (READ_LIKE_COMMANDS.has(cmdName)) {
        for (const p of positional) {
          out.push({ tool: 'Read', args: { file_path: resolvePath(repoPath, p) }, timestamp: ts });
        }
      } else if (SCAN_LIKE_COMMANDS.has(cmdName)) {
        // Treat every directory-like positional as a Grep scan; babysitter
        // expands this to every file under the path.
        for (const p of positional) {
          out.push({ tool: 'Grep', args: { path: resolvePath(repoPath, p) }, timestamp: ts });
        }
      } else {
        // Unknown shell command: fall back to Read on any arg that looks
        // like a file path. Better to over-credit than miss real accesses.
        for (const p of positional) {
          if (p.includes('/') || p.includes('.')) {
            out.push({ tool: 'Read', args: { file_path: resolvePath(repoPath, p) }, timestamp: ts });
          }
        }
      }
      continue;
    }
    if (e.tool === 'apply_patch') {
      const patchText = extractPatchText(e.args);
      if (!patchText) continue;
      for (const path of parseApplyPatchPaths(patchText)) {
        out.push({ tool: 'Write', args: { file_path: resolvePath(repoPath, path) }, timestamp: ts });
      }
      continue;
    }
  }
  return out;
}

function extractShellCommand(args: unknown): string[] | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (Array.isArray(a.command)) return a.command.map(String);
  if (typeof a.command === 'string') return a.command.split(/\s+/).filter(Boolean);
  return null;
}

function extractPatchText(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  if (typeof a.input === 'string') return a.input;
  if (typeof a.patch === 'string') return a.patch;
  return null;
}

function parseApplyPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  // Codex / Claude custom format: "*** Add File: path", "*** Update File: path", "*** Delete File: path"
  const fileOp = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gm;
  let m;
  while ((m = fileOp.exec(patch)) !== null) {
    paths.push(m[1].trim());
  }
  // Unified diff markers: "--- a/path", "+++ b/path"
  const diffMarker = /^[-+]{3}\s+[ab]\/(.+)$/gm;
  while ((m = diffMarker.exec(patch)) !== null) {
    paths.push(m[1].trim());
  }
  return [...new Set(paths)];
}

function basenameOf(cmd: string): string {
  const ix = cmd.lastIndexOf('/');
  return ix >= 0 ? cmd.slice(ix + 1) : cmd;
}
