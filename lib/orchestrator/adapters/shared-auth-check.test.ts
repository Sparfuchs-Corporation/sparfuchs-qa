import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectAuthPrompt } from './shared-auth-check.js';

describe('detectAuthPrompt', () => {
  it('throws on Gemini "Opening authentication page" on stdout', () => {
    assert.throws(
      () => detectAuthPrompt('Opening authentication page in your browser...', ''),
      /gemini CLI hit an interactive auth prompt/,
    );
  });

  it('throws on Gemini auth prompt on stderr', () => {
    assert.throws(
      () => detectAuthPrompt('', 'Opening authentication page in your browser...\n'),
      /stderr/,
    );
  });

  it('throws on Claude "Not authenticated. Run `claude login`"', () => {
    assert.throws(
      () => detectAuthPrompt('', 'Not authenticated. Run `claude login` to continue.\n'),
      /claude CLI hit an interactive auth prompt/,
    );
  });

  it('throws on Codex login prompt', () => {
    assert.throws(
      () => detectAuthPrompt('', 'Please authenticate: run codex login\n'),
      /codex CLI hit an interactive auth prompt/,
    );
  });

  it('throws on generic OAuth URL prompt', () => {
    assert.throws(
      () => detectAuthPrompt('Please visit this URL to authenticate: https://...\n', ''),
      /generic CLI hit an interactive auth prompt/,
    );
  });

  it('does NOT throw on normal agent output', () => {
    assert.doesNotThrow(() => {
      detectAuthPrompt(
        '{"type":"init","session_id":"abc"}\n{"type":"message","role":"assistant","content":"hello"}',
        '',
      );
    });
  });

  it('does NOT throw on empty streams', () => {
    assert.doesNotThrow(() => detectAuthPrompt('', ''));
  });

  it('does NOT throw on normal stderr noise (log lines, warnings)', () => {
    assert.doesNotThrow(() => {
      detectAuthPrompt('output', 'Warning: deprecated flag. Rate limit reset in 30s.\n');
    });
  });

  it('includes the matched phrase in the error for debugging', () => {
    try {
      detectAuthPrompt('', 'Not authenticated. Run `claude login` first.');
      assert.fail('should have thrown');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      assert.ok(msg.includes('Detected phrase'), `error missing detected phrase: ${msg}`);
    }
  });

  it('only scans the head of each stream', () => {
    // Put the auth phrase past the head window — should NOT trigger.
    const filler = 'x'.repeat(3000);
    assert.doesNotThrow(() => {
      detectAuthPrompt('', `${filler}\nOpening authentication page in your browser`);
    });
  });
});
