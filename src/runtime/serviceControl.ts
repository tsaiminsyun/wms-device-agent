// Windows 服務註冊/控制（node-windows/winsw）：--install-service / --uninstall-service 由安裝程式
// （Inno Setup，以系統管理員權限）呼叫。服務以 WMS_RUN_MODE=service 執行本 exe（見 runMode.ts）。
// 註：winsw XML 的 executable＝安裝當下的 process.execPath＝本 SEA exe；exe 會忽略 wrapper.js
// 引數、直接跑內嵌 bundle，故服務子行程就是代理本體。自動重啟由 SCM 復原設定（sc failure）保證。

import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { isSeaBuild, nativeRequire } from "./nativeRequire.js";
import type { Logger } from "../logger.js";

const pexec = promisify(execFile);

/** Windows 服務名稱（sc 指令用；不含空白，node-windows 的 id 正規化後大小寫不敏感相符）。 */
export const SERVICE_NAME = "WMSDeviceAgent";

const INSTALL_TIMEOUT_MS = 60_000;

// 預設服務 SDDL ＋ 授權 Authenticated Users（AU）啟動/停止（RP=start、WP=stop），
// 讓工作列元件「重啟服務」不需 UAC。安裝程式以系統管理員執行 sdset。
const SERVICE_SDDL =
  "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)" +
  "(A;;CCLCSWRPWPLORC;;;AU)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)";

// node-windows 最小介面（選用相依，僅打包版使用）。
interface NwService {
  on(event: string, cb: (...args: unknown[]) => void): void;
  install(): void;
  uninstall(): void;
  start(): void;
}
interface NwModule {
  Service: new (cfg: {
    name: string;
    description: string;
    script: string;
    workingDirectory: string;
    env: { name: string; value: string }[];
  }) => NwService;
}

function makeService(): NwService {
  const mod = nativeRequire("node-windows") as NwModule;
  const exeDir = dirname(process.execPath);
  return new mod.Service({
    name: SERVICE_NAME,
    description: "WMS 裝置代理：掃碼槍／電子秤 → 本機 WebSocket/HTTP；異常自動重啟。",
    // winsw 需要一個存在的 script 檔；實際執行的是 SEA exe（會忽略此引數），本檔永不被載入。
    script: join(exeDir, "service-entry.cjs"),
    workingDirectory: exeDir,
    env: [
      { name: "WMS_RUN_MODE", value: "service" },
      { name: "WMS_NO_DETACH", value: "1" },
    ],
  });
}

function assertSea(): void {
  if (process.platform !== "win32" || !isSeaBuild()) {
    throw new Error("服務註冊僅支援 Windows 打包版（wms-device-agent.exe）。");
  }
}

/** 註冊 Windows 服務並啟動；已存在則視為成功。接著套用 SCM 自動重啟與使用者啟停授權。 */
export async function installService(log: Logger): Promise<void> {
  assertSea();
  log.notice(`註冊 Windows 服務 ${SERVICE_NAME}…`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服務註冊逾時")), INSTALL_TIMEOUT_MS);
    const svc = makeService();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    svc.on("install", () => {
      svc.start();
      done();
    });
    svc.on("alreadyinstalled", done);
    svc.on("invalidinstallation", () => {
      clearTimeout(timer);
      reject(new Error("服務安裝狀態異常（daemon 檔案不完整），請先解除安裝再重新安裝"));
    });
    svc.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    svc.install();
  });
  await hardenService(log);
  log.notice("服務註冊完成（開機自動啟動、異常自動重啟）。");
}

/** 解除 Windows 服務（會先停止）。 */
export async function uninstallService(log: Logger): Promise<void> {
  assertSea();
  log.notice(`解除 Windows 服務 ${SERVICE_NAME}…`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服務解除逾時")), INSTALL_TIMEOUT_MS);
    const svc = makeService();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    svc.on("uninstall", done);
    svc.on("alreadyuninstalled", done);
    svc.on("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    svc.uninstall();
  });
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
    // 等服務真的停下（winsw 收攤子行程需要一點時間），最多 10s。
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
