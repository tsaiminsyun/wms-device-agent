// Windows 打包版啟動模型（僅 Windows＋SEA；開發與 macOS 不變）：
// 雙擊 exe →「完全不開視窗」：本行程只當啟動器——代理未在執行就另起脫離主控台的背景工作實例
// （無視窗、掛系統匣圖示），然後立刻結束；已在執行則直接結束（不重複啟動）。
// log 一律寫檔（agent.log＋logs/ 每日輪替檔），檢視走系統匣「開啟 Log」。
// 環境變數：WMS_AGENT_WORKER=1（背景工作實例旗標）、WMS_LAUNCHER_QUIET=1（排程啟動用，行為相同）、
//           WMS_NO_DETACH=1（逃生開關：單行程直跑）。

import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isSeaBuild } from "./nativeRequire.js";
import type { Logger } from "../logger.js";

const pexec = promisify(execFile);

const WORKER_FLAG = "WMS_AGENT_WORKER";

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

/** Windows 打包版進入點分流。true＝本行程是啟動器（已交棒、即將自然結束），呼叫端別啟動代理；false＝本行程實跑代理。 */
export async function runWindowsLauncherIfNeeded(healthUrl: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (!isSeaBuild()) return false;
  if (process.env[WORKER_FLAG] === "1") return false;
  if (process.env.WMS_NO_DETACH === "1") return false;

  const exeDir = dirname(process.execPath);
  const logPath = join(exeDir, "agent.log");

  // 靜默啟動器：未在執行才起背景實例；不開任何視窗，交棒後本行程自然結束。
  const already = await isAgentRunning(healthUrl);
  if (!already) spawnWorker(exeDir, logPath);

  // 排程（開機自動啟動）模式：立即退出，不等事件迴圈收尾。
  if (process.env.WMS_LAUNCHER_QUIET === "1") {
    process.exit(0);
  }
  return true;
}

/**
 * 以使用者預設程式開啟資料夾／檔案／URL。走 explorer.exe（GUI 程式）：
 * 不經 cmd 不閃主控台，也不受 STARTUPINFO SW_HIDE 傳染影響。僅 Windows。
 */
export function openWithShell(target: string, log: Logger): void {
  if (process.platform !== "win32") return;
  try {
    const child = spawn("explorer.exe", [target], { stdio: "ignore" });
    child.on("error", (err) => log.warn(`開啟失敗（${target}）：`, err));
    child.unref();
  } catch (err) {
    log.warn(`開啟失敗（${target}）：`, err);
  }
}

/**
 * 完全結束時清掉相關程序（僅 Windows）：其他同名 exe 實例（排除自己）與工作列 helper。
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
  log.info("結束：關閉相關程序…");
  await run(["/F", "/T", "/IM", image, "/FI", `PID ne ${process.pid}`]);
  // 收掉工作列 helper（若 tray.stop() 尚未讓它退出）。
  await run(["/F", "/IM", "tray_windows_release.exe"]);
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
