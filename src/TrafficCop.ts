// 交警模式（traffic cop）核心仲裁 —— 掃到 barcode 時：
//   IF 有「焦點認領」的 WMS 頁面在線（前景/可見並持有有效認領）
//        → 透過 WS 只送給認領者（頁面去打既有 API）。
//   ELSE（沒有任何 WMS 頁面在前景：操作員在 Excel / UPS / FedEx / Teams…，或根本沒開頁面）
//        → 走系統鍵盤模擬，把字串打進目前 OS 焦點輸入框。
//
// 為何用「焦點認領」而非「是否有連線」：掃碼槍會用在 WMS 以外的各種 app，且 agent 無法分辨
// 瀏覽器目前在哪個分頁（WMS 分頁 vs FedEx 分頁同屬一個瀏覽器程序）。唯有頁面自己知道它是否在前景，
// 因此由頁面主動認領；切走其他 app 時頁面失焦釋放，掃碼自動退回鍵盤，達成「掃碼槍到處都能用」。
//
// 互斥保證：scan 不再由 WsServer 自動廣播；只有這裡擇一決定走 WS 或走鍵盤，不會雙觸發。
// 電子秤 weight 與認領無關：一律由 WsServer 廣播給所有訂閱者，不經此處、也無鍵盤退路。

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
      if (sent > 0) return; // 已送給認領的 WMS 頁面
      // 認領在檢查與送出之間剛好失效（極少數競態）→ 落到鍵盤退路。
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
