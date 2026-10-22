/**
 * Types for opencode-jev-safe-compact.
 *
 * The message shape is a subset of what OpenCode V2 hands to the `compaction`
 * hook, so a session transcript can be adapted into it and back again.
 */

export type Role = 'user' | 'assistant';

/** A tool call, with its result attached once the transcript has it. */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool result delivered on its own message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** One transcript message in OpenCode's native part shape. */
export interface NativePart {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

export interface NativeMessage {
  id?: string;
  role: string;
  content: NativePart[];
  [key: string]: unknown;
}

/** An assistant text block that could be removed on its own. */
export interface Narrative {
  /** Short id used in the state and in question names (`n1`, `n2`, ...). */
  id: string;
  /** Index of the message holding the text. */
  messageIndex: number;
  text: string;
}

/** A tool call paired with its result. */
export interface ToolCall {
  /** Short id used in the state and in question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  callIndex: number;
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

/** One history entry as the decision model sees it. */
export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  tool_calls?: HistoryToolCall[];
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  /** Head of the result, so the model can tell what it was. */
  result_head: string;
  result_chars: number;
  is_error: boolean;
}

/** The state sent with every decision request. */
export interface DecisionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface DecisionAnswers {
  [questionId: string]: { type: 'noul'; noul: number };
}

/** What happens to one tool call. */
export type CallAction =
  /** Everything stays. */
  | 'keep'
  /** The result is shortened: head, tail, and a marker. The call stays. */
  | 'truncate'
  /** The result is removed. The call stays, so the trace of what ran remains. */
  | 'drop_result'
  /** The call and its result are both removed. Off by default. */
  | 'drop_call';

export interface CallDecision {
  id: string;
  tool_use_id: string;
  tool: string;
  action: CallAction;
  /** Probability that the call still matters. */
  keepCall: number;
  /** Probability that the full output still matters verbatim. */
  keepResult: number;
  /** Characters removed by this decision. */
  savedChars: number;
  reason: string;
}

export interface CompactOptions {
  /** Ongoing task description. Defaults to the last few user prompts. */
  goal?: string;
  /** Newest messages never touched. The first message is always kept. */
  preserveRecentMessages?: number;
  /**
   * Fraction of the transcript's characters to aim to remove. Default 0.25.
   *
   * This is what decides *how much* to remove. The scores never do — see
   * `research/FINDINGS.md` for why an absolute threshold is unreliable.
   */
  targetReduction?: number;
  /**
   * Below this probability a result may be removed outright rather than
   * truncated. Above it, the result is only ever shortened. Default 0.25.
   *
   * This is the one place an absolute score is read, and it only chooses
   * between two conservative actions.
   */
  dropFloor?: number;
  /** Upper bound on the characters kept from the head of a truncated result. */
  truncateHeadChars?: number;
  /** Upper bound on the characters kept from the tail of a truncated result. */
  truncateTailChars?: number;
  /**
   * At most this fraction of a result is kept when it is shortened. Default
   * 0.4, so a short result is shortened proportionally instead of not at all.
   */
  keepRatio?: number;
  /** Allow removing the whole call. Off by default: see `research/FINDINGS.md`. */
  allowDropCall?: boolean;
  /** Never remove the output of a failed call. Default true. */
  keepErrors?: boolean;
  /**
   * Remove assistant narration that no longer carries state. Default true.
   *
   * Narration that states a conclusion or a decision is kept; narration that
   * only describes a step ("let me look at the file") is removed. A narration
   * is never removed while the tool calls it introduced are still there, so
   * the transcript never shows a conclusion whose evidence is missing.
   */
  pruneNarration?: boolean;
  /**
   * Below this probability a narration is removed. Above it, it is kept.
   * Default 0.35 - deliberately conservative, because a removed narration
   * cannot be recovered.
   */
  narrativeFloor?: number;
  /** Estimated token ceiling for the state. */
  maxStateTokens?: number;
  /** Estimated token ceiling for one request. */
  maxRequestTokens?: number;
  /** Milliseconds allowed for one decision request. */
  requestTimeoutMs?: number;
}

export interface ResolvedOptions extends Required<Omit<CompactOptions, 'goal'>> {
  goal: string;
}

export interface NarrativeDecision {
  id: string;
  messageIndex: number;
  action: 'keep' | 'remove';
  score: number;
  reason: string;
}

export interface CompactStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  candidates: number;
  kept: number;
  truncated: number;
  dropped: number;
  narrationsKept: number;
  narrationsRemoved: number;
  savedChars: number;
  requests: number;
  ms: number;
}

export interface CompactResult {
  messages: Message[];
  decisions: CallDecision[];
  stats: CompactStats;
  /** The checkpoint the model will read. Its length is the real context size. */
  checkpoint: string;
}

export interface DecisionServiceOptions {
  /** Full URL of a `/v1/systemone` endpoint. */
  baseUrl: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
