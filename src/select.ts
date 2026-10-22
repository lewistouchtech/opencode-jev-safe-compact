/**
 * Deciding what to keep.
 *
 * This is where the design departs from the upstream implementation, and the
 * reason is the measurement in `research/FINDINGS.md`.
 *
 * Upstream compares each score against a fixed threshold (0.5). The measurement
 * shows that the absolute score moves as a whole when the shape of the state
 * changes, while the ranking it induces stays good (AUC 0.70-0.83). A fixed
 * threshold therefore over-retains or under-retains with no signal to the
 * caller: at one `fitState()` stage every score lands above 0.5 and nothing is
 * removed at all.
 *
 * So the two questions are separated:
 *
 *   - *How much* to remove is decided by the budget, not by the scores.
 *     Candidates are ranked and worked through from the bottom until the
 *     requested reduction is reached. The ranking is what is reliable.
 *   - *Which action* to take on one item is decided by the score, but the
 *     score only chooses between two conservative actions: shorten the output
 *     or remove it. Below the floor an output may go; above it, it is only
 *     ever shortened.
 *
 * A call is never removed unless `allowDropCall` is set. Removing a call while
 * keeping the narration around it is what produced the fabricated-work reports
 * in upstream issue #65: the model kept its own account of work it could no
 * longer see the evidence for.
 */

import type {
  CallDecision,
  Narrative,
  NarrativeDecision,
  ResolvedOptions,
  ToolCall,
} from './types.js';

/** The score the decision service returned for one call. */
export interface CallScores {
  keepCall: number;
  keepResult: number;
}

/**
 * Works out what to do with each candidate call.
 *
 * `budget` is how many characters the caller wants removed. Candidates are
 * ranked by `keepResult` and worked through from the lowest score upward
 * until that budget is met.
 *
 * The budget is spent in whole results where possible: if removing one
 * entirely still leaves the budget short, it is removed; if it would overshoot,
 * the output is shortened by exactly what is still needed and the walk stops.
 * That keeps a valuable result from being chipped at for a handful of
 * characters.
 */
export function decide(
  calls: readonly ToolCall[],
  scores: ReadonlyMap<string, CallScores>,
  budget: number,
  options: ResolvedOptions,
): CallDecision[] {
  const decisions: CallDecision[] = [];

  const scored = calls
    .map((call) => {
      const score = scores.get(call.id);
      return {
        call,
        keepCall: score?.keepCall ?? 1,
        keepResult: score?.keepResult ?? 1,
      };
    })
    // Ascending: the least valuable first.
    .sort((a, b) => a.keepResult - b.keepResult);

  let remaining = Math.max(0, budget);
  let savedChars = 0;

  for (const { call, keepCall, keepResult } of scored) {
    if (call.pinned) {
      decisions.push({
        id: call.id,
        tool_use_id: call.tool_use_id,
        tool: call.tool,
        action: 'keep',
        keepCall,
        keepResult,
        savedChars: 0,
        reason: 'pinned',
      });
      continue;
    }

    // An output that records a failure cannot be reproduced by re-running the
    // command, so it is never removed.
    if (call.isError && options.keepErrors) {
      decisions.push({
        id: call.id,
        tool_use_id: call.tool_use_id,
        tool: call.tool,
        action: 'keep',
        keepCall,
        keepResult,
        savedChars: 0,
        reason: 'error output preserved',
      });
      continue;
    }

    const keepChars = keepCharsFor(call.resultChars, options);
    const removable = Math.max(0, call.resultChars - keepChars);

    if (removable <= 0) {
      decisions.push({
        id: call.id,
        tool_use_id: call.tool_use_id,
        tool: call.tool,
        action: 'keep',
        keepCall,
        keepResult,
        savedChars: 0,
        reason: 'result already short',
      });
      continue;
    }

    // The budget is met, or what is left would not be worth the churn.
    if (remaining < MIN_USEFUL_REDUCTION) {
      decisions.push({
        id: call.id,
        tool_use_id: call.tool_use_id,
        tool: call.tool,
        action: 'keep',
        keepCall,
        keepResult,
        savedChars: 0,
        reason: 'budget met',
      });
      continue;
    }

    // The score only picks between shortening and removing. Both are
    // conservative; removal is the one that needs the score to be low.
    const mayRemove = keepResult < options.dropFloor;
    const wholeCall = options.allowDropCall && keepCall < options.dropFloor;

    if (wholeCall) {
      decisions.push({
        id: call.id,
        tool_use_id: call.tool_use_id,
        tool: call.tool,
        action: 'drop_call',
        keepCall,
        keepResult,
        savedChars: call.resultChars,
        reason: 'call and output removed',
      });
      savedChars += call.resultChars;
      remaining -= call.resultChars;
      continue;
    }

    // Removing it entirely still leaves the budget short: remove it.
    if (mayRemove && removable <= remaining) {
      decisions.push({
        id: call.id,
        tool_use_id: call.tool_use_id,
        tool: call.tool,
        action: 'drop_result',
        keepCall,
        keepResult,
        savedChars: call.resultChars,
        reason: 'output no longer needed',
      });
      savedChars += call.resultChars;
      remaining -= call.resultChars;
      continue;
    }

    // Otherwise shorten it by exactly what is still needed, and stop there.
    const take = Math.min(removable, remaining);
    decisions.push({
      id: call.id,
      tool_use_id: call.tool_use_id,
      tool: call.tool,
      action: 'truncate',
      keepCall,
      keepResult,
      savedChars: take,
      reason: mayRemove
        ? 'output shortened to meet the budget'
        : 'output shortened',
    });
    savedChars += take;
    remaining -= take;
  }

  // Restore the transcript order.
  const order = new Map(calls.map((call, index) => [call.id, index]));
  decisions.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return decisions;
}

