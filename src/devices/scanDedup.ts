// 掃碼去重：抑制 presentation/連續模式下同一條碼的連續重讀（延長式抑制，只放行第一筆，
// 出現空檔後同碼再讀視為刻意重掃）。windowMs=0 關閉。

import type { DeviceBus } from "../core/DeviceBus.js";
import type { Logger } from "../logger.js";

export class ScanDebouncer {
  private readonly state = new Map<string, { last: string; ts: number }>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 回傳 true=應放行（emit）、false=視為連續重讀而抑制。 */
  accept(key: string, barcode: string): boolean {
    if (this.windowMs <= 0) return true;
    const t = this.now();
    const s = this.state.get(key);
    if (s && s.last === barcode && t - s.ts < this.windowMs) {
      s.ts = t; // 連續重讀期間持續延長抑制
      return false;
    }
    this.state.set(key, { last: barcode, ts: t });
    return true;
  }

  /** 裝置移除時清掉其狀態。 */
  forget(key: string): void {
    this.state.delete(key);
  }
}

// 兩種掃碼槍驅動共用的掃碼出口：去重 → log → emit 'scan'。
export class ScanEmitter {
  private readonly dedup: ScanDebouncer;

  constructor(
    private readonly bus: DeviceBus,
    private readonly log: Logger,
    private readonly deviceName: string,
    dedupWindowMs: number,
  ) {
    this.dedup = new ScanDebouncer(dedupWindowMs);
  }

  emit(uid: string, barcode: string): void {
    if (!this.dedup.accept(uid, barcode)) {
      this.log.debug(`[${uid}] 連續重讀，抑制：${barcode}`);
      return;
    }
    this.log.info(`[${uid}] 掃碼：${barcode}（${barcode.length} 字）`);
    this.bus.emit("scan", { deviceId: uid, deviceName: this.deviceName, barcode, kind: "scanner", ts: Date.now() });
  }

  /** 裝置移除時清掉其去重狀態。 */
  forget(uid: string): void {
    this.dedup.forget(uid);
  }
}
