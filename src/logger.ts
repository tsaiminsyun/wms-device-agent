// 極簡分級 logger（無第三方相依）＋每日輪替 log 檔（enableFileLog 啟用）。

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let threshold = LEVEL_ORDER.info;
// 精選模式：主控台只輸出 notice()，其餘一律略過；logLevel="debug" 才關閉精選、顯示完整 log。
// 注意：精選只影響「主控台」；log 檔（enableFileLog）永遠寫入達門檻的完整 log（含 warn/error），方便遠端除錯。
let curated = true;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  curated = level !== "debug";
}

// ---- 每日輪替 log 檔：<dir>/<prefix>-YYYY-MM-DD.log；啟用後每行同步附加寫入，過期檔自動清除。 ----

const FILE_RETENTION_DAYS = 14;

let fileDir: string | null = null;
let filePrefix = "wms-agent";
let fileDate = ""; // 目前寫入中的日期戳；跨日時切新檔並清舊檔
let filePath = "";

/** 啟用檔案輸出（每日輪替）。目錄建立失敗則維持僅主控台輸出。 */
export function enableFileLog(dir: string, prefix = "wms-agent"): void {
  try {
    mkdirSync(dir, { recursive: true });
    fileDir = dir;
    filePrefix = prefix;
    fileDate = "";
    cleanupOldLogFiles();
  } catch {
    fileDir = null;
  }
}

/** 目前的 log 檔完整路徑（未啟用回 null）；供「開啟 Log」等功能定位。 */
export function currentLogFile(): string | null {
  return fileDir ? resolveFilePath() : null;
}

/** 檔案輸出所在目錄（未啟用回 null）。 */
export function logFileDir(): string | null {
  return fileDir;
}

function dateStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function resolveFilePath(): string {
  const ds = dateStamp();
  if (ds !== fileDate) {
    fileDate = ds;
    filePath = join(fileDir as string, `${filePrefix}-${ds}.log`);
    cleanupOldLogFiles(); // 跨日輪替時順手清過期檔
  }
  return filePath;
}

function writeFileLine(line: string): void {
  if (!fileDir) return;
  try {
    appendFileSync(resolveFilePath(), line + "\n", "utf8");
  } catch {
    /* 檔案暫時寫不進（磁碟/權限）：不影響主控台輸出 */
  }
}

/** 刪除超過保留天數的輪替檔（依檔案修改時間）。 */
function cleanupOldLogFiles(): void {
  if (!fileDir) return;
  const cutoff = Date.now() - FILE_RETENTION_DAYS * 86_400_000;
  let entries: string[];
  try {
    entries = readdirSync(fileDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!/^[\w-]+-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = join(fileDir, name);
    try {
      if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
    } catch {
      /* 占用或已刪：略過 */
    }
  }
}

// 時間戳（本地時間）：yyyy/mm/dd hh:mm:ss。
function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const prefix = `${timestamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  writeFileLine(`${prefix} ${format(...args)}`); // 檔案：不受精選影響，完整保留 warn/error
  if (curated) return; // 精選模式：主控台的一般 log 全部靜音（只留 notice）
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(prefix, ...args);
}

// 精選事件：永遠輸出，不受 curated / threshold 影響。
function emitNotice(scope: string, args: unknown[]): void {
  const prefix = `${timestamp()} [${scope}]`;
  writeFileLine(`${prefix} ${format(...args)}`);
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
