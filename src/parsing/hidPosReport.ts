// HID-POS / IBM 掃碼槍 input report 解析：跳過表頭 → 收集可列印字元，CR/LF 分條、NUL 結束、結尾 flush。
// headerBytes 依機型校準（driver 會把原始 report 印在 debug log）。

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
