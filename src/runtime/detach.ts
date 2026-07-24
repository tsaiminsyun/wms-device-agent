// Windows 打包版「前台視窗＋背景工作實例」模型（僅 Windows＋SEA；開發與 macOS 不變）：
// 雙擊 exe → 本行程＝前台狀態視窗（顯示 log），並另起脫離主控台的背景工作實例（無視窗、掛系統匣）。
// 關鍵：主控台程式的 X 是強制終止無法攔截，故「不能被 X 關掉」的代理本體必須跑在脫離主控台的背景行程；
// 按 X 只關前台視窗，背景不受影響，真正結束走系統匣 Exit（優雅關閉、釋放序列埠）。
// 環境變數：WMS_AGENT_WORKER=1（背景工作實例旗標）、WMS_LAUNCHER_QUIET=1（隱藏自動啟動：本行程留下當監管者）、
//           WMS_FORCE_RESTART=1（重啟接手：跳過既有實例檢查、強制起新 worker）、WMS_NO_DETACH=1（逃生開關：單行程直跑）。

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { isSeaBuild } from "./nativeRequire.js";
import { createLogger, defaultLogDir, initFileLogging, logFileName, type Logger } from "../logger.js";

const pexec = promisify(execFile);

const WORKER_FLAG = "WMS_AGENT_WORKER";
const TAIL_INTERVAL_MS = 500;
const TAIL_BACKLOG_BYTES = 4096; // 開視窗時先帶出最近的 log
// 背景實例崩潰自動重生：時間窗內最多重生次數（超過即放棄，避免崩潰迴圈狂重生洗資源）與每次重生前的緩衝。
const RESPAWN_MAX = 5;
const RESPAWN_WINDOW_MS = 60_000;
const RESPAWN_BACKOFF_MS = 2_000;

// 前台狀態視窗的主控台標題（僅本檔使用）。
const STATUS_WINDOW_TITLE = "WMS Device Agent";

// log 目錄：與 worker（index.ts）一致——WMS_LOG_DIR 環境變數（config.logDir 亦沿用此變數）優先，
// 否則 exe 同層的 logs 子資料夾。監管者與狀態視窗都用它，確保寫檔／讀檔同一處。
function currentLogDir(): string {
  return process.env.WMS_LOG_DIR || defaultLogDir();
}

async function isAgentRunning(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnWorker(exeDir: string): void {
  // 背景實例脫離主控台（detached＋無視窗）；log 由背景實例自身寫進每日日期檔（見 logger.initFileLogging）。
  const child = spawn(process.execPath, [], {
    cwd: exeDir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, [WORKER_FLAG]: "1" },
  });
  child.unref();
}

// 起一個背景 worker 並等它結束，回傳結束碼（-1＝連 spawn 都失敗）。不 unref：監管者需收到 exit 事件。
function runWorkerToExit(exeDir: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [], {
      cwd: exeDir,
      detached: true, // 自成行程群組：監管者若被關掉，worker 不會被連帶砍
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, [WORKER_FLAG]: "1" },
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(-1));
  });
}

/**
 * 監管背景 worker：正常結束（code 0，來自優雅關閉／重啟接手）就停止；異常結束（崩潰）則記 log 後自動重生。
 * 時間窗內連續崩潰過多即放棄（避免崩潰迴圈）。監管者本身寫當日 log（呼叫端須先 initFileLogging）。
 */
async function superviseWorker(exeDir: string): Promise<void> {
  const log = createLogger("supervisor");
  const recent: number[] = []; // 近期崩潰時間戳（RESPAWN_WINDOW_MS 內）
  for (;;) {
    const code = await runWorkerToExit(exeDir);
    if (code === 0) return; // 優雅關閉／重啟接手 → 不再重生
    const now = Date.now();
    recent.push(now);
    while (recent.length && now - recent[0]! > RESPAWN_WINDOW_MS) recent.shift();
    if (recent.length > RESPAWN_MAX) {
      log.notice(`背景實例於 ${RESPAWN_WINDOW_MS / 1000}s 內連續異常結束 ${recent.length} 次，停止自動重生（請查 log 排除原因後手動重啟）。`);
      return;
    }
    log.notice(`背景實例異常結束（code ${code}），${RESPAWN_BACKOFF_MS / 1000}s 後自動重生（第 ${recent.length} 次）…`);
    await delay(RESPAWN_BACKOFF_MS);
  }
}

