/**
 * End-to-end check against a live `/v1/systemone` endpoint.
 *
 * Nothing here is mocked: the questions go to a real decision service and the
 * plugin's own code path runs over a synthetic transcript.
 *
 * The test is skipped unless the endpoint is named:
 *
 *   JEV_LIVE_ENDPOINT=http://127.0.0.1:8091/v1/systemone \
 *   JEV_LIVE_MODEL=StartLux-Decision-9B npx vitest run test/live.test.ts
 *
 * The CI run does not set these, so it stays skipped there.
 */

import { describe, expect, it } from 'vitest';
import { compact, messageChars, resolveOptions, serialize } from '../src/compact.js';
import type { Message } from '../src/types.js';

const endpoint = process.env.JEV_LIVE_ENDPOINT;
const model = process.env.JEV_LIVE_MODEL ?? 'jev-latest';

/** A transcript shaped like a real coding session. */
function transcript(): Message[] {
  const messages: Message[] = [
    {
      role: 'user',
      text: 'Fix the failing test TestLoginRejectsExpiredToken in internal/auth/auth_test.go, then run the test again.',
      toolUses: [],
    },
  ];
  const add = (
    callId: string,
    tool: string,
    input: Record<string, unknown>,
    result: string,
  ) => {
    messages.push({
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: callId, tool, input, text: result }],
    });
    messages.push({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: callId, text: result }],
    });
  };

  add('c1', 'bash', { command: 'ls -la' }, `drwxr-xr-x  25 lewisli staff 960 Sep 21 .\n${'x'.repeat(8000)}`);
  add('c2', 'read', { filePath: 'package.json' }, `{\n  "name": "homebrain",\n${'y'.repeat(1100)}`);
  add('c3', 'bash', { command: 'git log --oneline -50' }, `abc1234 feat: add plugin\n${'z'.repeat(2900)}`);
  add(
    'c4',
    'read',
    { filePath: 'internal/auth/auth_test.go' },
    `def test_rejects_expired_token():\n    with pytest.raises(ExpiredError):\n        client.login("expired-token")\n${'a'.repeat(4400)}`,
  );
  add(
    'c5',
    'bash',
    { command: 'pytest tests/auth -v' },
    `FAILED tests/auth/test_token.py::test_rejects_expired_token\nE   AssertionError: expected ExpiredError but got None\n${'b'.repeat(4000)}`,
  );
  add('c6', 'bash', { command: 'npm outdated' }, `Package Current Wanted Latest\n${'c'.repeat(700)}`);

  return messages;
}

describe.skipIf(!endpoint)('live: end to end against a real decision service', () => {
  it('prunes the transcript and keeps the evidence the next step needs', async () => {
    const messages = transcript();
    const before = messageChars(messages);

    const result = await compact(
      messages,
      { baseUrl: endpoint!, model, apiKey: process.env.JEV_LIVE_API_KEY ?? 'local' },
      resolveOptions({ preserveRecentMessages: 1, targetReduction: 0.5 }),
    );

    expect(result).not.toBeNull();
    const decisions = result!.decisions;

    // The two results the next step depends on must survive: the source file
    // and the failing test output.
    const keptTools = decisions.filter((d) => d.action === 'keep').map((d) => d.id);
    expect(keptTools).toContain('t4');
    expect(keptTools).toContain('t5');

    // The repository survey must not survive untouched.
    expect(decisions.find((d) => d.id === 't1')!.action).not.toBe('keep');

    // The transcript got smaller.
    expect(messageChars(result!.messages)).toBeLessThan(before);

    // The checkpoint keeps the calls that were made.
    const checkpoint = serialize(result!.messages);
    expect(checkpoint).toContain('[tool-call id=c4 name=read]');
    expect(checkpoint).toContain('[tool-call id=c5 name=bash]');
  }, 120_000);
});
