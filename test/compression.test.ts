/**
 * Does the compaction actually make the context smaller?
 *
 * The size that matters is the size of the checkpoint the model reads after
 * the compaction, not the size of the in-memory message list. This measures
 * that, across three session shapes, against a real decision service.
 *
 *   JEV_LIVE_ENDPOINT=http://127.0.0.1:8091/v1/systemone \
 *   JEV_LIVE_MODEL=StartLux-Decision-9B npx vitest run test/compression.test.ts
 */

import { describe, expect, it } from 'vitest';
import { compact, resolveOptions } from '../src/compact.js';
import type { Message } from '../src/types.js';

const endpoint = process.env.JEV_LIVE_ENDPOINT;
const model = process.env.JEV_LIVE_MODEL ?? 'jev-latest';

interface Shape {
  name: string;
  build: () => Message[];
}

/** A session where the tool output is nearly everything. */
const outputHeavy: Shape = {
  name: 'output heavy',
  build: () => {
    const messages: Message[] = [
      { role: 'user', text: 'Fix the failing test in internal/auth/auth_test.go.', toolUses: [] },
    ];
    const add = (id: string, tool: string, input: Record<string, unknown>, result: string, lead = '') => {
      if (lead) messages.push({ role: 'assistant', text: lead, toolUses: [] });
      messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] });
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: result }] });
    };
    add('c1', 'bash', { command: 'ls -la' }, 'x'.repeat(8000), 'Listing the files.');
    add('c2', 'read', { filePath: 'package.json' }, 'y'.repeat(1100));
    add('c3', 'bash', { command: 'git log --oneline -50' }, 'z'.repeat(2900));
    add('c4', 'read', { filePath: 'internal/auth/auth_test.go' }, `def test_rejects_expired_token():\n${'a'.repeat(4400)}`, 'Reading the test file.');
    add('c5', 'bash', { command: 'pytest tests/auth -v' }, `FAILED test_token\n${'b'.repeat(4000)}`);
    add('c6', 'bash', { command: 'npm outdated' }, 'c'.repeat(700));
    return messages;
  },
};

/** A session where the narration is a large share of the context. */
const narrationHeavy: Shape = {
  name: 'narration heavy',
  build: () => {
    const messages: Message[] = [
      { role: 'user', text: 'Investigate why the test fails.', toolUses: [] },
    ];
    for (let i = 0; i < 12; i++) {
      messages.push({
        role: 'assistant',
        text: `Turn ${i}: I checked the code and here is what I concluded about the situation. `.repeat(6),
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
    return messages;
  },
};

/** A session that mixes both, the way real work does. */
const mixed: Shape = {
  name: 'mixed',
  build: () => {
    const messages: Message[] = [
      { role: 'user', text: 'Investigate and fix the failing test.', toolUses: [] },
    ];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: 'assistant',
        text: `Step ${i}: I looked at the repository and the failing assertion. `.repeat(4),
        toolUses: [],
      });
      messages.push({
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: `c${i}`, tool: 'bash', input: { command: `pytest -k test${i}` } }],
      });
      messages.push({
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: `c${i}`, text: `FAILED test${i}\n${'r'.repeat(1500)}` }],
      });
    }
    return messages;
  },
};

describe.skipIf(!endpoint)('measurement: the context the model reads', () => {
  for (const shape of [outputHeavy, narrationHeavy, mixed]) {
    it(`shrinks the context: ${shape.name}`, async () => {
      const messages = shape.build();
      const before = messages.reduce(
        (sum, m) =>
          sum +
          m.text.length +
          m.toolUses.reduce((s, t) => s + JSON.stringify(t.input).length, 0) +
          (m.toolResults ?? []).reduce((s, r) => s + r.text.length, 0),
        0,
      );

      const result = await compact(
        messages,
        { baseUrl: endpoint!, model, apiKey: process.env.JEV_LIVE_API_KEY ?? 'local' },
        resolveOptions({ preserveRecentMessages: 1, targetReduction: 1 }),
      );

      expect(result).not.toBeNull();
      const after = result!.checkpoint.length;
      const pct = (((before - after) / before) * 100).toFixed(1);

      console.log(
        `  ${shape.name.padEnd(16)} ${String(before).padStart(7)} -> ${String(after).padStart(7)} chars  ` +
          `(${pct.padStart(6)}% smaller)  ` +
          `outputs:${result!.stats.dropped}/${result!.stats.truncated}  ` +
          `narration:${result!.stats.narrationsRemoved}/${result!.stats.narrationsKept + result!.stats.narrationsRemoved} removed`,
      );

      // The point of the exercise.
      expect(after).toBeLessThan(before);
    }, 180_000);
  }
});
