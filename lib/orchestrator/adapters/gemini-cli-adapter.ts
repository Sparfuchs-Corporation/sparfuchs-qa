import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  AgentDefinition, AgentRunResult, AgentRunStatus,
  OrchestrationConfig, AdapterCapabilities,
  AgentCliCompatibility, DetectionResult, FallbackEvent,
} from '../types.js';
import { detectCli, type AgentAdapter, type AuthCheckResult } from './index.js';
import { parseStreamJson } from './stream-json-parser.js';
import { resolveApiKey } from '../credential-store.js';

// Env-var name Gemini CLI reads. The keychain entry name matches so a single
// `security add-generic-password -s sparfuchs-qa -a GEMINI_API_KEY -w ...`
// satisfies both the pre-flight check and the child process at spawn time.
const GEMINI_API_KEY_NAME = 'GEMINI_API_KEY';

export class GeminiCliAdapter implements AgentAdapter {
  readonly name = 'gemini-cli' as const;
  readonly type = 'cli' as const;
  readonly binary = 'gemini';

  detect(): DetectionResult {
    return detectCli(this.binary);
  }

  checkAuth(): AuthCheckResult {
    // Gemini CLI has three non-interactive auth paths, in priority order:
    //   1. OS keychain entry under service 'sparfuchs-qa', account
    //      GEMINI_API_KEY — resolved at spawn time and injected into the
    //      child process env.
    //   2. Shell env var (GEMINI_API_KEY / GOOGLE_API_KEY /
    //      GOOGLE_GENERATIVE_AI_API_KEY) — forwarded via env inheritance.
    //   3. Cached OAuth at ~/.gemini/oauth_creds.json — accepted ONLY when
    //      expiry_date is in the future or a refresh_token is present. A
    //      stale file (neither condition) is rejected because gemini CLI
    //      will re-prompt interactively for auth.
    const keychain = resolveApiKey(GEMINI_API_KEY_NAME, GEMINI_API_KEY_NAME);
    if (keychain && keychain.source === 'keychain') {
      return { authenticated: true, method: `keychain:${GEMINI_API_KEY_NAME}` };
    }

    const apiKeyVars = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'];
    for (const envVar of apiKeyVars) {
      if (process.env[envVar]) {
        return { authenticated: true, method: `env:${envVar}` };
      }
    }

    const oauthPath = join(homedir(), '.gemini', 'oauth_creds.json');
    const oauthStatus = inspectOAuthCache(oauthPath);
    if (oauthStatus.usable) {
      return { authenticated: true, method: `oauth-cache:${oauthStatus.label}` };
    }

    const plat = process.platform;
    const storeHint = plat === 'darwin'
      ? 'security add-generic-password -s sparfuchs-qa -a GEMINI_API_KEY -w \'<your-key>\''
      : plat === 'linux'
        ? 'echo \'<your-key>\' | secret-tool store --label=sparfuchs-qa service sparfuchs-qa key GEMINI_API_KEY'
        : 'Use your OS keychain manager to store a sparfuchs-qa / GEMINI_API_KEY entry';
    return {
      authenticated: false,
      suggestion:
        'Gemini CLI has no verified non-interactive credentials. Pick one:\n' +
        `  (1) Store in OS keychain (recommended — same slot the rest of the toolkit uses):\n` +
        `      ${storeHint}\n` +
        '  (2) export GEMINI_API_KEY=<your-key>   # shell env var fallback\n' +
        (oauthStatus.reason
          ? `  (3) OAuth cache at ${oauthPath}:\n      ${oauthStatus.reason}\n      ` +
            'To use this path, run `gemini` interactively again and re-run.\n'
          : '  (3) run `gemini` interactively once — caches OAuth creds at ~/.gemini/oauth_creds.json\n'),
    };
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

    if (agent.systemPrompt) {
      adaptations.push('System prompt inlined into user prompt');
    }

    adaptations.push('@agent-name references stripped (Gemini CLI does not support agent deployment)');

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

    // Tier-aware model selection. Reuses the google-tier model IDs from
    // models.yaml (tiers.{light,mid,heavy}.google) so gemini-cli picks Flash
    // / Flash-Lite for light agents rather than defaulting to Pro. Light
    // agents are static-analysis grep/read work — Flash-Lite is ~3-5× faster
    // than Pro with indistinguishable quality for that workload.
    const tierModel = config.modelsConfig.tiers[agent.tier]?.google;
    const model = tierModel || process.env.GEMINI_CLI_MODEL;

    const combinedPrompt = buildInlinedPrompt(agent.systemPrompt, delegationPrompt);

    // Gemini CLI 0.38+ quirks that took a full debugging session to nail down:
    //   1. `-p ''` is rejected: "Not enough arguments following: p" — pass the
    //      full prompt as the value of -p instead of piping via stdin.
    //   2. Multiple `--include-directories DIR` flags are rejected despite the
    //      help text claiming "comma-separated or multiple" — only the
    //      comma-separated form works. Repeating the flag errors with
    //      "Not enough arguments following: include-directories".
    //   3. Never use "--flag=value" — Gemini's argv parser rejects the `=`
    //      delimiter on these flags.
    //   4. --sandbox is intentionally OMITTED: when enabled, writes to
    //      qa-reports/ fail silently and agents report "unable to write"
    //      after completing real analysis. --yolo already auto-approves
    //      tool calls so this loses no additional confirmation guardrails.
    const includeDirs = [
      config.reportsDir ?? config.sessionLogDir,
      config.qaDataRoot,
    ].join(',');
    const args = [
      '--yolo',
      '--output-format', 'stream-json',
      '--include-directories', includeDirs,
      ...(model ? ['-m', model] : []),
      '-p', combinedPrompt,
    ];

    // Inject keychain-resolved API key into the child env. Without this,
    // gemini will not see a key stored only in the OS keychain and will
    // fall back to the interactive OAuth prompt.
    const childEnv: Record<string, string | undefined> = { ...process.env };
    if (!childEnv[GEMINI_API_KEY_NAME]) {
      const resolved = resolveApiKey(GEMINI_API_KEY_NAME, GEMINI_API_KEY_NAME);
      if (resolved) {
        childEnv[GEMINI_API_KEY_NAME] = resolved.value;
      }
    }

    const rawOutput = await spawnCli(this.binary, args, config.repoPath, childEnv);

    // Gemini CLI exits 0 even when it hits an interactive OAuth prompt and
    // never ran the model. Detect that pattern and fail loudly instead of
    // recording a fake-success agent run.
    detectAuthPrompt(rawOutput);

    const parsed = parseStreamJson(rawOutput);

    status.durationMs = Date.now() - startTime;

    const text = parsed.text || rawOutput;

    // Silent-refusal guard. Only throw when BOTH the parser recovered nothing
    // AND the raw stdout is too short to contain real work (<200 bytes is
    // less than any real agent response). Gemini's stream schema can drift
    // in minor versions and leave parsed.text empty while rawOutput still
    // holds the full response — we fall back to rawOutput downstream, so
    // rawOutput length is the authoritative signal here.
    const MIN_RAW_OUTPUT_BYTES = 200;
    if (
      parsed.toolCallLog.length === 0
      && parsed.text.trim().length === 0
      && rawOutput.trim().length < MIN_RAW_OUTPUT_BYTES
    ) {
      throw new Error(
        `gemini returned effectively empty output ` +
        `(0 tool calls, 0 parsed text, ${rawOutput.length} raw bytes). ` +
        `Usually a silent auth / quota / network refusal. ` +
        `Fixes: (1) store GEMINI_API_KEY in OS keychain (see make qa-keys-setup), or ` +
        `(2) run \`gemini\` once interactively to refresh OAuth credentials. ` +
        `Raw output sample: ${rawOutput.slice(0, 300)}`,
      );
    }

    return {
      text,
      usage: parsed.usage.inputTokens > 0
        ? parsed.usage
        : { inputTokens: 0, outputTokens: 0 },
      steps: [],
      toolCallLog: parsed.toolCallLog,
      finishReason: 'stop',
      provider: this.name,
      model: parsed.model ?? model ?? this.binary,
    };
  }
}

