// 極簡分級 logger（無第三方相依）。只產生一個每日日期檔 wms-agent-YYYY-MM-DD.log——
// 使用者面精選檔：只收 user() 的少數精選訊息（乾淨、好懂，僅時間＋訊息），狀態視窗 tail 的就是它、
// 使用者打開的也是它。技術細節（版本、scope、晶片 ID、WS 連線數、錯誤堆疊等）「不」寫檔，只在開發時印主控台。
// log() 分級：debug/info/warn/error 與 notice → 僅主控台（非精選模式）、不寫檔；user → 寫進精選檔＋主控台。

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { homedir } from "node:os";
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
// 精選模式：只輸出 notice()，其餘一律略過；logLevel="debug" 才關閉精選、顯示完整 log。
let curated = true;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  curated = level !== "debug";
}

// 兩位數補零。
const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 使用者面（精選）日期 log 檔名：wms-agent-YYYY-MM-DD.log。
 * 只收 user() 的精選訊息（乾淨、好懂），狀態視窗即 tail 這個檔、使用者打開的也是它。
 */
export function logFileName(d = new Date()): string {
  return `wms-agent-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}.log`;
}

/**
 * 預設 log 目錄：使用者「文件」夾下的 wms-device-agent\logs。
 * 放在使用者可寫、好找的位置（而非安裝目錄 Program Files——那需要提權才寫得進、也不好找）。
 * homedir()＝%USERPROFILE%（登入使用者，程式在其工作階段以其身分執行）。目錄不存在會自動建立。
 */
export function defaultLogDir(): string {
  return join(homedir(), "Documents", "wms-device-agent", "logs");
}

// ---- 檔案輸出（每日輪替）----
// 只有一個檔：使用者面精選檔（user()）。技術細節不寫檔。
let fileDir: string | null = null;
let fileFd: number | null = null;
let fileDate = ""; // 目前開啟檔對應的 YYYY-MM-DD，跨日即輪替

/** 啟用檔案 log：往 dir 寫每日精選日期檔，跨日自動換檔。dir 不存在會自動建立。 */
export function initFileLogging(dir: string): void {
  // 目錄變更時關掉舊 fd，讓下次寫入在新目錄重開。
  if (fileFd !== null) {
    try {
      closeSync(fileFd);
    } catch {
      /* 忽略 */
    }
    fileFd = null;
    fileDate = "";
  }
  fileDir = dir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 建立失敗（權限等）：writeToFile 開檔時會再失敗並靜默略過，不拖垮流程 */
  }
}

function writeToFile(line: string): void {
  if (!fileDir) return;
  try {
    const name = logFileName();
    const date = name.slice(-"YYYY-MM-DD.log".length, -".log".length);
    if (fileFd === null || date !== fileDate) {
      if (fileFd !== null) closeSync(fileFd);
      fileFd = openSync(join(fileDir, name), "a");
      fileDate = date;
    }
    writeSync(fileFd, line + "\n");
  } catch {
    /* log 寫檔失敗不可反過來拖垮流程 */
  }
}

// 時間戳（本地時間）：yyyy/mm/dd hh:mm:ss。
function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// debug/info/warn/error：技術細節，只在非精選模式印主控台（開發用），「不」寫檔。
function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < threshold) return;
  if (!curated) {
    const prefix = `${timestamp()} ${level.toUpperCase().padEnd(5)} [${scope}]`;
    const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    sink(prefix, ...args);
  }
}

// notice：內部重要事件，只印主控台（開發用），不寫檔——避免技術細節洗版狀態視窗，也不產生技術 log 檔。
function emitNotice(scope: string, args: unknown[]): void {
  console.log(`${timestamp()} [${scope}]`, ...args);
}

// user：使用者面精選訊息（乾淨、好懂）。寫進精選檔（狀態視窗顯示的就是它，僅時間＋訊息、不含 scope／等級）
// 並印主控台。永遠輸出，不受 curated / threshold 影響。
function emitUser(scope: string, args: unknown[]): void {
  const ts = timestamp();
  console.log(`${ts} [${scope}]`, ...args);
  writeToFile(`${ts} ${format(...args)}`);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** 內部重要事件：完整技術檔會記錄，但不顯示在使用者面狀態視窗。 */
  notice(...args: unknown[]): void;
  /** 使用者面精選訊息：顯示在狀態視窗（乾淨、好懂），並留底於完整技術檔。僅用於少數重要訊息。 */
  user(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit("debug", scope, a),
    info: (...a) => emit("info", scope, a),
    warn: (...a) => emit("warn", scope, a),
    error: (...a) => emit("error", scope, a),
    notice: (...a) => emitNotice(scope, a),
    user: (...a) => emitUser(scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
