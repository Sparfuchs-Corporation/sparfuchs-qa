import type { ToolCallLogEntry } from '../types.js';

// --- Stream-JSON Parser ---
// Parses JSONL output from CLI tools that support --output-format stream-json.
// Currently used by: Claude CLI (--print --output-format stream-json)
//                     Gemini CLI (-p --output-format stream-json)
//
// Resilient: malformed lines are skipped, never throws.

export interface StreamJsonParseResult {
  text: string;
  toolCallLog: ToolCallLogEntry[];
  usage: { inputTokens: number; outputTokens: number };
  model: string | null;
}

// --- Event type narrowing ---

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock;

interface AssistantMessage {
  type: 'assistant';
  message?: {
    role?: string;
    model?: string;
    content?: ContentBlock[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // Gemini CLI may use a flatter structure
  content_block?: ContentBlock;
}

interface ContentBlockStartEvent {
  type: 'content_block_start';
  content_block?: ContentBlock;
}

interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
}

interface ResultEvent {
  type: 'result';
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  subtype?: string;
  model?: string;
  // Claude CLI result may include usage
  usage?: { input_tokens?: number; output_tokens?: number };
}

type StreamEvent =
  | AssistantMessage
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | { type: 'content_block_stop' }
  | ResultEvent
  | { type: string; [key: string]: unknown };

/**
 * Parse a stream-json JSONL string (complete output from a CLI with
 * --output-format stream-json).
 *
 * Extracts:
 * - Text content from assistant/result events
 * - Tool use entries (tool name + input args) → ToolCallLogEntry[]
 * - Token usage if reported
 * - Model name if reported
 */
export function parseStreamJson(rawOutput: string): StreamJsonParseResult {
  const textParts: string[] = [];
  const toolCallLog: ToolCallLogEntry[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let model: string | null = null;
  // The terminal `result` event carries the canonical final text. Prefer it
  // over content_block_delta fragments when both are present — Gemini CLI
  // fragments its text stream in ways that sometimes split finding tags
  // (e.g. `<!-- finding: {...} -->`) across delta boundaries. Using the
  // authoritative final text avoids lost/truncated tags reaching the
  // downstream parser.
  let finalResultText: string | null = null;

  // State for incremental tool_use block assembly
  let pendingToolName: string | null = null;
  let pendingToolJsonParts: string[] = [];

  const lines = rawOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      continue; // skip non-JSON lines (progress indicators, etc.)
    }

    if (!event || typeof event.type !== 'string') continue;

    switch (event.type) {
      case 'assistant': {
        const msg = (event as AssistantMessage).message;
        if (msg?.model) model = msg.model;
        if (msg?.usage) {
          usage = mergeUsage(usage, msg.usage);
        }
        if (msg?.content) {
          for (const block of msg.content) {
            if (block.type === 'text') {
              textParts.push(block.text);
            } else if (block.type === 'tool_use') {
              toolCallLog.push({
                tool: block.name,
                args: block.input ?? {},
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
        break;
      }

      case 'content_block_start': {
        const block = (event as ContentBlockStartEvent).content_block;
        if (block?.type === 'tool_use') {
          pendingToolName = block.name;
          pendingToolJsonParts = [];
          if (block.input && Object.keys(block.input).length > 0) {
            // Input provided inline at start
            toolCallLog.push({
              tool: block.name,
              args: block.input,
              timestamp: new Date().toISOString(),
            });
            pendingToolName = null;
          }
        }
        break;
      }

      case 'content_block_delta': {
        const delta = (event as ContentBlockDeltaEvent).delta;
        if (!delta) break;
        if (delta.type === 'text_delta' && delta.text) {
          textParts.push(delta.text);
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          pendingToolJsonParts.push(delta.partial_json);
        }
        break;
      }

      case 'content_block_stop': {
        if (pendingToolName) {
          const jsonStr = pendingToolJsonParts.join('');
          let args: Record<string, unknown> = {};
          if (jsonStr) {
            try {
              args = JSON.parse(jsonStr) as Record<string, unknown>;
            } catch {
              // Partial JSON — store what we have as raw string
              args = { _rawJson: jsonStr };
            }
          }
          toolCallLog.push({
            tool: pendingToolName,
            args,
            timestamp: new Date().toISOString(),
          });
          pendingToolName = null;
          pendingToolJsonParts = [];
        }
        break;
      }

      case 'result': {
        const resultEvent = event as ResultEvent;
        if (resultEvent.result && typeof resultEvent.result === 'string') {
          finalResultText = resultEvent.result;
        }
        if (resultEvent.model) model = resultEvent.model;
        if (resultEvent.usage) {
          usage = mergeUsage(usage, resultEvent.usage);
        }
        break;
      }
    }
  }

  // Prefer the authoritative final result text when it is present AND at
  // least as long as the delta-assembled text. Falling back to the longer of
  // the two means finding-tag fragments never go missing even if a stream
  // emits both sources with slight divergence.
  const assembled = textParts.join('');
  const text = finalResultText && finalResultText.length >= assembled.length
    ? finalResultText
    : assembled || finalResultText || '';

  return {
    text,
    toolCallLog,
    usage,
    model,
  };
}

function mergeUsage(
  current: { inputTokens: number; outputTokens: number },
  incoming: { input_tokens?: number; output_tokens?: number },
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: current.inputTokens + (incoming.input_tokens ?? 0),
    outputTokens: current.outputTokens + (incoming.output_tokens ?? 0),
  };
}