/**
 * Decides which narration to remove.
 *
 * Unlike the tool outputs, a narration is a yes-or-no decision rather than a
 * budgeted one: either the note still carries state or it does not. The floor
 * is deliberately conservative because a removed note cannot be recovered.
 */
export function decideNarratives(
  narratives: readonly Narrative[],
  scores: ReadonlyMap<string, number>,
  options: ResolvedOptions,
): NarrativeDecision[] {
  return narratives.map((narrative) => {
    const score = scores.get(narrative.id) ?? 1;
    const remove = options.pruneNarration && score < options.narrativeFloor;
    return {
      id: narrative.id,
      messageIndex: narrative.messageIndex,
      action: remove ? 'remove' : 'keep',
      score,
      reason: remove ? 'narration carries no state' : 'narration kept',
    };
  });
}

/**
 * How many characters of a result are kept when it is shortened.
 *
 * The head and tail limits are upper bounds, not fixed amounts. A result of
 * 500 characters cannot spare 450 of them, and insisting on it made short
 * outputs impossible to compress at all. The ratio caps the kept portion at
 * `keepRatio` of the result, so a short output is shortened proportionally.
 */
export function keepCharsFor(resultChars: number, options: ResolvedOptions): number {
  const ratioCap = Math.floor(resultChars * options.keepRatio);
  const head = Math.min(options.truncateHeadChars, ratioCap);
  const tail = Math.min(options.truncateTailChars, ratioCap);
  return head + tail;
}

/**
 * A shortening that frees fewer characters than this is not worth doing: it
 * churns the transcript for nothing.
 */
export const MIN_USEFUL_REDUCTION = 200;

/**
 * How many characters the caller wants removed.
 *
 * Derived from how much the candidates could give up at all, not from the size
 * of the transcript: a transcript full of short outputs cannot be shrunk by a
 * percentage of its own length, and budgeting that way would spill onto
 * results that should have been left alone.
 */
export function budgetChars(calls: readonly ToolCall[], options: ResolvedOptions): number {
  let removable = 0;
  for (const call of calls) {
    if (call.pinned) continue;
    if (call.isError && options.keepErrors) continue;
    removable += Math.max(0, call.resultChars - keepCharsFor(call.resultChars, options));
  }
  return Math.max(0, Math.round(removable * Math.max(0, Math.min(1, options.targetReduction))));
}
