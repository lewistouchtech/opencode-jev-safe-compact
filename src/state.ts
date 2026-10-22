/**
 * Turning a transcript into the state the decision model sees.
 *
 * The upstream implementation replaces every tool output with a size note
 * (`ok, 8421 chars (omitted)`). The measurement in `research/` shows why that
 * matters: with only the tool name and the size, the model cannot tell a
 * failing test output from a directory listing, and the ranking degrades.
 *
 * So the head of each result is carried through, and the tail as well when the
 * result is short enough to keep both.
 */

import { STATE_CONTEXT } from './jev.js';
import type {
  DecisionState,
  HistoryEntry,
  HistoryToolCall,
  Message,
  Narrative,
  ToolCall,
} from './types.js';

/** Characters of a tool result carried into the state as its head. */
export const STATE_RESULT_HEAD = 400;

/** Characters of a tool result carried into the state as its tail. */
export const STATE_RESULT_TAIL = 150;

/** Characters of a tool input carried into the state. */
export const STATE_INPUT_CHARS = 300;

/**
 * Estimates tokens without a tokenizer.
 *
 * Calibrated against the token counts the decision service reports for real
 * transcripts, where it lands a little above the true value. A plain
 * characters-per-token ratio undercounts JSON-heavy states badly.
 */
export function estimateTokens(text: string): number {
  const pieces = text.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g);
  if (!pieces) return 0;
  let tokens = 0;
  for (const piece of pieces) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

function truncate(text: string, limit: number): string {
  if (limit <= 0) return '';
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function headAndTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

/**
 * The input of a call, flattened to one line.
 */
export function inputText(input: Record<string, unknown>, limit: number): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const text =
      typeof value === 'string'
        ? value
        : (() => {
            try {
              return JSON.stringify(value) ?? '';
            } catch {
              return '';
            }
          })();
    parts.push(`${key}=${text.replace(/\s+/g, ' ')}`);
  }
  return truncate(parts.join(' '), limit);
}

/**
 * Pairs every tool call with its result by `tool_use_id`.
 *
 * A call without a result is not a candidate: there is nothing to shorten yet.
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; text: string; isError: boolean }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, {
        index,
        text: result.text,
        isError: result.isError ?? false,
      });
    }
  });

  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.text.length,
        isError: found.isError,
        pinned:
          callIndex === 0 ||
          callIndex >= messages.length - preserveRecentMessages ||
          found.index === 0 ||
          found.index >= messages.length - preserveRecentMessages,
      });
    }
  });
  return calls;
}

/**
 * The assistant text blocks that could be removed on their own.
 *
 * Only text that is not attached to a tool call qualifies. A narration that
 * introduces a call must stay as long as the call does, otherwise the
 * transcript shows a conclusion whose evidence is missing - the shape of the
 * fabricated work reports in upstream issue #65.
 */
export function collectNarratives(
  messages: readonly Message[],
  preserveRecentMessages: number,
): Narrative[] {
  const out: Narrative[] = [];
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    if (message.text.trim().length === 0) return;
    if (message.toolUses.length > 0) return;
    if (index >= messages.length - preserveRecentMessages) return;
    out.push({ id: `n${out.length + 1}`, messageIndex: index, text: message.text });
  });
  return out;
}

/**
 * The task the session is working on: the last few user prompts.
 */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter((m) => m.role === 'user' && m.text.trim().length > 0 && !(m.toolResults ?? []).length)
    .slice(-3)
    .map((m) => truncate(m.text, 500))
    .join('\n');
}

/**
 * Builds the state from the transcript.
 *
 * Every tool call contributes its id, tool, a shortened input, the head of its
 * output, and the output size. The result tail is included when the result is
 * short, because the tail of a stack trace usually carries the error.
 */
export function buildState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  goal: string,
): DecisionState {
  const byIndex = new Map<number, HistoryToolCall[]>();
  const resultText = new Map<string, string>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      resultText.set(result.tool_use_id, result.text);
    }
  });

  for (const call of calls) {
    const text = resultText.get(call.tool_use_id) ?? '';
    const entry: HistoryToolCall = {
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, STATE_INPUT_CHARS),
      result_head: headAndTail(text, STATE_RESULT_HEAD, STATE_RESULT_TAIL),
      result_chars: call.resultChars,
      is_error: call.isError,
    };
    const list = byIndex.get(call.callIndex);
    if (list) list.push(entry);
    else byIndex.set(call.callIndex, [entry]);
  }

  const history: HistoryEntry[] = [];
  messages.forEach((message, index) => {
    const toolCalls = byIndex.get(index);
    const text = truncate(message.text, 1200);
    if (text.length === 0 && !toolCalls) return;
    const entry: HistoryEntry = { i: index, role: message.role, text };
    if (toolCalls) entry.tool_calls = toolCalls;
    history.push(entry);
  });

  return { context: STATE_CONTEXT, goal, history };
}

/**
 * Shrinks the state until it fits the token ceiling.
 *
 * The stages mirror the upstream ladder, but the tool results keep their head
 * at every stage: only the surrounding prose is abridged. That is the point of
 * the change, so a fitted state still says what each call produced.
 */
export function fitState(
  state: DecisionState,
  maxStateTokens: number,
): { state: DecisionState; tokens: number; stage: string } {
  const size = (s: DecisionState) => estimateTokens(JSON.stringify(s));
  const clone = (s: DecisionState): DecisionState => JSON.parse(JSON.stringify(s));

  let current = clone(state);
  let tokens = size(current);
  if (tokens <= maxStateTokens) return { state: current, tokens, stage: 'full' };

  // Stage 1: shorten the prose.
  for (const entry of current.history) {
    entry.text = truncate(entry.text, 300);
  }
  tokens = size(current);
  if (tokens <= maxStateTokens) return { state: current, tokens, stage: 'texts shortened' };

  // Stage 2: drop the prose of the oldest entries.
  for (const entry of current.history) {
    if (entry.text.length > 120) entry.text = truncate(entry.text, 120);
  }
  tokens = size(current);
  if (tokens <= maxStateTokens) return { state: current, tokens, stage: 'texts abridged' };

  // Stage 3: shorten the result heads.
  for (const entry of current.history) {
    if (!entry.tool_calls) continue;
    for (const call of entry.tool_calls) {
      call.result_head = truncate(call.result_head, 150);
      call.input = truncate(call.input, 80);
    }
  }
  tokens = size(current);
  if (tokens <= maxStateTokens) return { state: current, tokens, stage: 'results shortened' };

  // Stage 4: keep only the head of each result and the id line of the call.
  for (const entry of current.history) {
    if (!entry.tool_calls) continue;
    for (const call of entry.tool_calls) {
      call.result_head = truncate(call.result_head, 60);
    }
  }
  tokens = size(current);
  if (tokens <= maxStateTokens) return { state: current, tokens, stage: 'results minimized' };

  // Stage 5: keep the newest half of the history.
  const half = Math.max(1, Math.floor(current.history.length / 2));
  current.history = current.history.slice(-half);
  tokens = size(current);
  return { state: current, tokens, stage: 'oldest history dropped' };
}
