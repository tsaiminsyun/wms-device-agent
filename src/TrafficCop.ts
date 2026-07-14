// 交警模式仲裁：掃碼時有「焦點認領」的頁面 → 走 WS 專送；否則 → 鍵盤模擬打進 OS 焦點。
// scan 只由此處擇一路由（不雙送）；weight 與認領無關，一律由 WsServer 廣播。

import type { DeviceBus } from "./core/DeviceBus.js";
import type { ScanEvent } from "./core/types.js";
import type { KeyboardEmulator } from "./keyboard/KeyboardEmulator.js";
import type { Logger } from "./logger.js";

export interface TrafficCopOptions {
  /** 掃碼槍是否啟用離線鍵盤退路。 */
  keyboardFallback: boolean;
}

export class TrafficCop {
  private scanListener: ((e: ScanEvent) => void) | null = null;

  constructor(
    private readonly bus: DeviceBus,
    private readonly log: Logger,
    private readonly keyboard: KeyboardEmulator,
    /** 是否有持有效焦點認領的 WMS 頁面在線。 */
    private readonly hasActiveClaim: () => boolean,
    /** 把掃碼送給認領者，回傳實際送達數（0 表示認領剛好失效，需退回鍵盤）。 */
    private readonly routeScanToWs: (e: ScanEvent) => number,
    private readonly opts: TrafficCopOptions,
  ) {}

  start(): void {
    this.scanListener = (e) => this.onScan(e);
    this.bus.on("scan", this.scanListener);
  }

  private onScan(e: ScanEvent): void {
    if (this.hasActiveClaim()) {
      const sent = this.routeScanToWs(e);
      if (sent > 0) return;
      // 認領剛失效（競態）→ 鍵盤退路。
      this.log.debug("認領剛失效，掃碼改走鍵盤退路");
    }
    if (!this.opts.keyboardFallback || !this.keyboard.enabled) {
      this.log.debug(`無有效認領且鍵盤退路停用，丟棄掃碼：${e.barcode}`);
      return;
    }
    this.log.info(`無有效認領 → 走鍵盤模擬退路：${e.barcode}`);
    this.keyboard.typeBarcode(e.barcode);
  }

  stop(): void {
    if (this.scanListener) {
      this.bus.off("scan", this.scanListener);
      this.scanListener = null;
    }
  }
}
