// wms-device-agent 進入點：載入設定 → 組裝裝置驅動 / WS / HTTP / 交警模式 → 啟動 → 優雅關閉。

import { once } from "node:events";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Server as HttpServer } from "node:http";
import { loadConfig } from "./config.js";
import { createLogger, setLogLevel, type Logger } from "./logger.js";
import { freePortIfOwnedByUs } from "./runtime/freePort.js";
import { runWindowsLauncherIfNeeded, killRelatedProcesses, cleanupLogFiles } from "./runtime/detach.js";
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

// 監聽埠：被占用時重試；占用者若是本程式的殘留實例則強制接管，逾重試上限才放棄。
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
      // 一次性接管：結束我們自己的殘留實例。
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
  const config = loadConfig();

  // Windows 打包版分流：本行程可能只是「前台狀態視窗」（顯示 log），
  // 代理本體在另一個脫離主控台的背景實例執行（見 runtime/detach.ts 說明）。
  if (await runWindowsLauncherIfNeeded(`http://${config.server.host}:${config.server.port}/health`)) {
    return; // tail interval 會讓事件迴圈存活；視窗被關掉時本行程自然結束
  }

  setLogLevel(config.logLevel);
  const log = createLogger("agent");
  const meta = readPackageMeta();

  const agentInfo: AgentInfo = {
    name: meta.name,
    version: meta.version,
    platform: process.platform,
    protocolVersion: PROTOCOL_VERSION,
  };

  const bus = new DeviceBus();
  const deviceManager = new DeviceManager(bus, log);
  const registry = new PortRegistry();

  // ---- 組裝裝置驅動（實體序列裝置）----
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
  // 啟動即預熱 nut.js（背景、不阻塞啟動），讓第一筆掃碼不必現場等載入初始化。
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

  // 訂閱要先於裝置啟動（保險），再開始監聽。
  wsServer.start();
  trafficCop.start();
  await deviceManager.startAll();

  await listenWithRetry(httpServer, config.server.port, config.server.host, log);

  const base = `${config.server.host}:${config.server.port}`;
  // 精選事件①：啟動。
  log.notice(`${agentInfo.name} v${agentInfo.version} 已啟動`);
  // 其餘啟動細節僅在 debug 模式顯示。
  log.debug(`平台 ${agentInfo.platform}`);
  log.debug(`HTTP 健康檢查：http://${base}/health`);
  log.debug(`HTTP 設備狀態：http://${base}/devices`);
  log.debug(`WebSocket    ：ws://${base}${config.server.wsPath}（協定 v${PROTOCOL_VERSION}）`);
  log.debug(`允許 Origin  ：${config.security.allowedOrigins.join(", ") || "(無)"}｜允許無 Origin：${config.security.allowNoOrigin}`);

  // ---- 優雅關閉（務必釋放埠）----
  let tray: Tray | null = null;
  let shuttingDown = false;
  // killRelated：完全結束（工作列 Exit）時，連同其他相關程序（狀態視窗）一起關掉。
  const shutdown = async (sig: string, killRelated = false): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${sig}，開始關閉…`);
    // 看門狗：清理卡住也要在時限內強制退出以釋放埠。
    const watchdog = setTimeout(() => {
      log.warn("關閉逾時，強制結束以釋放埠。");
      process.exit(0);
    }, 3000);
    watchdog.unref();
    try {
      await tray?.stop(); // 先收攤工作列 helper 程序（等圖示消失，避免殘留幽靈圖示）
      trafficCop.stop();
      await deviceManager.stopAll();
      await wsServer.stop();
      wsServer.detach(httpServer);
      // 強制斷開殘留連線，否則 close() 會等所有連線結束、程序無法退出。
      if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
      await new Promise<void>((res) => httpServer.close(() => res()));
    } catch (err) {
      log.error("關閉時發生錯誤：", err);
    } finally {
      // 完全結束：本身資源已釋放，再關掉其他相關程序（狀態視窗、殘留 helper），最後退出自己。
      if (killRelated) {
        await killRelatedProcesses(log);
        // 結束時清掉本次的 log 檔（agent.log 等）；仍被本行程 stdout 占用而刪不掉的，
        // 下次啟動新背景實例前會再清一次（見 detach.ts cleanupLogFiles / spawnWorker）。
        const { removed } = cleanupLogFiles();
        if (removed.length) log.info(`結束：已清除 log 檔（${removed.join("、")}）。`);
      }
      clearTimeout(watchdog);
      log.info("已關閉。");
      process.exit(0);
    }
  };
  // 關閉訊號：SIGINT / SIGTERM / SIGHUP / SIGBREAK(Windows)。
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }

  // 工作列常駐圖示（Windows）：背景執行時的可見入口。Exit＝完全結束（含狀態視窗與相關程序）。
  tray = new Tray(log, {
    version: agentInfo.version,
    onExit: () => void shutdown("工作列 Exit", true),
  });
  tray.start();
}

main().catch((err) => {
  console.error("啟動失敗：", err);
  process.exit(1);
});
