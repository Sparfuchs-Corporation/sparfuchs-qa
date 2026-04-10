import { z } from 'zod';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import fg from 'fast-glob';
import type { AgentDefinition, ToolCallLogEntry } from './types.js';

// --- Secret Redaction ---

const SECRET_PATTERNS = [
  // Key=value patterns
  /(?:api[_-]?key|secret|token|password|auth|credential|jwt|bearer)\s*[:=]\s*['"]?[\w\-./+]{8,}['"]?/gi,
  // Known key prefixes
  /(?:sk|pk|rk|xai|AIza|ghp|gho|ghu|ghs|ghr|glpat|AKIA)[a-zA-Z0-9\-_]{10,}/g,
  // Private keys
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  // Connection strings
  /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s'"]+/g,
];

function redactSecrets(content: string, enabled: boolean): string {
  if (!enabled) return content;
  let result = content;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

// --- Filesystem Jail ---

function assertInJail(requestedPath: string, jailRoots: string[]): string {
  const resolved = resolve(requestedPath);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    real = resolved;
  }
  const inJail = jailRoots.some(root => real.startsWith(root + '/') || real === root);
  if (!inJail) {
    throw new Error(
      `BLOCKED: path "${requestedPath}" resolves to "${real}" ` +
      `which is outside allowed directories: ${jailRoots.join(', ')}`
    );
  }
  return real;
}

// --- Sanitized Environment ---

const ALLOWED_ENV_KEYS = ['PATH', 'HOME', 'NODE_ENV', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_EXEC_PATH'];

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

// --- Bash Command Validation ---

const BASH_ALLOW_LIST = new Set([
  'rg', 'cat', 'head', 'tail', 'wc', 'ls', 'find', 'stat', 'file', 'sort', 'uniq', 'diff',
  'git', 'npm', 'npx', 'grep',
]);

const GIT_READONLY_SUBCOMMANDS = new Set([
  'diff', 'log', 'show', 'blame', 'status', 'branch', 'rev-parse', 'ls-files',
  'shortlog', 'describe', 'tag', 'stash', 'remote',
]);

const BASH_BLOCK_LIST = new Set([
  'rm', 'mv', 'cp', 'chmod', 'chown', 'chgrp', 'mkfs', 'dd', 'mount', 'umount',
  'curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp',
  'python', 'python3', 'ruby', 'perl', 'php', 'sh', 'bash', 'zsh',
  'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt',
  'docker', 'kubectl', 'terraform', 'ansible',
  'open', 'xdg-open', 'start',
]);

const GIT_DANGEROUS_FLAGS = new Set(['--force', '-f', '--hard', '--delete', '-D', '--no-verify']);

function validateBashCommand(command: string): { executable: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  const executable = parts[0];
  const args = parts.slice(1);

  if (BASH_BLOCK_LIST.has(executable)) {
    throw new Error(`BLOCKED: "${executable}" is not allowed.`);
  }
  if (!BASH_ALLOW_LIST.has(executable)) {
    throw new Error(
      `BLOCKED: "${executable}" is not on the allow-list. ` +
      `Allowed: ${[...BASH_ALLOW_LIST].join(', ')}`
    );
  }

  if (executable === 'git') {
    const subcommand = args[0];
    if (!subcommand || !GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
      throw new Error(
        `BLOCKED: "git ${subcommand ?? ''}" is not allowed. ` +
        `Read-only: ${[...GIT_READONLY_SUBCOMMANDS].join(', ')}`
      );
    }
    const dangerous = args.filter(a => GIT_DANGEROUS_FLAGS.has(a));
    if (dangerous.length > 0) {
      throw new Error(`BLOCKED: dangerous git flag: ${dangerous.join(', ')}`);
    }
  }

  if (executable === 'npm') {
    const sub = args[0];
    const safeSubs = ['list', 'ls', 'view', 'info', 'explain', 'audit', 'outdated'];
    if (!sub || !safeSubs.includes(sub)) {
      throw new Error(`BLOCKED: "npm ${sub ?? ''}" is not allowed. Use: ${safeSubs.join(', ')}`);
    }
  }

  if (executable === 'npx') {
    const sub = args[0];
    if (!sub || !['tsc', 'tsx'].includes(sub)) {
      throw new Error(`BLOCKED: "npx ${sub ?? ''}" is not allowed. Only: npx tsc, npx tsx`);
    }
  }

  return { executable, args };
}

// --- Tool Factory ---

export interface ToolSetOptions {
  repoRoot: string;
  qaDataRoot: string;
  sessionLogDir: string;
  redactSecretsEnabled: boolean;
  toolCallLog: ToolCallLogEntry[];
}

export function createToolSet(agent: AgentDefinition, options: ToolSetOptions) {
  const jailRoots = [options.repoRoot, options.qaDataRoot, options.sessionLogDir];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Record<string, any> = {};

  // --- Read ---
  tools.Read = {
    description: 'Read a file from the filesystem. Returns contents with line numbers.',
    parameters: z.object({
      file_path: z.string().describe('Absolute path to the file'),
      offset: z.number().optional().describe('Line number to start reading from (0-based)'),
      limit: z.number().optional().describe('Maximum number of lines to read'),
    }),
    execute: async ({ file_path, offset, limit }: { file_path: string; offset?: number; limit?: number }) => {
      options.toolCallLog.push({ tool: 'Read', args: { file_path, offset, limit }, timestamp: new Date().toISOString() });
      try {
        const safePath = assertInJail(file_path, jailRoots);
        if (!existsSync(safePath)) return `Error: File not found: ${file_path}`;
        const stat = statSync(safePath);
        if (stat.isDirectory()) return `Error: ${file_path} is a directory, not a file`;

        const content = readFileSync(safePath, 'utf8');
        const lines = content.split('\n');
        const start = offset ?? 0;
        const end = limit ? start + limit : Math.min(start + 2000, lines.length);
        const slice = lines.slice(start, end);
        const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
        return redactSecrets(numbered, options.redactSecretsEnabled);
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  // --- Grep ---
  tools.Grep = {
    description: 'Search file contents with regex using ripgrep.',
    parameters: z.object({
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('File or directory to search in'),
      glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts")'),
      output_mode: z.enum(['content', 'files_with_matches', 'count']).optional().default('files_with_matches'),
    }),
    execute: async ({ pattern, path, glob: globPattern, output_mode }: { pattern: string; path?: string; glob?: string; output_mode?: string }) => {
      options.toolCallLog.push({ tool: 'Grep', args: { pattern, path, glob: globPattern, output_mode }, timestamp: new Date().toISOString() });
      try {
        const searchPath = path ? assertInJail(path, jailRoots) : options.repoRoot;
        const args = [pattern, searchPath];
        if (globPattern) args.push('--glob', globPattern);
        switch (output_mode) {
          case 'content': args.push('-n', '--heading'); break;
          case 'files_with_matches': args.push('-l'); break;
          case 'count': args.push('-c'); break;
        }
        args.push('--max-count', '250');

        const result = execFileSync('rg', args, {
          encoding: 'utf8',
          env: sanitizedEnv(),
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          cwd: options.repoRoot,
        });
        return redactSecrets(result, options.redactSecretsEnabled);
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 1) {
          return '';  // No matches
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  // --- Glob ---
  tools.Glob = {
    description: 'Find files matching a glob pattern.',
    parameters: z.object({
      pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
      path: z.string().optional().describe('Directory to search in'),
    }),
    execute: async ({ pattern, path }: { pattern: string; path?: string }) => {
      options.toolCallLog.push({ tool: 'Glob', args: { pattern, path }, timestamp: new Date().toISOString() });
      try {
        const searchPath = path ? assertInJail(path, jailRoots) : options.repoRoot;
        const matches = await fg(pattern, {
          cwd: searchPath,
          absolute: true,
          dot: false,
          ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**', '**/.git/**'],
        });
        const safe = matches.filter(m => {
          try { assertInJail(m, jailRoots); return true; } catch { return false; }
        });
        return safe.sort().join('\n');
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };

  // --- Bash (only if agent has it enabled) ---
  if (!agent.disableBash && agent.tools.includes('Bash')) {
    tools.Bash = {
      description: 'Execute a shell command. Only read-only commands are allowed.',
      parameters: z.object({
        command: z.string().describe('The command to execute'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
      }),
      execute: async ({ command, timeout }: { command: string; timeout?: number }) => {
        options.toolCallLog.push({ tool: 'Bash', args: { command }, timestamp: new Date().toISOString() });
        try {
          const { executable, args } = validateBashCommand(command);

          // Validate file path arguments against jail
          for (const arg of args) {
            if (arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../')) {
              assertInJail(arg, jailRoots);
            }
          }

          const result = execFileSync(executable, args, {
            encoding: 'utf8',
            env: sanitizedEnv(),
            timeout: timeout ?? 30_000,
            maxBuffer: 2 * 1024 * 1024,
            cwd: options.repoRoot,
          });
          return redactSecrets(result, options.redactSecretsEnabled);
        } catch (err: unknown) {
          if (err instanceof Error) return `Error: ${err.message}`;
          return `Error: ${String(err)}`;
        }
      },
    };
  }

  return tools;
}
