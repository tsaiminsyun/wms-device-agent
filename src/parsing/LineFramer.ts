// 串流分行器：把序列資料組裝成完整行（CR / LF / CRLF 終止）。

export class LineFramer {
  /** 被丟棄的暴長片段累計次數（供上層判斷是否要 log 告警）。 */
  overflowCount = 0;

  private buffer = "";

  constructor(private readonly maxBuffer = 512) {}

  /**
   * 餵入字串，回傳湊齊的完整行（不含終止符）；殘段留在 buffer。
   * 無終止符暴長超過上限視為雜訊，整段丟棄。
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r\n|[\r\n]/);
    // 最後一段是未完成的殘餘，留回 buffer。
    this.buffer = parts.pop() ?? "";

    if (this.buffer.length > this.maxBuffer) {
      this.overflowCount++;
      this.buffer = "";
    }
    return parts;
  }

  /** 清空殘餘 buffer（關閉埠時呼叫）。 */
  reset(): void {
    this.buffer = "";
  }
}
