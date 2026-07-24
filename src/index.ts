// 進入點：設定 → 組裝裝置驅動/WS/HTTP/交警模式 → 啟動 → 優雅關閉。

import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Server as HttpServer } from "node:http";
import { loadConfig } from "./config.js";
import { createLogger, defaultLogDir, initFileLogging, setLogLevel, type Logger } from "./logger.js";
import { freePortIfOwnedByUs } from "./runtime/freePort.js";
import { installCrashGuards } from "./runtime/proc.js";
import { ensureAdminOrRelaunch } from "./runtime/elevate.js";
import { isSeaBuild } from "./runtime/nativeRequire.js";
import {
  runWindowsLauncherIfNeeded,
  killRelatedProcesses,
  restartWorker,
  showStatusWindow,
} from "./runtime/detach.js";
import { DeviceBus } from "./core/DeviceBus.js";
import { DeviceManager } from "./core/DeviceManager.js";
import { PortRegistry } from "./devices/serial/SerialDeviceDriver.js";
import { ScannerDriver } from "./devices/ScannerDriver.js";
import { ScaleDriver } from "./devices/ScaleDriver.js";
import { HidScannerDriver } from "./devices/HidScannerDriver.js";
import { KeyboardEmulator } from "./keyboard/KeyboardEmulator.js";
import { TrafficCop } from "./TrafficCop.js";
import { WsServer } from "./server/WsServer.js";
import { createApiServer } from "./server/httpApi.js";
import { PROTOCOL_VERSION, type AgentInfo } from "./server/protocol.js";
import { Tray } from "./tray/Tray.js";

// 打包（SEA）時由 esbuild --define 注入。
declare const __PKG_META__: { name: string; version: string } | undefined;

function readPackageMeta(): { name: string; version: string } {
  if (typeof __PKG_META__ !== "undefined") return __PKG_META__;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name?: string;
      version?: string;
    };
    return { name: pkg.name ?? "wms-device-agent", version: pkg.version ?? "0.0.0" };
  } catch {
    return { name: "wms-device-agent", version: "0.0.0" };
  }
}

// 監聽埠：被占用時重試；占用者若是本程式殘留實例則強制接管，逾上限才放棄。
async function listenWithRetry(server: HttpServer, port: number, host: string, log: Logger): Promise<void> {
  const MAX_ATTEMPTS = 10;
  const RETRY_DELAY_MS = 1000;
  const TAKEOVER_AT_ATTEMPT = 3; // 先給正常關閉緩衝，仍占用才接管
  let tookOver = false;
  for (let attempt = 1; ; attempt++) {
    try {
      server.listen(port, host);
      await once(server, "listening"); // 'error' 事件會使 once() reject
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EADDRINUSE") throw err;
      // 一次性接管：結束自己的殘留實例。
      if (attempt >= TAKEOVER_AT_ATTEMPT && !tookOver) {
        tookOver = true;
        if (await freePortIfOwnedByUs(port, log)) {
          await delay(RETRY_DELAY_MS); // 給 OS 一點時間回收
          continue;
        }
      }
      if (attempt < MAX_ATTEMPTS) {
        log.warn(`埠 ${host}:${port} 被占用（可能舊實例尚未釋放），${RETRY_DELAY_MS}ms 後重試（${attempt}/${MAX_ATTEMPTS}）…`);
        await delay(RETRY_DELAY_MS);
        continue;
      }
      throw new Error(
        `埠 ${host}:${port} 已被占用：可能有另一個 wms-device-agent 仍在執行。` +
          `請在工作管理員結束 wms-device-agent.exe（或執行 taskkill /IM wms-device-agent.exe /F）後再啟動。`,
      );
    }
  }
}

