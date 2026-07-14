// wms-device-agent 進入點：載入設定 → 組裝裝置驅動 / WS / HTTP / 交警模式 → 啟動 → 優雅關閉。

import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { loadConfig } from "./config.js";
import { createLogger, setLogLevel, type Logger } from "./logger.js";
import { freePortIfOwnedByUs } from "./runtime/freePort.js";
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

// 打包（SEA）時由 esbuild --define 注入；exe 旁沒有 package.json 可讀。
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 監聽埠並容忍「舊實例尚未釋放埠」：
//   1) EADDRINUSE 時先短暫重試，讓正常關閉中的舊實例把埠放掉再綁上；
//   2) 重試若干次仍占用，嘗試「接管」——若占用者確實是我們自己的另一個實例（常見：收不到關閉訊號
//      的孤兒程序），強制結束它以釋放埠與其卡住的序列埠，再繼續重試；
//   3) 逾重試上限仍占用（且非本程式占用）才放棄，並給出可操作的錯誤訊息。
async function listenWithRetry(server: HttpServer, port: number, host: string, log: Logger): Promise<void> {
  const MAX_ATTEMPTS = 10;
  const RETRY_DELAY_MS = 1000;
  const TAKEOVER_AT_ATTEMPT = 3; // 先給正常關閉幾秒緩衝，仍占用才動用接管
  let tookOver = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (e: NodeJS.ErrnoException): void => {
          server.removeListener("listening", onListening);
          reject(e);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EADDRINUSE") throw err;
      // 一次性接管：占用者若是我們自己的殘留實例就結束它（釋放埠與其占住的序列埠）。
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
  });

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
  log.info("──────────────────────────────────────────────");
  log.info(`${agentInfo.name} v${agentInfo.version} 已啟動（平台 ${agentInfo.platform}）`);
  log.info(`HTTP 健康檢查：http://${base}/health`);
  log.info(`HTTP 設備狀態：http://${base}/devices`);
  log.info(`WebSocket    ：ws://${base}${config.server.wsPath}（協定 v${PROTOCOL_VERSION}）`);
  log.info(`允許 Origin  ：${config.security.allowedOrigins.join(", ") || "(無)"}｜允許無 Origin：${config.security.allowNoOrigin}`);
  log.info("──────────────────────────────────────────────");

  // ---- 優雅關閉：務必釋放埠，避免重啟時「埠被占用」（EADDRINUSE）----
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${sig}，開始關閉…`);
    // 看門狗：不論下方清理是否卡住（如 serialport 關閉未回呼），都在時限內強制結束，
    // 確保程序一定會退出並釋放埠。unref 讓它不阻止正常退出。
    const watchdog = setTimeout(() => {
      log.warn("關閉逾時，強制結束以釋放埠。");
      process.exit(0);
    }, 3000);
    watchdog.unref();
    try {
      trafficCop.stop();
      await deviceManager.stopAll();
      await wsServer.stop();
      wsServer.detach(httpServer);
      // 強制斷開殘留連線（含開著的 WebSocket）——否則 httpServer.close() 會等到所有連線結束才回呼，
      // 導致程序遲遲不退出、埠一直被占用，下次啟動就 EADDRINUSE。
      if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
      await new Promise<void>((res) => httpServer.close(() => res()));
    } catch (err) {
      log.error("關閉時發生錯誤：", err);
    } finally {
      clearTimeout(watchdog);
      log.info("已關閉。");
      process.exit(0);
    }
  };
  // 訊號：SIGINT(Ctrl+C)、SIGTERM、SIGHUP（Windows 關閉主控台視窗 / POSIX 終端斷線）、SIGBREAK(Windows Ctrl+Break)。
  // 用工作管理員「結束工作」或 taskkill（非 /F）會走這些路徑；/F 強制結束則由 OS 直接回收埠。
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }
}

main().catch((err) => {
  console.error("啟動失敗：", err);
  process.exit(1);
});
