export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function emit(level: string, scope: string, msg: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...meta });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, meta) => emit("debug", scope, msg, meta),
    info: (msg, meta) => emit("info", scope, msg, meta),
    warn: (msg, meta) => emit("warn", scope, msg, meta),
    error: (msg, meta) => emit("error", scope, msg, meta),
  };
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
