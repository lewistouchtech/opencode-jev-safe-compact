/**
 * How much context does the compaction actually save?
 *
 * The question that matters is not "how many bytes did we delete" but "how
 * much smaller is the context the model sees afterwards". This measures that
 * directly, by building the real checkpoint and measuring it.
 *
 *   npx vitest run test/measure-compression.test.ts
 */

import { describe, expect, it } from 'vitest';
import { compact, messageChars, resolveOptions, serialize } from '../src/compact.js';
import type { Message } from '../src/types.js';

/** A session shaped like real coding work: narration plus tool output. */
function transcript(): Message[] {
  const messages: Message[] = [
    { role: 'user', text: 'Fix the failing test TestLoginRejectsExpiredToken in internal/auth/auth_test.go, then run the test again.', toolUses: [] },
  ];
  const narrate = (text: string) => {
    messages.push({ role: 'assistant', text, toolUses: [] });
  };
  const add = (
    callId: string,
    tool: string,
    input: Record<string, unknown>,
    result: string,
    narration = '',
  ) => {
    if (narration) narrate(narration);
    messages.push({
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: callId, tool, input }],
    });
    messages.push({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: callId, text: result }],
    });
  };

  narrate('Let me look at the repository first.');
  add('c1', 'bash', { command: 'ls -la' }, 'x'.repeat(8000), 'Listing the files.');
  add('c2', 'read', { filePath: 'package.json' }, 'y'.repeat(1100));
  add('c3', 'bash', { command: 'git log --oneline -50' }, 'z'.repeat(2900));
  add('c4', 'read', { filePath: 'internal/auth/auth_test.go' }, `def test_rejects_expired_token():\n${'a'.repeat(4400)}`, 'Reading the test file.');
  add('c5', 'bash', { command: 'pytest tests/auth -v' }, `FAILED test_token\n${'b'.repeat(4000)}`);
  add('c6', 'bash', { command: 'npm outdated' }, 'c'.repeat(700));
  narrate('The failing assertion is about an expired token.');
  return messages;
}

const fakeService = (score: number) => ({
  baseUrl: 'http://fake/v1/systemone',
  apiKey: 'x',
  fetch: (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    const answers: Record<string, { type: string; noul: number }> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: 'noul', noul: score };
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as unknown as typeof fetch,
});

describe('measurement: does the context actually get smaller?', () => {
  it('reports the size the model sees before and after', async () => {
    const messages = transcript();
    const before = messageChars(messages);

    for (const reduction of [0.25, 0.5, 1.0]) {
      const result = await compact(
        messages,
        fakeService(0.2),
        resolveOptions({ preserveRecentMessages: 1, targetReduction: reduction }),
      );
      const checkpoint = result ? serialize(result.messages) : '';
      console.log(
        `  reduction=${reduction.toFixed(2)}  ` +
          `context ${before} -> ${checkpoint.length} chars ` +
          `(${(((before - checkpoint.length) / before) * 100).toFixed(1)}% smaller)  ` +
          `decisions=${result?.decisions.map((d) => `${d.id}:${d.action}`).join(',')}`,
      );
    }

    // How much of the original is narration and tool calls, which the plugin
    // never removes?
    let outputChars = 0;
    let callChars = 0;
    let textChars = 0;
    for (const m of messages) {
      textChars += m.text.length;
      for (const t of m.toolUses) callChars += JSON.stringify(t.input).length;
      for (const r of m.toolResults ?? []) outputChars += r.text.length;
    }
    console.log(`\n  breakdown of the original context:`);
    console.log(`    tool output   : ${outputChars}`);
    console.log(`    tool calls    : ${callChars}`);
    console.log(`    narration     : ${textChars}`);
    console.log(`    total         : ${before}`);
    console.log(`    output share  : ${((outputChars / before) * 100).toFixed(1)}%`);

    expect(true).toBe(true);
  });
});
