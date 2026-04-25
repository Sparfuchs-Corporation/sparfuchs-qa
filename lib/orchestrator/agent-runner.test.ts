import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { isQuotaError } from './agent-runner.js';

describe('isQuotaError', () => {
  it('recognizes Gemini CLI TerminalQuotaError', () => {
    assert.equal(isQuotaError(new Error('TerminalQuotaError: You have exhausted your capacity on this model.')), true);
  });

  it('recognizes generic "quota exceeded" phrasing', () => {
    assert.equal(isQuotaError(new Error('daily quota exceeded, will reset in 4h')), true);
  });

  it('recognizes Google RESOURCE_EXHAUSTED', () => {
    assert.equal(isQuotaError(new Error('RESOURCE_EXHAUSTED: 429 Too Many Requests')), true);
  });

  it('recognizes Codex "hit your usage limit" phrasing', () => {
    assert.equal(
      isQuotaError(new Error("codex exited with code 1: You've hit your usage limit. To get more access now, try again at 3:04 PM.")),
      true,
    );
  });

  it('recognizes OpenAI insufficient_quota', () => {
    assert.equal(isQuotaError(new Error('Error 429: insufficient_quota')), true);
  });

  it('recognizes "exceeded your current quota"', () => {
    assert.equal(isQuotaError(new Error('You have exceeded your current quota, please check your plan.')), true);
  });

  it('does NOT match transient rate-limit errors without quota language', () => {
    assert.equal(isQuotaError(new Error('429 Too Many Requests: rate limited')), false);
  });

  it('does NOT match auth errors', () => {
    assert.equal(isQuotaError(new Error('401 Unauthorized')), false);
  });

  it('does NOT match non-Error values', () => {
    assert.equal(isQuotaError('some string'), false);
    assert.equal(isQuotaError(null), false);
    assert.equal(isQuotaError(undefined), false);
  });
});
