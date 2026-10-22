/**
 * Orchestration: ask, decide, apply, serialize.
 */

import { ask, questionsFor } from './jev.js';
import { budgetChars, decide } from './select.js';
import type { CallScores } from './select.js';
import {
  buildState,
  collectToolCalls,
  fitState,
  goalFromMessages,
  inputText,
} from './state.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactStats,
  DecisionServiceOptions,
  Message,
  ResolvedOptions,
  ToolCall,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedOptions = {
  goal: '',
  preserveRecentMessages: 8,
  targetReduction: 0.25,
  dropFloor: 0.25,
  truncateHeadChars: 300,
  truncateTailChars: 150,
  allowDropCall: false,
  keepErrors: true,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  requestTimeoutMs: 20_000,
};

export function resolveOptions(options: CompactOptions = {}): ResolvedOptions {
  const out: ResolvedOptions = { ...DEFAULT_OPTIONS };
  if (typeof options.goal === 'string') out.goal = options.goal;
  for (const key of [
    'preserveRecentMessages',
    'targetReduction',
    'dropFloor',
    'truncateHeadChars',
    'truncateTailChars',
    'maxStateTokens',
    'maxRequestTokens',
    'requestTimeoutMs',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      (out as unknown as Record<string, number>)[key] = value;
    }
  }
  if (typeof options.allowDropCall === 'boolean') out.allowDropCall = options.allowDropCall;
  if (typeof options.keepErrors === 'boolean') out.keepErrors = options.keepErrors;
  return out;
}

/** Total characters held by the transcript. */
export function messageChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const tool of message.toolUses) {
      total += inputText(tool.input, 10_000).length;
      if (tool.text) total += tool.text.length;
    }
    for (const result of message.toolResults ?? []) total += result.text.length;
  }
  return total;
}

/**
 * The marker left in a shortened output.
 *
 * It says what happened and what to do about it, so the model can tell the
 * difference between "this output was empty" and "this output was shortened".
 */
export function truncationMarker(
  removed: number,
  tool: string,
  options: ResolvedOptions,
): string {
  return (
    `\n[jev-safe-compact: ${removed} characters of this ${tool} output were removed. ` +
    `The head and tail are kept. Re-run the tool if the full output is needed.]\n`
  );
}

/**
 * Applies the decisions to the transcript.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  options: ResolvedOptions,
): Message[] {
  const byToolUseId = new Map(decisions.map((d) => [d.tool_use_id, d]));
  const resultText = new Map<string, { text: string; isError: boolean }>();
  messages.forEach((message) => {
    for (const result of message.toolResults ?? []) {
      resultText.set(result.tool_use_id, { text: result.text, isError: result.isError ?? false });
    }
  });

  const out: Message[] = [];
  for (const message of messages) {
    const toolUses = message.toolUses.map((tool) => {
      const decision = byToolUseId.get(tool.tool_use_id);
      if (!decision) return tool;
      if (decision.action === 'drop_call') return undefined;
      if (decision.action === 'keep') return tool;
      // The result is changed below; the call itself stays.
      return tool;
    });

    const keptUses = toolUses.filter((t): t is NonNullable<typeof t> => t !== undefined);
    let toolResults = message.toolResults;

    if (toolResults) {
      toolResults = toolResults
        .map((result) => {
          const decision = byToolUseId.get(result.tool_use_id);
          if (!decision) return result;
          if (decision.action === 'drop_result' || decision.action === 'drop_call') {
            return undefined;
          }
          if (decision.action === 'truncate') {
            const original = resultText.get(result.tool_use_id)?.text ?? result.text;
            const head = original.slice(0, options.truncateHeadChars);
            const tail =
              options.truncateTailChars > 0
                ? original.slice(-options.truncateTailChars)
                : '';
            const removed = Math.max(0, original.length - head.length - tail.length);
            return {
              ...result,
              text: `${head}${tail}${truncationMarker(removed, decision.tool, options)}`,
            };
          }
          return result;
        })
        .filter((r): r is NonNullable<typeof r> => r !== undefined);
    }

    // A message whose call was dropped and which carries no text left is not
    // worth keeping as an empty turn.
    if (message.text.trim().length === 0 && keptUses.length === 0 && (!toolResults || toolResults.length === 0)) {
      continue;
    }

    out.push({
      role: message.role,
      text: message.text,
      toolUses: keptUses,
      ...(toolResults && toolResults.length > 0 ? { toolResults } : {}),
    });
  }

  // A tool result whose call was dropped must go too.
  const dropped = new Set(
    decisions.filter((d) => d.action === 'drop_call').map((d) => d.tool_use_id),
  );
  if (dropped.size > 0) {
    for (const message of out) {
      if (!message.toolResults) continue;
      message.toolResults = message.toolResults.filter((r) => !dropped.has(r.tool_use_id));
    }
  }

  return out;
}

/**
 * Compacts a transcript.
 *
 * Returns null when it declines: no candidates, the service failed, or the
 * reduction is not worth taking. A null result means "do nothing", never
 * "remove everything".
 */
