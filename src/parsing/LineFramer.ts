// 串流分行器：把連續到達的位元組片段組裝成「完整的一行」。
// 掃碼槍（CDC 模式）與電子秤的序列輸出都以 CR / LF / CRLF 作為一筆資料的終止符，
// 故兩種驅動共用此 framer。未遇終止符的殘段留在 buffer，下次再續接。

export class LineFramer {
  private buffer = "";

  constructor(private readonly maxBuffer = 512) {}

  /**
   * 餵入一段（已 decode 的）字串，回傳本次湊齊的所有完整行（不含終止符，未 trim）。
   * 殘餘未完成段留在內部 buffer。若 buffer 無終止符暴長超過上限，視為毀損／非預期資料：
   * 直接「丟棄」整段並清空（不當成一行吐出），避免被誤判成一筆超長條碼或拖垮解析。
   * 條碼與秤讀數正常皆遠小於上限（預設 512 bytes），超過必為雜訊。
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r\n|[\r\n]/);
    // 最後一段是尚未遇到終止符的殘餘，留回 buffer。
    this.buffer = parts.pop() ?? "";

    if (this.buffer.length > this.maxBuffer) {
      this.overflowCount++;
      this.buffer = ""; // 丟棄無終止符的暴長殘段
    }
    return parts;
  }

  /** 被丟棄的暴長片段累計次數（供上層判斷是否要 log 告警）。 */
  overflowCount = 0;

  /** 清空殘餘 buffer（關閉埠時呼叫）。 */
  reset(): void {
    this.buffer = "";
  }
}
