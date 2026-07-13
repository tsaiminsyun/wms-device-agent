// HID-POS / IBM Hand-held 掃碼槍的 input report 解析（純函式，便於單元測試）。
// Zebra 等掃碼槍在 HID-POS 模式下，每筆 input report 以固定表頭起頭，其後為條碼的可列印字元，
// 以 CR/LF 分隔、NUL 表示結束；IBM 模式常為「一筆 report＝一整條 barcode、無 CR/LF」。
//
// 解析規則：
//   - 跳過表頭 headerBytes（預設 4）；
//   - 0x20~0x7e 可列印字元累進緩衝；
//   - 遇 CR(0x0d)/LF(0x0a) 視為一條完結 → flush；
//   - 遇 NUL(0x00) 視為結束 → break；
//   - report 讀完再 flush 一次（涵蓋無 CR/LF 的 IBM 模式）。
//
// 注意：不同機型 / node-hid 與 WebHID 對 reportId 的處理差異，可能需微調 headerBytes；
// HidScannerDriver 會把每筆原始 report 以 hex 印出，便於實機校準。

export function parseHidPosReport(bytes: Uint8Array | readonly number[], headerBytes = 4): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = (): void => {
    const code = buf.trim();
    buf = "";
    if (code) out.push(code);
  };

  for (let i = Math.max(0, headerBytes); i < bytes.length; i++) {
    const b = bytes[i] as number;
    if (b === 0x0d || b === 0x0a) {
      flush();
    } else if (b === 0x00) {
      break;
    } else if (b >= 0x20 && b <= 0x7e) {
      buf += String.fromCharCode(b);
    }
  }
  flush();
  return out;
}
