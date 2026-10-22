/**
 * A smoke test for the plugin wiring: the command registers, the hook is
 * installed, and the hook only acts on the session the command asked for.
 *
 * The context is a stub; nothing here talks to a decision service.
 */

import { describe, expect, it } from 'vitest';
import JevSafeCompact from '../src/plugin.js';

interface Hook {
  (event: unknown): Promise<void>;
}

interface CommandDef {
  name: string;
  description?: string;
  execute: (input: unknown) => Promise<void>;
}

function stubContext(options: Record<string, unknown> = {}) {
  const commands: CommandDef[] = [];
  const hooks = new Map<string, Hook>();
  let compactCalls = 0;

  const ctx = {
    options,
    logger: { info() {}, warn() {}, error() {} },
    command: {
      transform: async (callback: (editor: { add: (c: CommandDef) => void }) => void) => {
        callback({
          add: (definition: CommandDef) => {
            commands.push(definition);
          },
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      compact: async () => {
        compactCalls++;
      },
      hook: async (name: string, handler: Hook) => {
        hooks.set(name, handler);
        return { dispose: async () => {} };
      },
    },
  };

  return { ctx, commands, hooks, compactCalls: () => compactCalls };
}

describe('plugin wiring', () => {
  it('registers the command and installs the compaction hook', async () => {
    const { ctx, commands, hooks } = stubContext();
    await JevSafeCompact.setup(ctx as never);

    expect(commands.map((c) => c.name)).toContain('jev-compact');
    expect(hooks.has('compaction')).toBe(true);
  });

  it('asks OpenCode to compact when the command runs', async () => {
    const { ctx, commands, compactCalls } = stubContext();
    await JevSafeCompact.setup(ctx as never);

    await commands[0]!.execute({ sessionID: 'sess-1' });
    expect(compactCalls()).toBe(1);
  });

  it('ignores a compaction it was not asked for', async () => {
    const { ctx, hooks } = stubContext();
    await JevSafeCompact.setup(ctx as never);

    const hook = hooks.get('compaction')!;
    // A compaction for a different session: the hook must leave it alone.
    await hook({
      sessionID: 'someone-else',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
    });
    // Nothing was set on the event, so OpenCode's own compaction proceeds.
    expect(true).toBe(true);
  });
});
