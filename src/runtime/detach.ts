// Windows 打包版的「前台視窗＋背景工作實例」啟動模型：
//
//   使用者雙擊 exe ──> 本行程＝【前台狀態視窗】：顯示即時 log。
//                       └─ 另行啟動【背景工作實例】（detached、無視窗、掛系統匣圖示）。
//
//   ．按視窗右上角 X：只會關掉前台狀態視窗——背景實例不受影響，程式繼續在系統匣執行。
//     （Windows 對主控台程式的 X 是強制終止、無法攔截；因此「不能被 X 關掉的那個」
//      必須是脫離主控台的背景行程，這是唯一可靠的作法。）
//   ．要真正結束：系統匣圖示右鍵 →「結束程式 (Exit)」→ 背景實例優雅關閉（釋放序列埠）。
//   ．已在執行時再開 exe：不會重複啟動，只再開一個狀態視窗（tail 同一份 agent.log）。
//   ．系統匣「檢視 Log」：優先把這個狀態視窗還原並帶到前景（showStatusWindow），
//     找不到才另開一個新的狀態視窗——所以不會每次都疊出一堆視窗。
//
// 只在「Windows＋打包（SEA）」生效；開發（tsx/node）與 macOS 完全不變。
// 環境變數：WMS_AGENT_WORKER=1（內部旗標＝背景工作實例）、
//           WMS_LAUNCHER_QUIET=1（排程/開機自動啟動：啟動背景實例後直接退出，不留視窗）、
//           WMS_NO_DETACH=1（逃生開關：單行程直跑，回到傳統行為）。

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isSeaBuild } from "./nativeRequire.js";
import type { Logger } from "../logger.js";

const pexec = promisify(execFile);

const WORKER_FLAG = "WMS_AGENT_WORKER";
const TAIL_INTERVAL_MS = 500;
const TAIL_BACKLOG_BYTES = 4096; // 開視窗時先帶出最近的 log，方便看目前狀態

// 前台狀態視窗的主控台標題；工作列「檢視 Log」靠它找回同一個視窗（而非另開新視窗）。
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
  // 開新一輪之前，先清掉前一次執行留下的 log 檔（此時舊檔已無人持有，一定刪得掉）。
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

// 前台視窗的 log 追蹤：每 0.5s 讀出 agent.log 新增的內容印到主控台。
// interval 讓事件迴圈保持存活＝視窗持續開著，直到使用者關掉視窗。
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

/**
 * Windows 打包版進入點分流。回傳 true＝本行程是「前台狀態視窗」（或已交棒退出），
 * 呼叫端不要啟動代理本體；回傳 false＝本行程就是要實際執行代理的行程。
 */
export async function runWindowsLauncherIfNeeded(healthUrl: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (!isSeaBuild()) return false;
  if (process.env[WORKER_FLAG] === "1") return false;
  if (process.env.WMS_NO_DETACH === "1") return false;

  const exeDir = dirname(process.execPath);
  const logPath = join(exeDir, "agent.log");

  const already = await isAgentRunning(healthUrl);
  if (!already) spawnWorker(exeDir, logPath);

  // 排程（開機自動啟動）模式：啟動背景實例即完成任務，不留視窗。
  if (process.env.WMS_LAUNCHER_QUIET === "1") {
    process.exit(0);
  }

  process.title = STATUS_WINDOW_TITLE;
  // 不顯示 detach 相關說明；開窗即顯示執行狀態，讓視窗在還沒有 log 輸出前也不會一片空白。
  console.log("WMS Device Agent 正在啟動中...");
  console.log("");
  tailLog(logPath);
  return true;
}

/**
 * 完全結束時清掉所有相關程序（Windows）：其他同名 exe 實例（狀態視窗等，排除自己）
 * 與工作列 helper。自己（背景工作實例）由呼叫端在此之後 process.exit()。
 * 只在 Windows 生效；taskkill 失敗一律忽略（盡力而為）。
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
  // 關掉其他同名實例（狀態／log 視窗），但用 PID 過濾排除自己（自己最後才退出）。
  log.info("結束：關閉其他狀態視窗與相關程序…");
  await run(["/F", "/T", "/IM", image, "/FI", `PID ne ${process.pid}`]);
  // 收掉工作列 helper（若 tray.stop() 尚未讓它退出）。
  await run(["/F", "/IM", "tray_windows_release.exe"]);
}

/**
 * 工作列「檢視 Log」：啟動一個新的 wms-device-agent.exe 實例當「狀態視窗」顯示即時 log。
 * health 已通（背景實例仍在執行）→ 新實例不會再起背景工作實例，只會 tail 同一份 agent.log。
 *
 * 為何直接啟動 exe（而非用 PowerShell/user32 找回既有視窗還原）：
 *   ．倉儲/企業機器常以群組原則（ExecutionPolicy／AppLocker）封鎖 PowerShell，
 *     使「還原既有視窗」的做法時靈時不靈——點了像沒反應。
 *   ．直接啟動 exe 是最單純、可預期、且不依賴 PowerShell 的做法：每次點都一定開得出視窗。
 * 只在 Windows 生效。
 */
export async function showStatusWindow(log: Logger): Promise<void> {
  if (process.platform !== "win32") return;
  log.info("檢視 Log：啟動狀態視窗（wms-device-agent.exe）。");
  // 清掉 WORKER／QUIET 旗標，確保新實例走「前台狀態視窗」分支並顯示視窗。
  const env = { ...process.env };
  delete env[WORKER_FLAG];
  delete env.WMS_LAUNCHER_QUIET;
  try {
    // 用 cmd start 開新主控台視窗。start 的第一個引號字串會被當成「視窗標題」，
    // 因此固定放空標題 ""，讓引號包住的 exe 路徑一定被解讀成「要執行的程式」而非標題
    // （視窗標題稍後由 exe 端 process.title=STATUS_WINDOW_TITLE 設定）。
    //
    // 【關鍵】絕不能設 windowsHide:true——它會在 STARTUPINFO 帶入 SW_HIDE，
    // 經 cmd → start 傳染到新 exe 的主控台，使視窗「開了卻是隱藏的」（看起來像沒反應）。
    // 由 start 自行建立可見的新主控台；cmd 立即結束，背景工作實例沒有主控台故不會閃視窗。
    const child = spawn("cmd", ["/c", "start", "", process.execPath], {
      cwd: dirname(process.execPath),
      stdio: "ignore",
      env,
    });
    // spawn 失敗是非同步事件（emit 'error'）；未處理會讓背景工作實例崩潰，故必須攔下。
    child.on("error", (err) => log.warn("開啟狀態視窗失敗（spawn cmd/start）：", err));
    child.unref();
  } catch (err) {
    log.warn("開啟狀態視窗失敗：", err);
  }
}

/**
 * 刪除 exe 同層的 log 檔（agent.log 與 agent.log.* 之類的輪替檔）。
 * 兩個時機呼叫：(1) 結束程式時清掉本次留下的 log；(2) 下次啟動新背景實例前，
 * 清掉前次殘留的 log（此時檔案已無人持有，一定刪得掉，可作為結束時未刪成功的後備）。
 * 只在 Windows＋打包（SEA）生效，避免在開發環境誤刪 node 執行檔旁的檔案。
 * 盡力而為：檔案仍被占用時 unlink 會失敗，歸入 failed，由下次啟動再清。
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
      failed.push(name); // 仍被占用（例如本行程自己的 stdout）：下次啟動再清
    }
  }
  return { removed, failed };
}
