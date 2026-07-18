// 進入點：設定 → 組裝裝置驅動/WS/HTTP/交警模式 → 啟動 → 優雅關閉。
// 執行角色見 runtime/runMode.ts：default（靜默啟動器＋背景實例）/ service（Windows 服務）/ tray（工作列元件）。

import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Server as HttpServer } from "node:http";
import { loadConfig } from "./config.js";
import { createLogger, enableFileLog, logFileDir, setLogLevel, type Logger } from "./logger.js";
import { freePortIfOwnedByUs } from "./runtime/freePort.js";
import { runWindowsLauncherIfNeeded, killRelatedProcesses, cleanupLogFiles, openWithShell } from "./runtime/detach.js";
import { getRunMode, hasCliFlag } from "./runtime/runMode.js";
import { runServiceCli } from "./runtime/serviceControl.js";
import { isSeaBuild } from "./runtime/nativeRequire.js";
import { runTrayCompanion } from "./tray/trayCompanion.js";
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
  // 服務註冊 CLI（安裝程式以系統管理員呼叫）：處理完直接結束。
  if (hasCliFlag("--install-service") || hasCliFlag("--uninstall-service")) {
    await runServiceCli(hasCliFlag("--install-service"), createLogger("service-setup"));
    return;
  }

  const config = loadConfig();
  const mode = getRunMode();
  const meta = readPackageMeta();

  // 工作列元件（--tray）：系統匣選單＋替服務在使用者桌面代打鍵盤；不啟動代理本體。
  if (mode === "tray") {
    setLogLevel(config.logLevel);
    await runTrayCompanion(config, meta.version);
    return;
  }

  // Windows 打包版分流：本行程可能只是靜默啟動器（不開視窗），代理本體在脫離主控台的背景實例執行（見 detach.ts）。
  // 服務模式不分流：SCM/winsw 直接管本行程，單行程直跑。
  if (mode !== "service" && (await runWindowsLauncherIfNeeded(`http://${config.server.host}:${config.server.port}/health`))) {
    return; // tail interval 會讓事件迴圈存活；視窗被關掉時本行程自然結束
  }

  setLogLevel(config.logLevel);
  // 每日輪替 log 檔：服務/打包版寫 <exe 同層>/logs/wms-agent-YYYY-MM-DD.log；開發環境可用 WMS_LOG_DIR 啟用。
  if (process.env.WMS_LOG_DIR) {
    enableFileLog(process.env.WMS_LOG_DIR);
  } else if (mode === "service" || (process.platform === "win32" && isSeaBuild())) {
    enableFileLog(join(dirname(process.execPath), "logs"));
  }
  const log = createLogger("agent");

  // 全域防護：原生層（serialport/node-hid）拔插瞬間可能丟出未捕捉錯誤——記 log 續跑，不讓服務崩潰。
  process.on("uncaughtException", (err) => log.error("未捕捉例外（服務續行）：", err));
  process.on("unhandledRejection", (err) => log.error("未處理的 Promise 拒絕（服務續行）：", err));

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
  // 服務模式跑在 session 0，鍵盤模擬打不到使用者桌面 → 本機停用，離線掃碼經 WS 委派工作列元件（typist）代打。
  const keyboard = new KeyboardEmulator(log, {
    enabled: config.keyboard.enabled && mode !== "service",
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
    { keyboardFallback: config.scanner.keyboardFallback, routeToTypist: (barcode) => wsServer.broadcastKbd(barcode) },
  );

  const httpServer = createApiServer({
    log,
    agentInfo,
    deviceManager,
    activeClientCount: () => wsServer.activeClientCount(),
    claimingClientCount: () => wsServer.claimingCount(),
    security: config.security,
    startedAt: Date.now(),
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
  // 精選事件：啟動。其餘細節僅 debug 模式顯示。
  log.notice(`${agentInfo.name} v${agentInfo.version} 已啟動`);
  log.debug(`平台 ${agentInfo.platform}`);
  log.debug(`HTTP 健康檢查：http://${base}/health`);
  log.debug(`HTTP 設備狀態：http://${base}/devices`);
  log.debug(`WebSocket    ：ws://${base}${config.server.wsPath}（協定 v${PROTOCOL_VERSION}）`);
  log.debug(`允許 Origin  ：${config.security.allowedOrigins.join(", ") || "(無)"}｜允許無 Origin：${config.security.allowNoOrigin}`);

  // ---- 優雅關閉（務必釋放埠）----
  let tray: Tray | null = null;
  let shuttingDown = false;
  // killRelated：完全結束（工作列 Exit）時連同相關程序一起關掉。
  // relaunch：工作列「重啟服務」——資源全部釋放後另起新實例再退出（走啟動器分流）。
  const shutdown = async (sig: string, killRelated = false, relaunch = false): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${sig}，開始關閉…`);
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
      // 完全結束：本身資源已釋放，再關掉相關程序（殘留實例、tray helper），最後退出自己。
      if (killRelated) {
        await killRelatedProcesses(log);
        // 清掉本次的 log 檔；仍被 stdout 占用而刪不掉的，下次啟動前會再清一次（見 detach.ts）。
        const { removed } = cleanupLogFiles();
        if (removed.length) log.info(`結束：已清除 log 檔（${removed.join("、")}）。`);
      }
      // 重啟：埠與 COM 都已釋放，另起新實例（啟動器分流：health 已死 → 起新背景實例）後才退出。
      if (relaunch) {
        try {
          const env = { ...process.env };
          delete env.WMS_AGENT_WORKER;
          delete env.WMS_LAUNCHER_QUIET;
          spawn(process.execPath, [], {
            cwd: dirname(process.execPath),
            detached: true,
            windowsHide: true,
            stdio: "ignore",
            env,
          }).unref();
          log.info("重啟：已啟動新實例。");
        } catch (err) {
          log.warn("重啟失敗（請手動重新啟動）：", err);
        }
      }
      clearTimeout(watchdog);
      log.info("已關閉。");
      process.exit(0);
    }
  };
  // 關閉訊號（SIGBREAK 僅 Windows）。
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }

  // 工作列常駐圖示（Windows，非服務模式）：背景執行的唯一可見入口（啟動不開任何視窗）。
  // 服務模式在 session 0 畫不出系統匣，圖示由工作列元件（--tray，使用者 session）提供（選單相同）。
  if (mode !== "service") {
    const logsDir = logFileDir() ?? join(dirname(process.execPath), "logs");
    tray = new Tray(log, {
      version: agentInfo.version,
      items: [
        { title: "開啟 Log", tooltip: "開啟 log 資料夾（每日輪替 .log 檔）", onClick: () => openWithShell(logsDir, log) },
        { title: "連線狀態", tooltip: "以瀏覽器開啟裝置連線狀態（/devices）", onClick: () => openWithShell(`http://${base}/devices`, log) },
        { title: "重啟服務", tooltip: "重新啟動背景代理（釋放並重連所有裝置）", onClick: () => void shutdown("工作列 重啟", false, true) },
        { title: "結束", tooltip: "完全結束程式（含背景程序）", onClick: () => void shutdown("工作列 Exit", true) },
      ],
    });
    tray.start();
  }
}

main().catch((err) => {
  console.error("啟動失敗：", err);
  process.exit(1);
});
