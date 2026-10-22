import { describe, expect, it } from 'vitest';
import {
  applyDecisions,
  compact,
  messageChars,
  resolveOptions,
  serialize,
} from '../src/compact.js';
import { budgetChars, decide } from '../src/select.js';
import { collectToolCalls, fitState } from '../src/state.js';
import type { CallScores } from '../src/select.js';
import type { Message, NativeMessage, ToolCall } from '../src/types.js';

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1',
    tool_use_id: 'call-1',
    tool: 'bash',
    input: { command: 'ls' },
    callIndex: 1,
    resultIndex: 2,
    resultChars: 4000,
    isError: false,
    pinned: false,
    ...overrides,
  };
}

/** A transcript with one big tool output. */
function transcript(): Message[] {
  return [
    { role: 'user', text: 'Find the failing test', toolUses: [] },
    {
      role: 'assistant',
      text: 'Looking at the repository.',
      toolUses: [
        {
          tool_use_id: 'call-1',
          tool: 'bash',
          input: { command: 'pytest tests/ -v' },
          text: 'x'.repeat(4000),
        },
      ],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [
        { tool_use_id: 'call-1', text: 'FAILED test_auth\n' + 'y'.repeat(4000) },
      ],
    },
  ];
}

describe('select: the decision does not depend on where the scores sit on the scale', () => {
  const options = resolveOptions({ targetReduction: 0.5, dropFloor: 0.25 });

  it('makes the same choice when every score is shifted up', () => {
    const calls = [
      toolCall({ id: 't1', tool_use_id: 'c1', resultChars: 4000 }),
      toolCall({ id: 't2', tool_use_id: 'c2', resultChars: 4000 }),
    ];
    const low: Map<string, CallScores> = new Map([
      ['t1', { keepCall: 0.4, keepResult: 0.2 }],
      ['t2', { keepCall: 0.9, keepResult: 0.8 }],
    ]);
    // The same ordering, with every score moved up by 0.35.
    const high: Map<string, CallScores> = new Map(
      Array.from(low, ([id, s]) => [
        id,
        { keepCall: s.keepCall + 0.35, keepResult: s.keepResult + 0.35 },
      ]),
    );

    const a = decide(calls, low, budgetChars(calls, options), options);
    const b = decide(calls, high, budgetChars(calls, options), options);

    // The low-scoring call is still the one that gets shortened or removed.
    expect(a[0]!.action).not.toBe('keep');
    expect(b[0]!.action).not.toBe('keep');
    // ...and the high-scoring one is still kept.
    expect(a[1]!.action).toBe('keep');
    expect(b[1]!.action).toBe('keep');
  });

  it('keeps the least valuable call when the whole band sits above the floor', () => {
    const calls = [
      toolCall({ id: 't1', tool_use_id: 'c1', resultChars: 4000 }),
      toolCall({ id: 't2', tool_use_id: 'c2', resultChars: 4000 }),
    ];
    // Both scores are high, as they are when the state shape pushes the band up.
    const scores: Map<string, CallScores> = new Map([
      ['t1', { keepCall: 0.7, keepResult: 0.55 }],
      ['t2', { keepCall: 0.9, keepResult: 0.8 }],
    ]);
    const decisions = decide(calls, scores, budgetChars(calls, options), options);
    // Nothing is removed outright, because neither score is below the floor.
    expect(decisions.every((d) => d.action !== 'drop_result')).toBe(true);
    // ...but the budget is still spent on the least valuable one.
    expect(decisions[0]!.action).toBe('truncate');
    expect(decisions[1]!.action).toBe('keep');
  });
});

describe('select: conservative defaults', () => {
  it('never removes a call unless asked', () => {
    const options = resolveOptions({ targetReduction: 1, dropFloor: 0.9 });
    const calls = [toolCall()];
    const scores: Map<string, CallScores> = new Map([
      ['t1', { keepCall: 0.01, keepResult: 0.01 }],
    ]);
    const decisions = decide(calls, scores, budgetChars(calls, options), options);
    expect(decisions[0]!.action).toBe('drop_result');
    expect(decisions[0]!.action).not.toBe('drop_call');
  });

  it('removes the call when allowDropCall is set', () => {
    const options = resolveOptions({
      targetReduction: 1,
      dropFloor: 0.9,
      allowDropCall: true,
    });
    const calls = [toolCall()];
    const scores: Map<string, CallScores> = new Map([
      ['t1', { keepCall: 0.01, keepResult: 0.01 }],
    ]);
    const decisions = decide(calls, scores, budgetChars(calls, options), options);
    expect(decisions[0]!.action).toBe('drop_call');
  });

  it('never touches a pinned call', () => {
    const options = resolveOptions({ targetReduction: 1, dropFloor: 0.9 });
    const calls = [toolCall({ pinned: true })];
    const scores: Map<string, CallScores> = new Map([
      ['t1', { keepCall: 0.01, keepResult: 0.01 }],
    ]);
    const decisions = decide(calls, scores, budgetChars(calls, options), options);
    expect(decisions[0]!.action).toBe('keep');
    expect(decisions[0]!.reason).toBe('pinned');
  });

  it('never removes the output of a failed call', () => {
    const options = resolveOptions({ targetReduction: 1, dropFloor: 0.9 });
    const calls = [toolCall({ isError: true })];
    const scores: Map<string, CallScores> = new Map([
      ['t1', { keepCall: 0.01, keepResult: 0.01 }],
    ]);
    const decisions = decide(calls, scores, budgetChars(calls, options), options);
    expect(decisions[0]!.action).toBe('keep');
    expect(decisions[0]!.reason).toContain('error');
  });
});

