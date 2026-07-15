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

// 兩種掃碼槍驅動共用的掃碼出口：連線後首筆自動觸發過濾 → 去重 → log → emit 'scan'。
export class ScanEmitter {
  private readonly dedup: ScanDebouncer;
  // uid → 連線後仍要忽略的掃碼筆數。有些掃碼槍一接上/被開啟就自動送出一筆（型號、自我測試字串，
  // 如 MOTEVTTC110），此時尚未有人操作，須忽略以免誤輸入。
  // 採「計數」而非「時間窗」：Windows 上載入原生模組／防毒掃描可能卡住事件迴圈數秒，
  // 使自動觸發那筆延遲到時間窗過後才被處理（開發環境載入快故不會發生）——計數式不受時間影響，
  // 打包後與開發環境行為一致。
  private readonly ignoreCount = new Map<string, number>();

  constructor(
    private readonly bus: DeviceBus,
    private readonly log: Logger,
    private readonly deviceName: string,
    dedupWindowMs: number,
    private readonly ignoreFirstScans = 0,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.dedup = new ScanDebouncer(dedupWindowMs, now);
  }

  /** 裝置剛連上/開啟時呼叫：武裝「忽略連線後前 N 筆自動觸發」（N=ignoreFirstScans）。 */
  armIgnoreFirst(uid: string): void {
    if (this.ignoreFirstScans > 0) this.ignoreCount.set(uid, this.ignoreFirstScans);
  }

  emit(uid: string, barcode: string): void {
    const remaining = this.ignoreCount.get(uid) ?? 0;
    if (remaining > 0) {
      if (remaining > 1) this.ignoreCount.set(uid, remaining - 1);
      else this.ignoreCount.delete(uid);
      this.log.info(`[${uid}] 連線後首筆視為自動觸發，已忽略：${barcode}`);
      return;
    }
    if (!this.dedup.accept(uid, barcode)) {
      this.log.debug(`[${uid}] 連續重讀，抑制：${barcode}`);
      return;
    }
    this.log.info(`[${uid}] 掃碼：${barcode}（${barcode.length} 字）`);
    this.bus.emit("scan", { deviceId: uid, deviceName: this.deviceName, barcode, kind: "scanner", ts: Date.now() });
  }

  /** 裝置移除時清掉其去重與首筆過濾狀態。 */
  forget(uid: string): void {
    this.dedup.forget(uid);
    this.ignoreCount.delete(uid);
  }
}
