/**
 * Two checks the user's question raises:
 *
 * 1. Is the content after a truncation really gone from the context the model
 *    sees afterwards? (It has to be — otherwise nothing was compressed.)
 * 2. What happens in a session where the narration is a large share of the
 *    context, rather than the tool output?
 */

import { describe, expect, it } from 'vitest';
import { compact, messageChars, resolveOptions, serialize } from '../src/compact.js';
import type { Message } from '../src/types.js';

const SECRET = 'THIS-MIDDLE-PART-MUST-NOT-SURVIVE';
const END_MARKER = 'AND-THIS-TAIL-MUST-SURVIVE';

function fakeService(score: number) {
  return {
    baseUrl: 'http://fake/v1/systemone',
    apiKey: 'x',
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const answers: Record<string, { type: string; noul: number }> = {};
      for (const id of Object.keys(body.questions)) answers[id] = { type: 'noul', noul: score };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as unknown as typeof fetch,
  };
}

describe('the truncation really removes the content', () => {
  it('the middle of a shortened output is not in the checkpoint', async () => {
    const long = `${'a'.repeat(500)}${SECRET}${'b'.repeat(500)}${'c'.repeat(500)}${END_MARKER}`;
    const messages: Message[] = [
      { role: 'user', text: 'do the thing', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'c1', tool: 'bash', input: { command: 'x' } }],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'c1', text: long }],
      },
    ];

    const result = await compact(
      messages,
      fakeService(0.5),
      resolveOptions({ preserveRecentMessages: 0, targetReduction: 1, truncateHeadChars: 300, truncateTailChars: 150 }),
    );
    expect(result).not.toBeNull();
    const checkpoint = serialize(result!.messages);

    console.log(`  original output: ${long.length} chars`);
    console.log(`  checkpoint      : ${checkpoint.length} chars`);
    console.log(`  middle present  : ${checkpoint.includes(SECRET)}`);
    console.log(`  head present    : ${checkpoint.includes('a'.repeat(200))}`);
    console.log(`  tail present    : ${checkpoint.includes(END_MARKER)}`);
    console.log(`  marker present  : ${checkpoint.includes('jev-safe-compact')}`);

    // The middle is gone, the head and tail are kept, and the model is told.
    expect(checkpoint).not.toContain(SECRET);
    expect(checkpoint).toContain(END_MARKER);
    expect(checkpoint).toContain('jev-safe-compact');
  });
});

describe('a session where the narration is a large share', () => {
  it('reports how much of the context the plugin cannot touch', async () => {
    const messages: Message[] = [
      { role: 'user', text: 'Investigate why the test fails.', toolUses: [] },
    ];
    // Twelve turns of narration, each a few hundred characters.
    for (let i = 0; i < 12; i++) {
      messages.push({
        role: 'assistant',
        text: `Turn ${i}: I looked at the code and here is what I concluded about the situation. `.repeat(6),
        toolUses: [],
      });
      messages.push({
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: `c${i}`, tool: 'bash', input: { command: `cmd${i}` } }],
      });
      messages.push({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: `c${i}`, text: `output ${i} `.repeat(60) }],
      });
    }

    let outputChars = 0;
    let textChars = 0;
    for (const m of messages) {
      textChars += m.text.length;
      for (const r of m.toolResults ?? []) outputChars += r.text.length;
    }
    const before = messageChars(messages);

    const result = await compact(
      messages,
      fakeService(0.2),
      resolveOptions({ preserveRecentMessages: 1, targetReduction: 1 }),
    );
    const checkpoint = result ? serialize(result.messages) : '';

    console.log(`\n  narration-heavy session:`);
    console.log(`    tool output : ${outputChars} (${((outputChars / before) * 100).toFixed(1)}%)`);
    console.log(`    narration   : ${textChars} (${((textChars / before) * 100).toFixed(1)}%)`);
    console.log(`    total       : ${before}`);
    console.log(`    after       : ${checkpoint.length}`);
    console.log(`    reduction   : ${(((before - checkpoint.length) / before) * 100).toFixed(1)}%`);
    console.log(`    narration removed: ${result?.stats.narrationsRemoved ?? 0}/${result?.stats.narrationsKept ?? 0 + (result?.stats.narrationsRemoved ?? 0)}`);

    // The point: the context the model reads afterwards is smaller.
    expect(checkpoint.length).toBeLessThan(before);
  });
});