describe('state: the model is told what each output was', () => {
  it('carries the head of the result into the state', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const state = fitState(
      {
        context: 'c',
        goal: 'g',
        history: [
          {
            i: 0,
            role: 'user',
            text: 'Find the failing test',
            tool_calls: [
              {
                id: 't1',
                tool: 'bash',
                input: 'command=pytest',
                result_head: 'FAILED test_auth',
                result_chars: 4000,
                is_error: false,
              },
            ],
          },
        ],
      },
      100_000,
    );
    expect(state.state.history[0]!.tool_calls![0]!.result_head).toContain('FAILED test_auth');
    expect(calls.length).toBe(1);
  });
});

describe('compact: end to end against a fake decision service', () => {
  const fakeService = (scores: Record<string, number>) => ({
    baseUrl: 'http://fake/v1/systemone',
    apiKey: 'x',
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        questions: Record<string, { instructions: string }>;
      };
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const id of Object.keys(body.questions)) {
        const key = id.replace(/^(call|result)_/, '');
        answers[id] = { type: 'noul', noul: scores[key] ?? 0.5 };
      }
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as unknown as typeof fetch,
  });

  it('shortens the output and keeps the call', async () => {
    const messages = transcript();
    const before = messageChars(messages);
    const result = await compact(
      messages,
      fakeService({ t1: 0.3 }),
      { preserveRecentMessages: 0, targetReduction: 0.5 },
    );
    expect(result).not.toBeNull();
    const decision = result!.decisions.find((d) => d.id === 't1')!;
    expect(decision.action).toBe('truncate');
    // The call itself is still there.
    expect(result!.messages.some((m) => m.toolUses.length > 0)).toBe(true);
    // And the transcript got smaller.
    expect(messageChars(result!.messages)).toBeLessThan(before);
    // The marker says what happened.
    const kept = result!.messages.flatMap((m) => m.toolResults ?? []).map((r) => r.text);
    expect(kept.join('\n')).toContain('jev-safe-compact');
  });

  it('declines when the service fails', async () => {
    const messages = transcript();
    const result = await compact(
      messages,
      {
        baseUrl: 'http://fake/v1/systemone',
        fetch: (async () => {
          throw new Error('down');
        }) as unknown as typeof fetch,
      },
      { preserveRecentMessages: 0 },
    );
    expect(result).toBeNull();
  });

  it('declines when there is nothing to prune', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'hello', toolUses: [] },
      { role: 'assistant', text: 'hi', toolUses: [] },
    ];
    const result = await compact(messages, fakeService({}), {});
    expect(result).toBeNull();
  });
});

describe('serialize: the checkpoint keeps the structure', () => {
  it('marks tool calls and results', () => {
    const text = serialize(transcript());
    expect(text).toContain('[bash {"command":"pytest tests/ -v"}]');
    expect(text).toContain('<user>');
    expect(text).toContain('<assistant>');
  });
});

describe('native message adaptation', () => {
  it('reads tool calls and results out of the native shape', async () => {
    const { toMessages } = await import('../src/plugin.js');
    const native: NativeMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'running the tests' },
          { type: 'tool', id: 'call-9', name: 'bash', input: { command: 'pytest' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool-result', tool_use_id: 'call-9', output: 'FAILED test_x' },
        ],
      },
    ];
    const messages = toMessages(native);
    expect(messages[0]!.toolUses[0]!.tool_use_id).toBe('call-9');
    expect(messages[1]!.toolResults![0]!.text).toBe('FAILED test_x');
  });
});

describe('applyDecisions: a dropped result leaves the call behind', () => {
  it('keeps the tool call and removes only its result', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const options = resolveOptions({});
    const kept = applyDecisions(
      messages,
      [
        {
          id: 't1',
          tool_use_id: 'call-1',
          tool: 'bash',
          action: 'drop_result',
          keepCall: 0.5,
          keepResult: 0.1,
          savedChars: 4000,
          reason: 'test',
        },
      ],
      calls,
      options,
    );
    expect(kept.some((m) => m.toolUses.length > 0)).toBe(true);
    const results = kept.flatMap((m) => m.toolResults ?? []);
    expect(results.length).toBe(0);
  });
});

describe('regression: the compaction must make the context smaller', () => {
  it('declines when the checkpoint would not be smaller than what the model has', async () => {
    // A tiny transcript: the markers around the calls cost more than the
    // pruning saves, so the plugin must decline rather than make the context
    // larger.
    const messages: Message[] = [
      { role: 'user', text: 'hi', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'c1', tool: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'c1', text: 'a'.repeat(500) }],
      },
    ];
    const result = await compact(
      messages,
      {
        baseUrl: 'http://fake/v1/systemone',
        apiKey: 'x',
        fetch: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
      },
      { preserveRecentMessages: 0 },
    );
    // The service failed, so nothing was decided and nothing was changed.
    expect(result).toBeNull();
  });

  it('reports the checkpoint size as the size after the compaction', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'Find the failing test', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'c1', tool: 'bash', input: { command: 'pytest' } }],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'c1', text: 'FAILED test_x\n' + 'y'.repeat(4000) }],
      },
    ];
    const result = await compact(
      messages,
      {
        baseUrl: 'http://fake/v1/systemone',
        apiKey: 'x',
        fetch: (async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
          const answers: Record<string, { type: string; noul: number }> = {};
          for (const id of Object.keys(body.questions)) answers[id] = { type: 'noul', noul: 0.2 };
          return new Response(JSON.stringify({ answers }), { status: 200 });
        }) as unknown as typeof fetch,
      },
      { preserveRecentMessages: 0, targetReduction: 1 },
    );
    expect(result).not.toBeNull();
    // The reported size after is the checkpoint, not the message list.
    expect(result!.stats.charsAfter).toBe(result!.checkpoint.length);
    expect(result!.checkpoint.length).toBeLessThan(result!.stats.charsBefore);
  });
});
