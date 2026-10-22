/**
 * Orchestration: ask, decide, apply, serialize.
 */

import { ask, narrationQuestion, questionsFor } from './jev.js';
import { budgetChars, decide, decideNarratives } from './select.js';
import type { CallScores } from './select.js';
import {
  buildState,
  collectNarratives,
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
  DecisionAnswers,
  DecisionServiceOptions,
  Message,
  NoulQuestion,
  Narrative,
  NarrativeDecision,
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
  keepRatio: 0.4,
  allowDropCall: false,
  keepErrors: true,
  pruneNarration: true,
  narrativeFloor: 0.35,
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
    'keepRatio',
    'narrativeFloor',
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
  if (typeof options.pruneNarration === 'boolean') out.pruneNarration = options.pruneNarration;
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
      // The result is changed below; the call itself stays. The copy of the
      // output carried on the call has to change with it, or the old text
      // would still be counted and could still be read.
      if (tool.text !== undefined) {
        return {
          ...tool,
          text: resultText.get(tool.tool_use_id)?.text === undefined
            ? tool.text
            : '',
        };
      }
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
 * Applies the narration decisions: the text of a removed narration is taken
 * out of its message.
 */
export function applyNarratives(
  messages: readonly Message[],
  decisions: readonly NarrativeDecision[],
): Message[] {
  const byIndex = new Map<number, NarrativeDecision>();
  for (const decision of decisions) {
    if (decision.action === 'remove') byIndex.set(decision.messageIndex, decision);
  }
  if (byIndex.size === 0) return [...messages];

  return messages.map((message, index) => {
    const decision = byIndex.get(index);
    if (!decision) return message;
    const text = message.text.replace(/\s+/g, ' ').trim();
    return { ...message, text };
  });
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

  // The narration that can be pruned, if any.
  const narratives = resolved.pruneNarration
    ? collectNarratives(messages, resolved.preserveRecentMessages)
    : [];

  // Every question goes out in as few requests as possible. The decision
  // service evaluates the questions of one request in parallel, so a batch
  // costs barely more than a single question - asking one narration at a
  // time turned a two-second compaction into a minute and a half.
  const scores = new Map<string, CallScores>();
  const narrativeScores = new Map<string, number>();
  let requests = 0;

  type Pending = {
    questions: Record<string, NoulQuestion>;
    apply: (answers: DecisionAnswers) => void;
  };
  const pending: Pending[] = [];
  for (const call of candidates) {
    pending.push({
      questions: questionsFor(call),
      apply: (answers) => {
        const keepCall = answers[`call_${call.id}`]?.noul;
        const keepResult = answers[`result_${call.id}`]?.noul;
        scores.set(call.id, {
          keepCall: typeof keepCall === 'number' ? keepCall : 1,
          keepResult: typeof keepResult === 'number' ? keepResult : 1,
        });
      },
    });
  }
  for (const narrative of narratives) {
    pending.push({
      questions: narrationQuestion(narrative),
      apply: (answers) => {
        const value = answers[`narrate_${narrative.id}`]?.noul;
        if (typeof value === 'number') narrativeScores.set(narrative.id, value);
      },
    });
  }

  for (const batch of batchQuestions(pending, fitted.tokens, resolved)) {
    const questions: Record<string, NoulQuestion> = {};
    for (const item of batch) Object.assign(questions, item.questions);
    try {
      const answers = await ask(service, fitted.state, questions);
      requests += 1;
      for (const item of batch) item.apply(answers);
    } catch {
      // Fail open. Anything without an answer is treated as "keep".
      continue;
    }
  }

  if (scores.size === 0 && narrativeScores.size === 0) return null;
  const narrativeDecisions = decideNarratives(narratives, narrativeScores, resolved);

  // Two different sizes matter here, and confusing them is how a compaction
  // can look like a win while making the context larger.
  //
  //   native      - what the model reads now: the message list.
  //   checkpoint  - what the model reads after the compaction: one text blob
  //                 with markers around the calls.
  //
  // The markers cost characters, so the checkpoint is larger than the message
  // list it came from. A compaction is only worth doing when the checkpoint is
  // smaller than what the model has now.
  const native = messageChars(messages);
  const budget = budgetChars(candidates, resolved);
  const decisions = decide(calls, scores, budget, resolved);
  const kept = applyDecisions(
    applyNarratives(messages, narrativeDecisions),
    decisions,
    calls,
    resolved,
  );
  const checkpoint = serialize(kept);

  // Not worth doing: the model would end up with a context that is no smaller
  // than the one it started with.
  if (checkpoint.length >= native) return null;

  const stats: CompactStats = {
    messagesBefore: messages.length,
    messagesAfter: kept.length,
    charsBefore: native,
    charsAfter: checkpoint.length,
    candidates: candidates.length,
    kept: decisions.filter((d) => d.action === 'keep').length,
    truncated: decisions.filter((d) => d.action === 'truncate').length,
    dropped: decisions.filter((d) => d.action === 'drop_result' || d.action === 'drop_call').length,
    narrationsKept: narrativeDecisions.filter((d) => d.action === 'keep').length,
    narrationsRemoved: narrativeDecisions.filter((d) => d.action === 'remove').length,
    savedChars: native - checkpoint.length,
    requests,
    ms: Date.now() - started,
  };

  return { messages: kept, decisions, stats, checkpoint };
}

/** Splits the questions into batches that fit one request. */
function batchQuestions<T>(
  items: readonly T[],
  stateTokens: number,
  options: ResolvedOptions,
  perItemTokens = 150,
): T[][] {
  const budget = Math.max(perItemTokens, options.maxRequestTokens - stateTokens - 500);
  const batches: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    if (current.length > 0 && used + perItemTokens > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += perItemTokens;
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
    '[jev-safe-compact: the retained conversation follows verbatim; no model summary was generated]',
  ];
  for (const message of messages) {
    // The role markers cost a handful of characters each and the model reads
    // them as structure, so they stay - but nothing else is added.
    out.push('', `<${message.role}>`, message.text);
    for (const tool of message.toolUses) {
      out.push(`[${tool.tool} ${safeJson(tool.input)}]`);
    }
    for (const result of message.toolResults ?? []) {
      if (message.toolUses.some((t) => t.tool_use_id === result.tool_use_id)) continue;
      out.push(result.isError ? '[error]' : '[result]');
      out.push(result.text);
    }
    out.push(`</${message.role}>`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '[unserializable]';
  }
}
