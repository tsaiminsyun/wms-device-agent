// 工作列元件（--tray）：服務模式下每位使用者登入時啟動（安裝程式寫入 Run 機碼、以 wscript 隱藏啟動）。
// 職責：(1) 系統匣選單——開啟 Log／連線狀態／重啟服務／關閉圖示；
//       (2) 以 WS 連上本機服務註冊 typist，收到 kbd 訊息在「使用者桌面」代打條碼
//           （服務本體在 session 0，鍵盤模擬打不到使用者桌面，必須由本元件代打）。

import { dirname, join } from "node:path";
import { createLogger, enableFileLog, logFileDir, type Logger } from "../logger.js";
import { openWithShell } from "../runtime/detach.js";
import { isSeaBuild } from "../runtime/nativeRequire.js";
import { restartServiceFromTray } from "../runtime/serviceControl.js";
import { KeyboardEmulator } from "../keyboard/KeyboardEmulator.js";
import { Tray } from "./Tray.js";
import { TypistClient } from "./TypistClient.js";
import type { AppConfig } from "../config.js";

export async function runTrayCompanion(config: AppConfig, version: string): Promise<void> {
  const log = createLogger("tray");
  // log 檔與服務同目錄，但用獨立前綴（兩個行程各寫各的檔，避免交錯）。
  const baseDir = isSeaBuild() ? dirname(process.execPath) : process.cwd();
  enableFileLog(join(baseDir, "logs"), "wms-agent-tray");
  log.notice(`工作列元件已啟動（v${version}）。`);

  // 全域防護：任何未捕捉錯誤記 log 續跑，確保鍵盤代打與選單不因偶發例外消失。
  process.on("uncaughtException", (err) => log.error("未捕捉例外（續行）：", err));
  process.on("unhandledRejection", (err) => log.error("未處理的 Promise 拒絕（續行）：", err));

  const keyboard = new KeyboardEmulator(log, {
    enabled: config.keyboard.enabled,
    pressEnter: config.keyboard.pressEnter,
    paste: config.keyboard.paste,
  });
  keyboard.warmUp();

  const base = `${config.server.host}:${config.server.port}`;
  const typist = new TypistClient(log, `ws://${base}${config.server.wsPath}`, (barcode) => {
    log.notice(`掃碼（鍵盤輸入）：${barcode}`);
    keyboard.typeBarcode(barcode);
  });
  typist.start();

  const tray = new Tray(log, {
    version,
    items: [
      {
        title: "開啟 Log",
        tooltip: "開啟 log 資料夾（每日輪替 .log 檔）",
        onClick: () => openWithShell(logFileDir() ?? join(baseDir, "logs"), log),
      },
      {
        title: "連線狀態",
        tooltip: "以瀏覽器開啟裝置連線狀態（/devices）",
        onClick: () => openWithShell(`http://${base}/devices`, log),
      },
      {
        title: "重啟服務",
        tooltip: "重新啟動 WMS Device Agent 服務（裝置異常時使用）",
        onClick: () => void restartServiceFromTray(log),
      },
      {
        title: "關閉圖示",
        tooltip: "只關閉此工作列圖示；服務仍在背景執行",
        onClick: () => void closeCompanion(tray, typist, log),
      },
    ],
  });
  tray.start();

  // 保持事件迴圈存活（tray helper 或 WS 均可能暫時斷開）。
  setInterval(() => {}, 1 << 30);
}

async function closeCompanion(tray: Tray, typist: TypistClient, log: Logger): Promise<void> {
  log.notice("關閉工作列圖示（服務不受影響）。");
  typist.stop();
  await tray.stop();
  process.exit(0);
}
