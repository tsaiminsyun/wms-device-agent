// wms-device-agent 進入點：載入設定 → 組裝裝置驅動 / WS / HTTP / 交警模式 → 啟動 → 優雅關閉。

import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createLogger, setLogLevel } from "./logger.js";
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.server.port, config.server.host, () => resolve());
  });

  const base = `${config.server.host}:${config.server.port}`;
  log.info("──────────────────────────────────────────────");
  log.info(`${agentInfo.name} v${agentInfo.version} 已啟動（平台 ${agentInfo.platform}）`);
  log.info(`HTTP 健康檢查：http://${base}/health`);
  log.info(`HTTP 設備狀態：http://${base}/devices`);
  log.info(`WebSocket    ：ws://${base}${config.server.wsPath}（協定 v${PROTOCOL_VERSION}）`);
  log.info(`允許 Origin  ：${config.security.allowedOrigins.join(", ") || "(無)"}｜允許無 Origin：${config.security.allowNoOrigin}`);
  log.info("──────────────────────────────────────────────");

  // ---- 優雅關閉 ----
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${sig}，開始關閉…`);
    try {
      trafficCop.stop();
      await deviceManager.stopAll();
      await wsServer.stop();
      wsServer.detach(httpServer);
      await new Promise<void>((res) => httpServer.close(() => res()));
    } catch (err) {
      log.error("關閉時發生錯誤：", err);
    } finally {
      log.info("已關閉。");
      process.exit(0);
    }
  };
  // POSIX：SIGINT(Ctrl+C)/SIGTERM。Windows：Ctrl+C 會轉成 SIGINT、Ctrl+Break 為 SIGBREAK；
  // 若以 Windows 服務執行（nssm / node-windows 等包裝器），請設定其在停止時送 Ctrl+C/SIGINT 以觸發優雅關閉。
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => void shutdown("SIGBREAK"));
  }
}

main().catch((err) => {
  console.error("啟動失敗：", err);
  process.exit(1);
});
