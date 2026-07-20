// Windows 服務註冊/控制（NSSM）：--install-service / --uninstall-service 由安裝程式
// （Inno Setup，以系統管理員權限）呼叫。NSSM 以 WMS_RUN_MODE=service 執行本 SEA exe（見 runMode.ts），
// 故服務子行程就是代理本體。異常自動重啟由 NSSM（AppExit Restart）與 SCM 復原設定（sc failure）雙層保證。

import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { isSeaBuild } from "./nativeRequire.js";
import type { Logger } from "../logger.js";

const pexec = promisify(execFile);

/** Windows 服務名稱（NSSM 與 sc 指令共用；不含空白）。 */
export const SERVICE_NAME = "WMSDeviceAgent";

const INSTALL_TIMEOUT_MS = 60_000;

// 預設服務 SDDL ＋ 授權 Authenticated Users（AU）啟動/停止（RP=start、WP=stop），
// 讓工作列元件「重啟服務」不需 UAC。安裝程式以系統管理員執行 sdset。
const SERVICE_SDDL =
  "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)" +
  "(A;;CCLCSWRPWPLORC;;;AU)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)";

/** 隨 exe 出貨的 nssm.exe 路徑（與 exe 同層，由 build-win.sh 放入）。 */
function nssmPath(): string {
  return join(dirname(process.execPath), "nssm.exe");
}

/** 執行一個 nssm 子指令；ignoreError=true 時吞掉錯誤（用於冪等的 stop/remove）。 */
async function nssm(args: string[], ignoreError = false): Promise<void> {
  try {
    await pexec(nssmPath(), args, { windowsHide: true, timeout: INSTALL_TIMEOUT_MS });
  } catch (err) {
    if (!ignoreError) throw err;
  }
}

function assertSea(): void {
  if (process.platform !== "win32" || !isSeaBuild()) {
    throw new Error("服務註冊僅支援 Windows 打包版（wms-device-agent.exe）。");
  }
}

/** 用 NSSM 註冊 Windows 服務並啟動（冪等：先移除舊設定）。接著套用 SCM 自動重啟與使用者啟停授權。 */
export async function installService(log: Logger): Promise<void> {
  assertSea();
  log.notice(`註冊 Windows 服務 ${SERVICE_NAME}…`);
  const exe = process.execPath;
  const exeDir = dirname(exe);
  // 冪等：若已存在先停掉並移除，確保設定乾淨。
  await nssm(["stop", SERVICE_NAME], true);
  await nssm(["remove", SERVICE_NAME, "confirm"], true);
  // NSSM 直接以本 SEA exe 為服務程式（無引數；服務角色由下方環境變數決定，見 runMode.ts）。
  await nssm(["install", SERVICE_NAME, exe]);
  await nssm(["set", SERVICE_NAME, "AppDirectory", exeDir]);
  await nssm(["set", SERVICE_NAME, "DisplayName", "WMS Device Agent"]);
  await nssm(["set", SERVICE_NAME, "Description", "WMS 裝置代理：掃碼槍／電子秤 → 本機 WebSocket/HTTP；異常自動重啟。"]);
  await nssm(["set", SERVICE_NAME, "Start", "SERVICE_AUTO_START"]);
  // 服務模式：單行程、無視窗（見 runMode.ts）。NSSM 以多個 KEY=VALUE 設定 AppEnvironmentExtra。
  await nssm(["set", SERVICE_NAME, "AppEnvironmentExtra", "WMS_RUN_MODE=service", "WMS_NO_DETACH=1"]);
  // 子行程異常結束 → NSSM 自動重啟（節流 5s，避免狂重啟洗資源）。
  await nssm(["set", SERVICE_NAME, "AppExit", "Default", "Restart"]);
  await nssm(["set", SERVICE_NAME, "AppRestartDelay", "5000"]);
  await nssm(["set", SERVICE_NAME, "AppThrottle", "5000"]);
  await hardenService(log);
  await nssm(["start", SERVICE_NAME]);
  log.notice("服務註冊完成（開機自動啟動、異常自動重啟）。");
}