interface OAuthStatus {
  usable: boolean;
  /** Short label used in the method string ("expires-in-42m" etc.) */
  label?: string;
  /** Explanation when not usable */
  reason?: string;
}

/**
 * Decide whether ~/.gemini/oauth_creds.json can stand in for an API key.
 * Accepts the file when either:
 *   - `expiry_date` (ms since epoch) is in the future, OR
 *   - a `refresh_token` is present (Gemini CLI can silently refresh).
 * Everything else — file missing, malformed JSON, expired access token
 * with no refresh token — is rejected so the pre-flight fails fast.
 */
function inspectOAuthCache(path: string): OAuthStatus {
  if (!existsSync(path)) {
    return { usable: false };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { usable: false, reason: `file exists but is not valid JSON: ${msg}` };
  }

  const expiryDate = typeof parsed.expiry_date === 'number' ? parsed.expiry_date : null;
  const hasRefresh = typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0;
  const now = Date.now();

  if (expiryDate && expiryDate > now) {
    const mins = Math.round((expiryDate - now) / 60_000);
    return { usable: true, label: `expires-in-${mins}m` };
  }
  if (hasRefresh) {
    // Access token may be stale but CLI can refresh silently via refresh_token.
    return { usable: true, label: 'refresh-token' };
  }
  if (expiryDate && expiryDate <= now) {
    const minsAgo = Math.round((now - expiryDate) / 60_000);
    return {
      usable: false,
      reason: `access_token expired ${minsAgo}m ago and no refresh_token is present.`,
    };
  }
  return { usable: false, reason: 'no expiry_date or refresh_token in file.' };
}