export async function compact(
  messages: readonly Message[],
  service: DecisionServiceOptions,
  options: CompactOptions = {},
): Promise<CompactResult | null> {
  const started = Date.now();
  const resolved = resolveOptions(options);

  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  if (candidates.length === 0) return null;

  const goal = resolved.goal || goalFromMessages(messages);
  const raw = buildState(messages, calls, goal);
  const fitted = fitState(raw, resolved.maxStateTokens);

  // Ask about the candidates in batches that fit one request.
  const scores = new Map<string, CallScores>();
  const batches = batchCandidates(candidates, fitted.tokens, resolved);
  let requests = 0;

  for (const batch of batches) {
    const questions: Record<string, ReturnType<typeof questionsFor>[string]> = {};
    for (const call of batch) {
      Object.assign(questions, questionsFor(call));
    }
    try {
      const answers = await ask(service, fitted.state, questions);
      requests += 1;
      for (const call of batch) {
        const keepCall = answers[`call_${call.id}`]?.noul;
        const keepResult = answers[`result_${call.id}`]?.noul;
        scores.set(call.id, {
          keepCall: typeof keepCall === 'number' ? keepCall : 1,
          keepResult: typeof keepResult === 'number' ? keepResult : 1,
        });
      }
    } catch {
      // Fail open. Anything without an answer is treated as "keep".
      continue;
    }
  }

  if (scores.size === 0) return null;

  const charsBefore = messageChars(messages);
  const budget = budgetChars(candidates, resolved);
  const decisions = decide(calls, scores, budget, resolved);
  const kept = applyDecisions(messages, decisions, calls, resolved);
  const charsAfter = messageChars(kept);

  // Not worth doing.
  if (charsBefore - charsAfter < charsBefore * 0.05) return null;

  const stats: CompactStats = {
    messagesBefore: messages.length,
    messagesAfter: kept.length,
    charsBefore,
    charsAfter,
    candidates: candidates.length,
    kept: decisions.filter((d) => d.action === 'keep').length,
    truncated: decisions.filter((d) => d.action === 'truncate').length,
    dropped: decisions.filter((d) => d.action === 'drop_result' || d.action === 'drop_call').length,
    savedChars: charsBefore - charsAfter,
    requests,
    ms: Date.now() - started,
  };

  return { messages: kept, decisions, stats };
}

/** Splits the candidates into batches that fit one request. */
function batchCandidates(
  candidates: readonly ToolCall[],
  stateTokens: number,
  options: ResolvedOptions,
): ToolCall[][] {
  const perCall = 120; // Rough cost of one question pair.
  const budget = Math.max(perCall, options.maxRequestTokens - stateTokens - 500);
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let used = 0;
  for (const call of candidates) {
    if (current.length > 0 && used + perCall > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(call);
    used += perCall;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Serializes a transcript for OpenCode's compaction override.
 *
 * OpenCode V2 accepts a summary string rather than a replacement message list,
 * so the retained conversation is written out verbatim, with the tool calls
 * and results marked so the structure survives.
 */
export function serialize(messages: readonly Message[]): string {
  const out: string[] = [
    '[jev-safe-compact checkpoint: the retained conversation follows verbatim; no model summary was generated]',
  ];
  for (const message of messages) {
    out.push('', `<${message.role}>`);
    if (message.text.length > 0) out.push(message.text);
    for (const tool of message.toolUses) {
      out.push(`[tool-call id=${tool.tool_use_id} name=${tool.tool}]`);
      out.push(safeJson(tool.input));
    }
    for (const result of message.toolResults ?? []) {
      if (message.toolUses.some((t) => t.tool_use_id === result.tool_use_id)) continue;
      out.push(
        `[tool-result id=${result.tool_use_id}${result.isError ? ' error=true' : ''}]`,
      );
      out.push(result.text);
    }
    out.push(`</${message.role}>`);
  }
  return out.join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '[unserializable]';
  }
}
