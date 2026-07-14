// 掃碼去重：抑制「連續重複讀到同一條碼」。
// 情境：掃碼槍在 presentation / 連續（continuous / auto-trigger）模式下，只要視野內有一張條碼，
// 就會每隔數百毫秒重覆讀同一條，agent 每次都當成一次掃碼 → 洗版、且鍵盤退路會不停打字。
//
// 規則（每個裝置各自獨立，以 key 區分）：
//   - 條碼與上次不同 → 立即放行（emit）。
//   - 條碼與上次相同，且距上次「放行或被抑制」的時間 < windowMs → 抑制，並把時間往後延
//     （因此連續重讀期間只會放行第一筆，其餘全部抑制，直到出現一段空檔）。
//   - 空檔超過 windowMs 後再讀到同一條 → 視為新的一次刻意掃碼，放行。
// windowMs = 0 代表關閉去重（全部放行）。
//
// 為何用「延長抑制」而非固定時間窗：presentation 模式的重讀間隔很短，固定窗會週期性漏放；
// 延長式可在持續重讀時完全壓住，只有真正停下再掃（有空檔）才會再放行，不影響刻意的重複掃描。

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
