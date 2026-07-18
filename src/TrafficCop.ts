// 交警仲裁：掃碼時有焦點認領的頁面 → WS 專送；否則 → 鍵盤模擬打進 OS 焦點（擇一，不雙送）。

import type { DeviceBus } from "./core/DeviceBus.js";
import type { ScanEvent } from "./core/types.js";
import type { KeyboardEmulator } from "./keyboard/KeyboardEmulator.js";
import type { Logger } from "./logger.js";

export interface TrafficCopOptions {
  /** 掃碼槍是否啟用離線鍵盤退路。 */
  keyboardFallback: boolean;
  /** 把條碼委派給 typist 用戶端（工作列元件代打），回傳送達數；服務模式（session 0 打不到桌面）必經此路。 */
  routeToTypist?: (barcode: string) => number;
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
      if (sent > 0) {
        this.log.notice(`掃碼：${e.barcode}`);
        return;
      }
      // 認領剛失效（競態）→ 鍵盤退路。
      this.log.debug("認領剛失效，掃碼改走鍵盤退路");
    }
    if (!this.opts.keyboardFallback) {
      this.log.debug(`無有效認領且鍵盤退路停用，丟棄掃碼：${e.barcode}`);
      return;
    }
    // 優先委派 typist（工作列元件在使用者桌面代打）；服務模式下本機模擬打不到桌面，唯有此路。
    const typed = this.opts.routeToTypist?.(e.barcode) ?? 0;
    if (typed > 0) {
      this.log.notice(`掃碼槍改用鍵盤模擬輸入（工作列元件代打）：${e.barcode}`);
      return;
    }
    if (!this.keyboard.enabled) {
      this.log.warn(`無鍵盤輸出端連線且本機鍵盤模擬停用，丟棄掃碼：${e.barcode}`);
      return;
    }
    // 鍵盤模擬：只印此 log，不另印「掃碼」以免重複。
    this.log.notice(`掃碼槍改用鍵盤模擬輸入：${e.barcode}`);
    this.keyboard.typeBarcode(e.barcode);
  }

  stop(): void {
    if (this.scanListener) {
      this.bus.off("scan", this.scanListener);
      this.scanListener = null;
    }
  }
}
