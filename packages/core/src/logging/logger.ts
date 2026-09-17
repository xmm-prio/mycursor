/**
 * Minimal structured logger.
 *
 * The interceptor runtime is injected into Cursor's own bundles, so it cannot
 * depend on a logging library and must not hold the process open. Everything
 * here is synchronous, dependency-free, and prefixed so a line is attributable
 * to a specific patched process when several are running at once.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogSink {
  write(level: LogLevel, line: string): void;
}

export const consoleSink: LogSink = {
  write(level, line) {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  },
};

export interface LoggerOptions {
  /** Short tag identifying the process, e.g. `agent-host` or `server`. */
  scope: string;
  level?: LogLevel;
  sink?: LogSink;
}

export class Logger {
  private readonly threshold: number;

  constructor(private readonly options: LoggerOptions) {
    this.threshold = LEVEL_WEIGHT[options.level ?? 'info'];
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${safeJson(fields)}` : '';
    const sink = this.options.sink ?? consoleSink;
    sink.write(level, `[mycursor:${this.options.scope}] ${message}${suffix}`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.emit('error', message, fields);
  }

  child(scope: string): Logger {
    return new Logger({ ...this.options, scope: `${this.options.scope}:${scope}` });
  }
}

/** Serialises log fields without ever throwing on a circular structure. */
function safeJson(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_key, item) => {
      if (item && typeof item === 'object') {
        if (seen.has(item as object)) return '[circular]';
        seen.add(item as object);
      }
      if (item instanceof Error) return { name: item.name, message: item.message };
      return item;
    }) ?? '';
  } catch {
    return '[unserialisable]';
  }
}
