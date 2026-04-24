import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseStreamJson } from './stream-json-parser.js';

// Gemini CLI's --output-format stream-json emits top-level events:
//   init / message(user|assistant, delta?) / tool_use(tool_name, parameters) /
//   tool_result / result(stats)
// The fixture below is distilled from a real qa-review run
// (qa-reports/2026-04-23_2317_.../18-23-41_code-reviewer-chunk-2.md).
const GEMINI_FIXTURE = [
  '{"type":"init","timestamp":"2026-04-24T00:23:13.858Z","session_id":"abc","model":"gemini-3.1-pro-preview"}',
  '{"type":"message","timestamp":"2026-04-24T00:23:13.859Z","role":"user","content":"prompt body"}',
  '{"type":"tool_use","timestamp":"2026-04-24T00:23:19.765Z","tool_name":"run_shell_command","tool_id":"t1","parameters":{"command":"git diff --name-only HEAD"}}',
  '{"type":"tool_result","timestamp":"2026-04-24T00:23:20.035Z","tool_id":"t1","status":"success"}',
  '{"type":"tool_use","timestamp":"2026-04-24T00:23:32.613Z","tool_name":"write_file","tool_id":"t2","parameters":{"file_path":"/tmp/out.md","content":"# Report"}}',
  '{"type":"tool_result","timestamp":"2026-04-24T00:23:32.627Z","tool_id":"t2","status":"success"}',
  '{"type":"message","timestamp":"2026-04-24T00:23:39.616Z","role":"assistant","content":"I have completed the review","delta":true}',
  '{"type":"message","timestamp":"2026-04-24T00:23:39.764Z","role":"assistant","content":" of the assigned files.","delta":true}',
  '{"type":"result","timestamp":"2026-04-24T00:23:41.264Z","status":"success","stats":{"total_tokens":87582,"input_tokens":85717,"output_tokens":831,"cached":56288,"duration_ms":27406,"tool_calls":2}}',
].join('\n');

// Claude CLI / Anthropic schema — nested content blocks and usage under .usage.
// Must continue to parse correctly after the additive Gemini changes.
const ANTHROPIC_FIXTURE = [
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [
        { type: 'text', text: 'Analyzing the codebase.' },
        { type: 'tool_use', name: 'Read', id: 'toolu_1', input: { file_path: '/repo/src/index.ts' } },
      ],
      usage: { input_tokens: 500, output_tokens: 120 },
    },
  }),
  JSON.stringify({
    type: 'content_block_start',
    content_block: { type: 'tool_use', name: 'Grep', id: 'toolu_2' },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'input_json_delta', partial_json: '{"pattern":"TODO"' },
  }),
  JSON.stringify({
    type: 'content_block_delta',
    delta: { type: 'input_json_delta', partial_json: ',"path":"/repo/src"}' },
  }),
  JSON.stringify({ type: 'content_block_stop' }),
  JSON.stringify({
    type: 'result',
    result: 'Done.',
    usage: { input_tokens: 50, output_tokens: 10 },
  }),
].join('\n');

describe('parseStreamJson — Gemini CLI schema', () => {
  const parsed = parseStreamJson(GEMINI_FIXTURE);

  it('extracts every tool_use event into toolCallLog', () => {
    assert.equal(parsed.toolCallLog.length, 2);
    assert.equal(parsed.toolCallLog[0].tool, 'run_shell_command');
    assert.deepEqual(parsed.toolCallLog[0].args, { command: 'git diff --name-only HEAD' });
    assert.equal(parsed.toolCallLog[1].tool, 'write_file');
    assert.equal(parsed.toolCallLog[1].args.file_path, '/tmp/out.md');
  });

  it('concatenates assistant message content chunks in order', () => {
    assert.equal(parsed.text, 'I have completed the review of the assigned files.');
  });

  it('skips user messages (they are prompt echoes, not responses)', () => {
    assert.ok(!parsed.text.includes('prompt body'));
  });

  it('reads token usage from result.stats when result.usage is absent', () => {
    assert.equal(parsed.usage.inputTokens, 85717);
    assert.equal(parsed.usage.outputTokens, 831);
  });

  it('captures model from the init event', () => {
    assert.equal(parsed.model, 'gemini-3.1-pro-preview');
  });
});

describe('parseStreamJson — Anthropic schema (no regression)', () => {
  const parsed = parseStreamJson(ANTHROPIC_FIXTURE);

  it('extracts tool_use from assistant.content blocks and from content_block_start/stop', () => {
    assert.equal(parsed.toolCallLog.length, 2);
    assert.equal(parsed.toolCallLog[0].tool, 'Read');
    assert.deepEqual(parsed.toolCallLog[0].args, { file_path: '/repo/src/index.ts' });
    assert.equal(parsed.toolCallLog[1].tool, 'Grep');
    assert.deepEqual(parsed.toolCallLog[1].args, { pattern: 'TODO', path: '/repo/src' });
  });

  it('prefers the longer of delta-assembled text and result.result', () => {
    // Fixture: assembled text ('Analyzing the codebase.') is longer than
    // result.result ('Done.'), so assembled wins per the parser's
    // "longer source of truth" tie-break. This guards the anti-truncation
    // property documented in the parser.
    assert.equal(parsed.text, 'Analyzing the codebase.');
  });

  it('uses result.result as final text when it is at least as long as assembled', () => {
    const fixture = [
      JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'short' },
      }),
      JSON.stringify({
        type: 'result',
        result: 'this is the authoritative final text',
      }),
    ].join('\n');
    const p = parseStreamJson(fixture);
    assert.equal(p.text, 'this is the authoritative final text');
  });

  it('aggregates usage across assistant and result events', () => {
    assert.equal(parsed.usage.inputTokens, 550);
    assert.equal(parsed.usage.outputTokens, 130);
  });

  it('captures model from the assistant message', () => {
    assert.equal(parsed.model, 'claude-opus-4-7');
  });
});

describe('parseStreamJson — resilience', () => {
  it('skips malformed JSON lines without throwing', () => {
    const mixed = [
      'not valid json at all',
      '{"type":"init","model":"gemini-3.1-pro-preview"}',
      '{partial',
      '{"type":"tool_use","tool_name":"read_file","parameters":{"absolute_path":"/tmp/a.ts"}}',
    ].join('\n');
    const parsed = parseStreamJson(mixed);
    assert.equal(parsed.toolCallLog.length, 1);
    assert.equal(parsed.toolCallLog[0].tool, 'read_file');
    assert.equal(parsed.model, 'gemini-3.1-pro-preview');
  });

  it('returns empty result for empty input', () => {
    const parsed = parseStreamJson('');
    assert.equal(parsed.toolCallLog.length, 0);
    assert.equal(parsed.text, '');
    assert.equal(parsed.usage.inputTokens, 0);
    assert.equal(parsed.usage.outputTokens, 0);
    assert.equal(parsed.model, null);
  });
});
