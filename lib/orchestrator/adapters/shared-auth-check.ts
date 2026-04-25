// shared-auth-check — cross-adapter detection of interactive CLI auth
// prompts. Called by every CLI adapter after spawn completes.
//
// CLI providers exit 0 in several failure modes that should NOT be
// silently treated as success:
//   - Gemini CLI hits an OAuth flow and prints "Opening authentication page"
//     to stdout, then exits 0 after a cancel.
//   - Claude CLI and Codex CLI print "Not authenticated. Run `X login`" to
//     stderr and exit 0 with an empty stdout.
//   - Openclaw prints a login prompt on stderr.
//
// detectAuthPrompt inspects the head of BOTH streams (stderr too — the
// pre-Phase 5 gemini-cli check only scanned stdout, which missed the most
// common variants) and throws a loud error with remediation hints.

const HEAD_BYTES = 2048;

interface AuthPattern {
  /** Regex that identifies the interactive-auth condition. */
  pattern: RegExp;
  /** Which provider this phrase points to. Used in the thrown message. */
  provider: 'gemini' | 'claude' | 'codex' | 'openclaw' | 'generic';
  /** Short remediation hint appended to the error. */
  hint: string;
}

const AUTH_PATTERNS: readonly AuthPattern[] = [
  // Gemini CLI
  {
    pattern: /Opening authentication page in your browser/i,
    provider: 'gemini',
    hint: 'Set GEMINI_API_KEY or run `gemini` once interactively to cache OAuth.',
  },
  {
    pattern: /Do you want to continue\?\s*\[Y\/n\]/i,
    provider: 'gemini',
    hint: 'Set GEMINI_API_KEY in env / keychain; the orchestrator cannot answer interactive prompts.',
  },
  {
    pattern: /Authentication cancelled by user/i,
    provider: 'gemini',
    hint: 'OAuth was cancelled — cache valid credentials before retrying.',
  },
  {
    pattern: /FatalCancellationError/i,
    provider: 'gemini',
    hint: 'OAuth cancelled / missing — cache credentials before retrying.',
  },
  // Claude CLI
  {
    pattern: /Not authenticated[\s\S]{0,80}claude\s+login/i,
    provider: 'claude',
    hint: 'Run `claude login` once to cache credentials, or set ANTHROPIC_API_KEY.',
  },
  {
    pattern: /Please log in to continue/i,
    provider: 'claude',
    hint: 'Run `claude login` interactively.',
  },
  // Codex CLI
  {
    pattern: /codex(?:-cli)?\s+login|Please authenticate/i,
    provider: 'codex',
    hint: 'Run `codex login` or set OPENAI_API_KEY.',
  },
  // Openclaw
  {
    pattern: /openclaw[\s\S]{0,40}(?:login|authenticate)/i,
    provider: 'openclaw',
    hint: 'Run `openclaw login` interactively before orchestrator runs.',
  },
  // Generic
  {
    pattern: /Please visit (?:this URL|the following URL) to authenticate/i,
    provider: 'generic',
    hint: 'Complete OAuth interactively once, then retry.',
  },
];

/**
 * Throws with a loud, actionable error if either stream contains an
 * interactive-auth prompt. Safe to call on every adapter's spawn result —
 * fast regex scan over the first 2KB of each stream.
 */
export function detectAuthPrompt(stdout: string, stderr: string): void {
  const streams: Array<{ name: 'stdout' | 'stderr'; head: string }> = [
    { name: 'stdout', head: stdout.slice(0, HEAD_BYTES) },
    { name: 'stderr', head: stderr.slice(0, HEAD_BYTES) },
  ];
  for (const { name, head } of streams) {
    if (!head) continue;
    for (const { pattern, provider, hint } of AUTH_PATTERNS) {
      if (pattern.test(head)) {
        throw new Error(
          `${provider} CLI hit an interactive auth prompt (detected on ${name}) and cannot run ` +
          `under the orchestrator. ${hint} ` +
          `Detected phrase: ${head.match(pattern)?.[0]?.slice(0, 120) ?? '[matched]'}`,
        );
      }
    }
  }
}
