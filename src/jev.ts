/**
 * The decision service client and the question templates.
 *
 * The service is anything that speaks `POST {baseUrl}` with a Jev-shaped body
 * and answers with `{ answers: { id: { type: "noul", noul } } }`. That covers
 * TypeSafe's hosted API, a local self-hosted model, and OpenCode Zen.
 */

import type {
  DecisionAnswers,
  DecisionServiceOptions,
  DecisionState,
  NoulQuestion,
  ToolCall,
} from './types.js';

/** The state context handed to the model with every request. */
export const STATE_CONTEXT =
  'A coding assistant conversation is being compacted to free context. ' +
  'The history is the whole conversation so far, oldest first. ' +
  'Each question asks whether one past tool call, or the full output of that ' +
  'call, still needs to stay in the history verbatim. ' +
  'Output that is not kept can always be reproduced by running the tool again, ' +
  'unless the output was an error or a one-shot observation.';

/**
 * Asks the decision service one batch of questions.
 *
 * Throws on any transport, protocol, or shape problem. Callers must treat a
 * throw as "no answer" and fail open.
 */
export async function ask(
  options: DecisionServiceOptions,
  state: DecisionState,
  questions: Record<string, NoulQuestion>,
): Promise<DecisionAnswers> {
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetcher(options.baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model ?? 'jev-latest',
        state,
        questions,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`decision service returned ${response.status}`);
    }
    const payload = (await response.json()) as { answers?: unknown };
    if (!payload || typeof payload !== 'object' || !payload.answers) {
      throw new Error('decision service response has no answers');
    }
    const answers = payload.answers as Record<string, { noul?: unknown }>;
    const out: DecisionAnswers = {};
    for (const [id, answer] of Object.entries(answers)) {
      const value = answer?.noul;
      if (typeof value === 'number' && Number.isFinite(value)) {
        out[id] = { type: 'noul', noul: value };
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The two questions asked about one tool call.
 *
 * Both carry explicit true/false criteria. The TypeSafe docs are direct about
 * this: when the boundary between yes and no is subtle, spell out what each
 * answer means. The upstream implementation sends `instructions` only, and the
 * measurement in `research/` shows that without criteria the ranking of tool
 * results is much weaker (AUC 0.917 -> 1.000 on the reference fixture).
 *
 * The two questions are deliberately separate. "Is the call still needed" and
 * "is the output still needed verbatim" are different judgements, and one
 * answer each keeps the code from having to disentangle a combined score.
 */
export function questionsFor(call: ToolCall): Record<string, NoulQuestion> {
  const where = call.tool === 'read' || call.tool === 'edit' || call.tool === 'write'
    ? 'the file it touched'
    : `what it produced (${call.tool})`;
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions:
        `Does it still matter that tool call ${call.id} (${call.tool}) was made, ` +
        `with its input, for what the assistant does next?`,
      criteria: {
        true:
          `The assistant's next step depends on knowing this call happened and what ` +
          `it was asked to do, and the call is not simply re-runnable to the same effect.`,
        false:
          `The call was a one-off survey of the repository - a listing, a dependency ` +
          `check, a version lookup - whose information the assistant either already has ` +
          `or can cheaply re-read, and whose result the next step does not need.`,
      },
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions:
        `Does the assistant still need the full output of tool call ${call.id} ` +
        `(${call.tool}, ${call.resultChars} characters) verbatim?`,
      criteria: {
        true:
          `The output contains ${where}: the source being edited, the specific error, ` +
          `the failing assertion, or the exact values that the next step depends on.`,
        false:
          `The output is a directory listing, a dependency manifest, a git log, or ` +
          `other general repository state that can be re-read cheaply, and no specific ` +
          `detail in it is needed for the next step.`,
      },
    },
  };
}

/** The names of the questions asked about one call. */
export const questionIds = (call: ToolCall) => [`call_${call.id}`, `result_${call.id}`];