/** 用 NSSM 解除 Windows 服務（會先停止；不存在也視為成功）。 */
export async function uninstallService(log: Logger): Promise<void> {
  assertSea();
  log.notice(`解除 Windows 服務 ${SERVICE_NAME}…`);
  await nssm(["stop", SERVICE_NAME], true);
  await nssm(["remove", SERVICE_NAME, "confirm"], true);
  log.notice("服務已解除。");
}

/** SCM 層自動重啟（服務程序異常結束 5s/10s/60s 後重啟；每日歸零）＋授權一般使用者啟停。 */
async function hardenService(log: Logger): Promise<void> {
  const sc = async (args: string[], what: string): Promise<void> => {
    try {
      await pexec("sc", args, { windowsHide: true });
    } catch (err) {
      log.warn(`sc ${what} 設定失敗（不影響服務本體）：`, err);
    }
  };
  await sc(["failure", SERVICE_NAME, "reset=", "86400", "actions=", "restart/5000/restart/10000/restart/60000"], "failure");
  await sc(["failureflag", SERVICE_NAME, "1"], "failureflag"); // 非 crash 的自行退出也觸發復原動作
  await sc(["sdset", SERVICE_NAME, SERVICE_SDDL], "sdset");
}

async function queryServiceState(): Promise<string> {
  const { stdout } = await pexec("sc", ["query", SERVICE_NAME], { windowsHide: true });
  return stdout; // 狀態關鍵字（RUNNING/STOPPED/…）不隨語系在地化
}

/** 工作列「重啟服務」：直接 sc stop→start（安裝時已授權一般使用者）；失敗改走 UAC 提權重啟。 */
export async function restartServiceFromTray(log: Logger): Promise<void> {
  log.notice("重新啟動服務…");
  try {
    try {
      await pexec("sc", ["stop", SERVICE_NAME], { windowsHide: true });
    } catch {
      /* 服務本來就停著（1062）等：續走 start */
    }
    // 等服務真的停下（NSSM 收攤子行程需要一點時間），最多 10s。
    for (let i = 0; i < 20; i++) {
      if ((await queryServiceState()).includes("STOPPED")) break;
      await delay(500);
    }
    await pexec("sc", ["start", SERVICE_NAME], { windowsHide: true });
    log.notice("服務已重新啟動。");
  } catch (err) {
    log.warn("直接重啟失敗（可能未授權啟停），改以系統管理員權限重啟（會跳 UAC）…", err);
    elevatedRestart(log);
  }
}

/** 以 UAC 提權執行 sc stop→start（Shell.Application ShellExecute runas；wscript 無主控台不閃窗）。 */
function elevatedRestart(log: Logger): void {
  const vbsPath = join(tmpdir(), "wms-agent-restart-service.vbs");
  // ping 當延時（timeout.exe 在部分情境需可互動主控台）；視窗模式 0＝隱藏。
  const cmd = `/c sc stop ${SERVICE_NAME} & ping -n 6 127.0.0.1 >nul & sc start ${SERVICE_NAME}`;
  const vbs =
    `Set app = CreateObject("Shell.Application")\r\n` +
    `app.ShellExecute "cmd.exe", "${cmd}", "", "runas", 0\r\n`;
  try {
    writeFileSync(vbsPath, vbs, "utf8");
    const child = spawn("wscript.exe", ["//B", "//Nologo", vbsPath], { stdio: "ignore", windowsHide: true });
    child.on("error", (err) => log.warn("提權重啟啟動失敗：", err));
    child.unref();
  } catch (err) {
    log.warn("提權重啟失敗：", err);
  }
}

/** --install-service / --uninstall-service CLI 進入點；完成即結束行程。 */
export async function runServiceCli(install: boolean, log: Logger): Promise<never> {
  try {
    if (install) await installService(log);
    else await uninstallService(log);
    process.exit(0);
  } catch (err) {
    log.error(`${install ? "註冊" : "解除"}服務失敗：`, err);
    console.error(`${install ? "註冊" : "解除"}服務失敗：`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
