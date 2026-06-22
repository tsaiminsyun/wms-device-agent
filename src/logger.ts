// 極簡結構化 logger：帶時間戳與等級，不引入第三方相依。
// 等級門檻由 config 設定後呼叫 setLogLevel() 套用。

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold = LEVEL_ORDER.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
}

function ts(): string {
  // 不用 Date.now() 以外的 wall-clock 格式化即可；ISO 字串足夠人類閱讀。
  return new Date().toISOString();
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const prefix = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(prefix, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
