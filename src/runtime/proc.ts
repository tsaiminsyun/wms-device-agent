// 共用行程工具：execFile 的 promise 版，與全域未捕捉錯誤防護。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "../logger.js";

/** execFile 的 promise 版（各處共用）。 */
export const pexec = promisify(execFile);

/** 全域未捕捉錯誤防護：原生層（serialport/node-hid）拔插瞬間可能拋錯，記 log 續跑不崩潰。 */
export function installCrashGuards(log: Logger): void {
  // 使用者面：只說「應用程式發生錯誤」，不含堆疊／技術細節（完整內容進技術檔）；
  // 至多每 5 秒一次，避免錯誤迴圈把狀態視窗洗版。
  let lastUserErrorTs = 0;
  const noteAppError = (): void => {
    const now = Date.now();
    if (now - lastUserErrorTs < 5000) return;
    lastUserErrorTs = now;
    log.user("應用程式發生錯誤");
  };
  process.on("uncaughtException", (err) => {
    log.error("未捕捉例外（續行）：", err);
    noteAppError();
  });
  process.on("unhandledRejection", (err) => {
    log.error("未處理的 Promise 拒絕（續行）：", err);
    noteAppError();
  });
}