// Phrases Gemini CLI emits when it falls back to an interactive auth flow.
// These are the unambiguous fingerprints of a non-interactive OAuth attempt.
const AUTH_PROMPT_PATTERNS = [
  /Opening authentication page in your browser/i,
  /Do you want to continue\?\s*\[Y\/n\]/i,
  /Authentication cancelled by user/i,
  /FatalCancellationError/i,
];

function detectAuthPrompt(rawOutput: string): void {
  // Only scan the first ~1KB — if auth prompts appear, they're always at the
  // head of stdout before any JSON events arrive.
  const head = rawOutput.slice(0, 1024);
  for (const pat of AUTH_PROMPT_PATTERNS) {
    if (pat.test(head)) {
      throw new Error(
        `gemini CLI hit an interactive authentication prompt and cannot run ` +
        `under the orchestrator. Fix either: ` +
        `(1) export GEMINI_API_KEY=<your-key> in the shell, or ` +
        `(2) run \`gemini\` once interactively to cache OAuth credentials, ` +
        `then retry. Detected prompt: ${head.trim().slice(0, 200)}`,
      );
    }
  }
}

function buildInlinedPrompt(systemPrompt: string, userPrompt: string): string {
  // IMPORTANT: delimiters must NOT start with "---". Gemini CLI's argv parser
  // treats a leading "---" in the -p value as a flag-end sentinel and rejects
  // the invocation with "Not enough arguments following: prompt", even when
  // -p is otherwise valid. Using "===" avoids that interpretation.
  return (
    `=== SYSTEM INSTRUCTIONS (follow these throughout your analysis) ===\n` +
    `${systemPrompt}\n` +
    `=== END SYSTEM INSTRUCTIONS ===\n\n` +
    `${userPrompt}`
  );
}

function spawnCli(
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
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