async function main(): Promise<void> {
  // Windows 打包版：強制以系統管理員身分執行（未提權則 UAC 重啟後結束本行程）。
  ensureAdminOrRelaunch();

  const config = loadConfig();

  // Windows 打包版分流：本行程可能只是前台狀態視窗，代理本體在脫離主控台的背景實例執行（見 detach.ts）。
  if (await runWindowsLauncherIfNeeded(`http://${config.server.host}:${config.server.port}/health`)) {
    return; // tail interval 會讓事件迴圈存活；視窗被關掉時本行程自然結束
  }

  setLogLevel(config.logLevel);
  const log = createLogger("agent");
  // 檔案 log：所有執行狀態與錯誤即時寫入日期檔。目錄取自 config.logDir（指定路徑）；
  // 未指定則打包版用 exe 同層的 logs 子資料夾（集中存放），開發環境不寫檔。
  // log 檔永久保留（不自動清除舊檔），便於事後回溯任何時間點的紀錄。
  const logDir = config.logDir || (isSeaBuild() ? defaultLogDir() : "");
  if (logDir) initFileLogging(logDir);
  const meta = readPackageMeta();
  // 程式啟動——狀態視窗第一條，讓使用者一眼看到服務「正在開啟」，並帶版本號便於辨識／回報。
  log.user(`${meta.name} v${meta.version} 啟動中`);
  // 全域防護：原生層（serialport/node-hid）在掃碼槍/電子秤拔插瞬間可能拋出未捕捉例外，
  // 記 log 後續跑、不讓行程崩潰（裝置重連交由各驅動的輪詢重試機制處理）。
  installCrashGuards(log);

  const agentInfo: AgentInfo = {
    name: meta.name,
    version: meta.version,
    platform: process.platform,
    protocolVersion: PROTOCOL_VERSION,
  };

  const bus = new DeviceBus();
  const deviceManager = new DeviceManager(bus, log);
  const registry = new PortRegistry();

  // ---- 組裝裝置驅動 ----
  if (config.scanner.enabled) {
    deviceManager.register(
      new ScannerDriver(
        bus,
        log,
        registry,
        { baudRate: config.scanner.baudRate, forcedPath: config.scanner.path, pollIntervalMs: config.serial.pollIntervalMs },
        config.scanner.vendorIds,
        config.scanner.dedupWindowMs,
      ),
    );
  }
  if (config.scale.enabled) {
    deviceManager.register(
      new ScaleDriver(
        bus,
        log,
        registry,
        { baudRate: config.scale.baudRate, forcedPath: config.scale.path, pollIntervalMs: config.serial.pollIntervalMs },
        config.scale.vendorIds,
        config.scanner.vendorIds,
      ),
    );
  }
  if (config.hidScanner.enabled) {
    deviceManager.register(
      new HidScannerDriver(bus, log, {
        vendorIds: config.hidScanner.vendorIds,
        usagePages: config.hidScanner.usagePages,
        reportHeaderBytes: config.hidScanner.reportHeaderBytes,
        dedupWindowMs: config.hidScanner.dedupWindowMs,
        pollIntervalMs: config.serial.pollIntervalMs,
      }),
    );
  }

  // ---- 伺服器 + 交警模式 ----
  const keyboard = new KeyboardEmulator(log, {
    enabled: config.keyboard.enabled,
    pressEnter: config.keyboard.pressEnter,
    paste: config.keyboard.paste,
  });
  // 背景預熱 nut.js，讓第一筆掃碼不必現場等載入初始化。
  keyboard.warmUp();

  const wsServer = new WsServer(bus, log, agentInfo, deviceManager, config.security, config.server.wsPath);
  const trafficCop = new TrafficCop(
    bus,
    log,
    keyboard,
    () => wsServer.hasActiveClaim(),
    (e) => wsServer.broadcastScan(e),
    { keyboardFallback: config.scanner.keyboardFallback },
  );

  // /shutdown 的回呼在 shutdown 定義後才接上（見下）。
  let requestShutdown: (() => void) | null = null;
  const httpServer = createApiServer({
    log,
    agentInfo,
    deviceManager,
    activeClientCount: () => wsServer.activeClientCount(),
    claimingClientCount: () => wsServer.claimingCount(),
    security: config.security,
    startedAt: Date.now(),
    onShutdownRequest: () => requestShutdown?.(),
  });
  wsServer.attach(httpServer);

  // 【重連關鍵】開序列埠前，先結束仍占用本埠的舊實例——它同時持有 COM 埠，
  // 不先清掉的話新實例會卡在「Cannot lock port」。這保證「關掉再開」電子秤一定能重連。
  if (await freePortIfOwnedByUs(config.server.port, log)) {
    await delay(1000); // 等 OS 回收舊實例的控制代碼（含 COM 埠）
  }

  // 訂閱先於裝置啟動（保險），再開始監聽。
  wsServer.start();
  trafficCop.start();
  await deviceManager.startAll();

  await listenWithRetry(httpServer, config.server.port, config.server.host, log);

  const base = `${config.server.host}:${config.server.port}`;
  // 使用者面：啟動完成。重啟接手（工作列「重啟服務」）時顯示「已重啟」，否則「已啟動」；兩者都帶名稱與版本號。
  log.user(`${agentInfo.name} v${agentInfo.version} ${process.env.WMS_FORCE_RESTART === "1" ? "已重啟" : "已啟動"}`);
  log.debug(`平台 ${agentInfo.platform}`);
  log.debug(`HTTP 健康檢查：http://${base}/health`);
  log.debug(`HTTP 設備狀態：http://${base}/devices`);
  log.debug(`WebSocket    ：ws://${base}${config.server.wsPath}（協定 v${PROTOCOL_VERSION}）`);
  log.debug(`允許 Origin  ：${config.security.allowedOrigins.join(", ") || "(無)"}｜允許無 Origin：${config.security.allowNoOrigin}`);

  // ---- 優雅關閉（務必釋放埠）----
  let tray: Tray | null = null;
  let shuttingDown = false;
  // killRelated：完全結束時連同相關程序（其他狀態視窗、殘留 helper）一起關掉。
  const shutdown = async (sig: string, killRelated = false): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 使用者面：應用程式關閉（含重啟接手時舊實例的收攤）。
    log.user("應用程式已關閉");
    // notice 僅進主控台（技術細節），讓精簡 log 保持乾淨。
    log.notice(`收到 ${sig}，開始關閉…`);
    // 看門狗：清理卡住也要在時限內強制退出以釋放埠。
    const watchdog = setTimeout(() => {
      log.warn("關閉逾時，強制結束以釋放埠。");
      process.exit(0);
    }, 4000);
    watchdog.unref();
    try {
      // 【順序關鍵】先釋放序列埠（電子秤 COM）——即使後續步驟卡住或看門狗逾時，埠也已乾淨關閉，
      // 確保下次啟動能立即重連。再收網路，最後才收較慢且與埠無關的工作列 helper。
      trafficCop.stop();
      await deviceManager.stopAll();
      await wsServer.stop();
      wsServer.detach(httpServer);
      // 強制斷開殘留連線，否則 close() 會等所有連線結束、程序無法退出。
      if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
      await new Promise<void>((res) => httpServer.close(() => res()));
      await tray?.stop(); // 工作列 helper 最後收（等圖示消失，避免殘留幽靈圖示）
    } catch (err) {
      log.error("關閉時發生錯誤：", err);
    } finally {
      // 完全結束：本身資源已釋放，再關掉相關程序（狀態視窗、殘留 helper），最後退出自己。
      if (killRelated) await killRelatedProcesses(log);
      clearTimeout(watchdog);
      log.notice("已關閉。");
      process.exit(0);
    }
  };
  // 新實例接手（POST /shutdown）：優雅關閉並乾淨釋放 COM 後退出，保證下次啟動能重連電子秤。
  requestShutdown = () => void shutdown("HTTP 關閉請求（新實例接手）");
  // 關閉訊號（SIGBREAK 僅 Windows）。
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }

  // 工作列常駐圖示（Windows）：背景執行的可見入口。右鍵選單：開啟 Log／重啟服務／結束。
  tray = new Tray(log, {
    version: agentInfo.version,
    onOpenLog: () => void showStatusWindow(log),
    onRestart: () => restartWorker(log),
    onExit: () => void shutdown("工作列 Exit", true),
  });
  tray.start();
}

main().catch((err) => {
  console.error("啟動失敗：", err);
  // 使用者面：啟動失敗也算應用程式錯誤（若檔案 log 已啟用即寫入精選檔；技術細節見主控台／技術檔）。
  try {
    createLogger("startup").user("應用程式發生錯誤");
  } catch {
    /* logger 尚未就緒：忽略 */
  }
  process.exit(1);
});
