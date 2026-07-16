// 極簡分級 logger（無第三方相依）。

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold = LEVEL_ORDER.info;
// 精選模式：只輸出 notice()，其餘一律略過；logLevel="debug" 才關閉精選、顯示完整 log。
let curated = true;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  curated = level !== "debug";
}

// 時間戳（本地時間）：yyyy/mm/dd hh:mm:ss。
function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (curated) return; // 精選模式：一般 log 全部靜音（只留 notice）
  if (LEVEL_ORDER[level] < threshold) return;
  const prefix = `${timestamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(prefix, ...args);
}

// 精選事件：永遠輸出，不受 curated / threshold 影響。
function emitNotice(scope: string, args: unknown[]): void {
  const prefix = `${timestamp()} [${scope}]`;
  console.log(prefix, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** 精選事件：無論 log 等級都會輸出。僅用於使用者關心的少數訊息。 */
  notice(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
    notice: (...a) => emitNotice(scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
