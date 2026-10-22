/**
 * A small file logger.
 *
 * The plugin context has no logging facility, so diagnostics go to a file and
 * to the console. Never throws: a logging failure must not break a compaction.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function defaultLogPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'log', 'jev-safe-compact.log');
}

function serializeFields(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return '';
  try {
    return ' ' + JSON.stringify(fields);
  } catch {
    return ' [unserializable fields]';
  }
}

export function createLogger(filePath: string = defaultLogPath()): Logger {
  const path = resolve(filePath);

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const line =
      `${new Date().toISOString()} [${level.toUpperCase()}] [jev-safe-compact] ` +
      `${message}${serializeFields(fields)}`;
    const consoleMethod =
      level === 'info' ? console.info : level === 'warn' ? console.warn : console.error;
    try {
      consoleMethod(line);
    } catch {
      // Best effort only.
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`);
    } catch {
      // A logging failure must never break a compaction.
    }
  };

  return {
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