// 每 0.5s 把當日日期 log 的新增內容印到主控台；跨日自動改讀新檔。interval 讓事件迴圈存活＝視窗持續開著。
function tailLog(dir: string): void {
  let currentName = "";
  let pos = 0;
  setInterval(() => {
    try {
      const name = logFileName();
      const logPath = join(dir, name);
      if (name !== currentName) {
        // 首次或跨日換檔：改讀新日期檔，從其尾端 backlog 起。
        currentName = name;
        try {
          pos = Math.max(0, statSync(logPath).size - TAIL_BACKLOG_BYTES);
        } catch {
          pos = 0;
        }
      }
      const size = statSync(logPath).size;
      if (size < pos) pos = 0; // 檔被清空 → 從頭讀
      if (size > pos) {
        const fd = openSync(logPath, "r");
        try {
          const buf = Buffer.alloc(size - pos);
          readSync(fd, buf, 0, buf.length, pos);
          process.stdout.write(buf);
          pos = size;
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      /* 當日 log 尚未建立等，下輪再試 */
    }
  }, TAIL_INTERVAL_MS);
}

/** Windows 打包版進入點分流。true＝本行程是前台視窗或背景監管者（呼叫端別啟動代理）；false＝本行程實跑代理。 */
export async function runWindowsLauncherIfNeeded(healthUrl: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (!isSeaBuild()) return false;
  if (process.env[WORKER_FLAG] === "1") return false;
  if (process.env.WMS_NO_DETACH === "1") return false;

  const exeDir = dirname(process.execPath);

  // 隱藏自動啟動（登入工作）／重啟接手：本行程留下當「監管者」，背景 worker 崩潰時自動重生並記 log。
  if (process.env.WMS_LAUNCHER_QUIET === "1") {
    // 已有實例在跑（且由其自身監管者看顧）→ 本行程無事可做；重啟接手（FORCE）則跳過檢查、強制起新 worker 接手。
    if (process.env.WMS_FORCE_RESTART !== "1" && (await isAgentRunning(healthUrl))) process.exit(0);
    initFileLogging(currentLogDir()); // 監管者也要能把重生訊息寫進當日 log
    await superviseWorker(exeDir); // 阻塞在此監管；worker 正常收攤或連續崩潰放棄才返回
    process.exit(0);
  }

  // 前台狀態視窗：只顯示即時 log（使用者在場，不做監管）。無既有實例才起一個背景 worker。
  if (!(await isAgentRunning(healthUrl))) spawnWorker(exeDir);
  process.title = STATUS_WINDOW_TITLE;
  // 開窗即顯示狀態，避免尚無 log 輸出時一片空白。
  console.log("WMS Device Agent 正在啟動中...");
  console.log("");
  tailLog(currentLogDir());
  return true;
}

/**
 * 完全結束時清掉相關程序（僅 Windows）：其他同名 exe 實例（狀態視窗，排除自己）與工作列 helper。
 * 自己由呼叫端隨後 process.exit()。taskkill 失敗一律忽略（盡力而為）。
 */
export async function killRelatedProcesses(log: Logger): Promise<void> {
  if (process.platform !== "win32") return;
  const image = basename(process.execPath); // 通常為 wms-device-agent.exe
  const run = async (args: string[]): Promise<void> => {
    try {
      await pexec("taskkill", args, { windowsHide: true });
    } catch {
      /* 沒有符合的程序或無權限：忽略 */
    }
  };
  // 關掉其他同名實例，用 PID 過濾排除自己（自己最後才退出）。
  log.info("結束：關閉其他狀態視窗與相關程序…");
  await run(["/F", "/T", "/IM", image, "/FI", `PID ne ${process.pid}`]);
  // 收掉工作列 helper（若 tray.stop() 尚未讓它退出）。
  await run(["/F", "/IM", "tray_windows_release.exe"]);
}

/**
 * 工作列「開啟 Log」：另起 wms-device-agent.exe 當狀態視窗顯示即時 log（背景實例仍在跑，故只 tail 同一份當日日期檔）。
 * 直接啟動 exe 而非用 PowerShell 還原既有視窗：企業機常以群組原則封鎖 PowerShell，直接啟動最單純可預期。僅 Windows。
 */
export async function showStatusWindow(log: Logger): Promise<void> {
  if (process.platform !== "win32") return;
  log.info("開啟 Log：啟動狀態視窗（wms-device-agent.exe）。");
  // 清掉 WORKER／QUIET 旗標，確保新實例走前台狀態視窗分支並顯示視窗。
  const env = { ...process.env };
  delete env[WORKER_FLAG];
  delete env.WMS_LAUNCHER_QUIET;
  try {
    // 用 cmd start 開新主控台；start 首個引號字串會被當視窗標題，故固定空標題 ""，讓 exe 路徑被當成程式執行。
    // 【關鍵】絕不設 windowsHide:true——它會在 STARTUPINFO 帶入 SW_HIDE，經 cmd → start 傳染到新 exe 的
    // 主控台，使視窗「開了卻是隱藏的」。由 start 自建可見主控台；cmd 立即結束，背景實例無主控台故不閃視窗。
    const child = spawn("cmd", ["/c", "start", "", process.execPath], {
      cwd: dirname(process.execPath),
      stdio: "ignore",
      env,
    });
    // spawn 失敗是非同步事件（'error'）；未處理會讓背景實例崩潰，故必須攔下。
    child.on("error", (err) => log.warn("開啟狀態視窗失敗（spawn cmd/start）：", err));
    child.unref();
  } catch (err) {
    log.warn("開啟狀態視窗失敗：", err);
  }
}

/**
 * 工作列「重啟服務」：另起新的背景「監管者」實例；它會強制起新 worker，經 POST /shutdown 請本實例優雅關閉並接手，
 * 讓序列埠（電子秤 COM）乾淨釋放後重開，等同「關掉再開」的乾淨重連。新 worker 一樣受監管（崩潰自動重生）。僅 Windows＋SEA。
 */
export function restartWorker(log: Logger): void {
  if (process.platform !== "win32" || !isSeaBuild()) {
    log.warn("重啟服務僅支援 Windows 打包版。");
    return;
  }
  log.user("重啟服務中");
  log.debug("重啟服務：啟動新的背景實例（將接手並請求本實例優雅關閉）。");
  // 起「監管者」而非裸 worker，讓重啟後的 worker 仍受崩潰自動重生保護。清掉 WORKER 旗標並帶上 QUIET＋FORCE。
  const env = { ...process.env };
  delete env[WORKER_FLAG];
  env.WMS_LAUNCHER_QUIET = "1";
  env.WMS_FORCE_RESTART = "1";
  spawn(process.execPath, [], {
    cwd: dirname(process.execPath),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env,
  }).unref();
}
