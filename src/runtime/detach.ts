// Windows 打包版「前台視窗＋背景工作實例」模型（僅 Windows＋SEA；開發與 macOS 不變）：
// 雙擊 exe → 本行程＝前台狀態視窗（顯示 log），並另起脫離主控台的背景工作實例（無視窗、掛系統匣）。
// 關鍵：主控台程式的 X 是強制終止無法攔截，故「不能被 X 關掉」的代理本體必須跑在脫離主控台的背景行程；
// 按 X 只關前台視窗，背景不受影響，真正結束走系統匣 Exit（優雅關閉、釋放序列埠）。
// 環境變數：WMS_AGENT_WORKER=1（背景工作實例旗標）、WMS_LAUNCHER_QUIET=1（起背景後即退出、不留視窗）、
//           WMS_NO_DETACH=1（逃生開關：單行程直跑）。

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isSeaBuild } from "./nativeRequire.js";
import type { Logger } from "../logger.js";

const pexec = promisify(execFile);

const WORKER_FLAG = "WMS_AGENT_WORKER";
const TAIL_INTERVAL_MS = 500;
const TAIL_BACKLOG_BYTES = 4096; // 開視窗時先帶出最近的 log

// 前台狀態視窗的主控台標題。
export const STATUS_WINDOW_TITLE = "WMS Device Agent";

async function isAgentRunning(healthUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnWorker(exeDir: string, logPath: string): void {
  // 先清掉前次殘留的 log 檔（此時舊檔已無人持有，一定刪得掉）。
  cleanupLogFiles();
  // 背景實例脫離主控台（detached＋無視窗），輸出寫進 agent.log。
  let logFd: number | "ignore" = "ignore";
  try {
    logFd = openSync(logPath, "a");
  } catch {
    logFd = "ignore";
  }
  const child = spawn(process.execPath, [], {
    cwd: exeDir,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, [WORKER_FLAG]: "1" },
  });
  child.unref();
  if (typeof logFd === "number") closeSync(logFd); // 子行程已複製 fd，父行程這份可關
}

// 每 0.5s 把 agent.log 新增內容印到主控台；interval 讓事件迴圈存活＝視窗持續開著。
function tailLog(logPath: string): void {
  let pos = 0;
  try {
    pos = Math.max(0, statSync(logPath).size - TAIL_BACKLOG_BYTES);
  } catch {
    pos = 0;
  }
  setInterval(() => {
    try {
      const size = statSync(logPath).size;
      if (size < pos) pos = 0; // log 被清空/輪替 → 從頭讀
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
      /* agent.log 尚未建立等，下輪再試 */
    }
  }, TAIL_INTERVAL_MS);
}

/** Windows 打包版進入點分流。true＝本行程是前台狀態視窗（或已交棒退出），呼叫端別啟動代理；false＝本行程實跑代理。 */
export async function runWindowsLauncherIfNeeded(healthUrl: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (!isSeaBuild()) return false;
  if (process.env[WORKER_FLAG] === "1") return false;
  if (process.env.WMS_NO_DETACH === "1") return false;

  const exeDir = dirname(process.execPath);
  const logPath = join(exeDir, "agent.log");

  const already = await isAgentRunning(healthUrl);
  if (!already) spawnWorker(exeDir, logPath);

  // 排程模式：起背景實例即完成，不留視窗。
  if (process.env.WMS_LAUNCHER_QUIET === "1") {
    process.exit(0);
  }

  process.title = STATUS_WINDOW_TITLE;
  // 開窗即顯示狀態，避免尚無 log 輸出時一片空白。
  console.log("WMS Device Agent 正在啟動中...");
  console.log("");
  tailLog(logPath);
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
 * 工作列「檢視 Log」：另起 wms-device-agent.exe 當狀態視窗顯示即時 log（背景實例仍在跑，故只 tail 同一份 agent.log）。
 * 直接啟動 exe 而非用 PowerShell 還原既有視窗：企業機常以群組原則封鎖 PowerShell，直接啟動最單純可預期。僅 Windows。
 */
export async function showStatusWindow(log: Logger): Promise<void> {
  if (process.platform !== "win32") return;
  log.info("檢視 Log：啟動狀態視窗（wms-device-agent.exe）。");
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
 * 刪除 exe 同層的 log 檔（agent.log 及其輪替檔）。兩個時機：結束時清本次的、下次啟動前清前次殘留的。
 * 僅 Windows＋SEA（避免開發環境誤刪 node 旁檔案）。盡力而為：仍被占用而刪不掉的歸入 failed，下次再清。
 */
export function cleanupLogFiles(): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  if (process.platform !== "win32" || !isSeaBuild()) return { removed, failed };
  const dir = dirname(process.execPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { removed, failed };
  }
  for (const name of entries) {
    if (!/^agent\.log(\.|$)/i.test(name)) continue; // agent.log / agent.log.1 / agent.log.2026-…
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      failed.push(name); // 仍被占用（如本行程 stdout）：下次啟動再清
    }
  }
  return { removed, failed };
}
