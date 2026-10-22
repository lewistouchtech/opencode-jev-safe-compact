/**
 * The OpenCode plugin.
 *
 * The plugin registers one command, `/jev-compact`, and hooks the compaction
 * event. The hook is *gated*: it only does anything for the session that the
 * command asked for. A native `/compact` is never silently replaced, which is
 * the failure mode that upstream issues #89 and #145 describe.
 */

import { Plugin } from '@opencode/plugin';
import { compact, resolveOptions, serialize } from './compact.js';
import { createLogger, defaultLogPath } from './log.js';
import type {
  CompactOptions,
  Message,
  NativeMessage,
  NativePart,
} from './types.js';

/** Plugin options, as they appear in `opencode.json`. */
export interface PluginOptions extends CompactOptions {
  /** Full URL of a `/v1/systemone` endpoint. */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Where the decision log is written. */
  logFile?: string;
  /** Report the plan without changing anything. */
  dryRun?: boolean;
}

/** The session the command asked to compact, if any. */
let requested: string | null = null;

function defaultBaseUrl(): string {
  return (
    process.env.JEV_SAFE_COMPACT_BASE_URL ??
    process.env.TYPESAFE_BASE_URL ??
    'https://api.typesafe.ai/v1/systemone'
  );
}

function defaultApiKey(): string | undefined {
  return process.env.TYPESAFE_API_KEY;
}

/** The part shapes that carry text, a tool call, or a tool result. */
function isText(part: NativePart): boolean {
  return part.type === 'text' && typeof part.text === 'string';
}

function isToolCall(part: NativePart): boolean {
  return part.type === 'tool' && typeof part.name === 'string';
}

function isToolResult(part: NativePart): boolean {
  return part.type === 'tool-result' && typeof part.tool_use_id === 'string';
}

function inputOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return value === undefined ? {} : { input: value };
}

/** The text of a tool result, however the host spells it. */
function resultText(part: NativePart): { text: string; isError: boolean } {
  const output = part.output;
  if (typeof output === 'string') {
    return { text: output, isError: part.state === 'error' || part.isError === true };
  }
  if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    const text =
      typeof record.output === 'string'
        ? record.output
        : typeof record.text === 'string'
          ? record.text
          : safeJson(record);
    return { text, isError: record.isError === true || record.type === 'error' };
  }
  if (typeof part.text === 'string') {
    return { text: part.text, isError: part.state === 'error' || part.isError === true };
  }
  return { text: '', isError: part.state === 'error' || part.isError === true };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Adapts OpenCode's native messages into the shape this plugin works with.
 */
export function toMessages(messages: readonly NativeMessage[]): Message[] {
  return messages.flatMap((message) => {
    const parts = Array.isArray(message.content) ? message.content : [];
    const toolUses = parts.filter(isToolCall).map((part) => ({
      tool_use_id: String(part.id ?? ''),
      tool: String(part.name),
      input: inputOf(part.input),
    }));
    const toolResults = parts.filter(isToolResult).map((part) => {
      const result = resultText(part);
      return {
        tool_use_id: String(part.tool_use_id),
        text: result.text,
        isError: result.isError,
      };
    });
    const text = parts.filter(isText).map((part) => String(part.text)).join('\n');
    if (text.length === 0 && toolUses.length === 0 && toolResults.length === 0) return [];
    const adapted: Message = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      text,
      toolUses,
    };
    if (toolResults.length > 0) adapted.toolResults = toolResults;
    return [adapted];
  });
}

/**
 * The plugin.
 */
export const JevSafeCompact = Plugin.define({
  id: 'opencode-jev-safe-compact',

  async setup(ctx) {
    const options = (ctx.options ?? {}) as PluginOptions;
    const logger = createLogger(options.logFile ?? defaultLogPath());
    const resolved = resolveOptions(options);
    const baseUrl = options.baseUrl ?? defaultBaseUrl();
    const model = options.model ?? 'jev-latest';
    const apiKey = options.apiKey ?? defaultApiKey();
    const dryRun = options.dryRun ?? false;

    logger.info('initialized', {
      baseUrl,
      model,
      apiKey: apiKey ? 'set' : 'none',
      targetReduction: resolved.targetReduction,
      dropFloor: resolved.dropFloor,
      preserveRecentMessages: resolved.preserveRecentMessages,
      allowDropCall: resolved.allowDropCall,
      dryRun,
    });

    // The command. It only asks OpenCode to compact; the hook below does the
    // work, and only for this session.
    await ctx.command.transform((editor) => {
      editor.add({
        name: 'jev-compact',
        description:
          'Compact this session with JEV-guided pruning instead of a model-written summary.',
        execute: async (input) => {
          requested = input.sessionID;
          try {
            await ctx.session.compact({ sessionID: input.sessionID });
          } catch (error) {
            requested = null;
            logger.error('compact failed', {
              session: input.sessionID,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });
    });

    // The hook. Gated on the session the command asked for.
    await ctx.session.hook('compaction', async (event) => {
      if (requested !== event.sessionID) return;
      requested = null;

      const nativeMessages = (event.messages ?? []) as unknown as NativeMessage[];
      const messages = toMessages(nativeMessages);
      if (messages.length === 0) return;

      const result = await compact(messages, { baseUrl, model, apiKey }, resolved);
      if (!result) {
        logger.info('declined', { session: event.sessionID, reason: 'nothing worth removing' });
        return;
      }

      logger.info('compacted', {
        session: event.sessionID,
        ...result.stats,
        dryRun,
      });

      for (const decision of result.decisions) {
        if (decision.action === 'keep') continue;
        logger.info('decision', {
          session: event.sessionID,
          id: decision.id,
          tool: decision.tool,
          action: decision.action,
          keepCall: Number(decision.keepCall.toFixed(3)),
          keepResult: Number(decision.keepResult.toFixed(3)),
          savedChars: decision.savedChars,
          reason: decision.reason,
        });
      }

      if (dryRun) return;

      event.result = { summary: serialize(result.messages) };
    });
  },
});

export default JevSafeCompact;
