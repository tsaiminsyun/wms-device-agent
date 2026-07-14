// serialport 是「選用原生相依」(optionalDependencies)：在無法編譯原生模組的環境（或刻意不裝）時
// 仍能啟動代理（只是實體序列裝置停用）。因此一律懶載入（nativeRequire，支援 SEA 打包），
// 載入失敗就回 null 並告警一次。
//
// 為了讓 typecheck 不被「serialport 是否已安裝」綁住，這裡只宣告本專案實際用到的最小介面，
// 不直接引用 serialport 自身的型別定義。

import { nativeRequire } from "../../runtime/nativeRequire.js";

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  vendorId?: string;
  productId?: string;
  serialNumber?: string;
  pnpId?: string;
  friendlyName?: string;
}

export interface SerialPortInstance {
  readonly isOpen: boolean;
  on(event: "open", cb: () => void): void;
  on(event: "data", cb: (chunk: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: () => void): void;
  removeAllListeners(event?: string): void;
  close(cb?: (err?: Error | null) => void): void;
}

export interface SerialPortCtor {
  // hupcl：Unix＝關埠時是否拉低 DTR；Windows＝開埠時是否拉高 DTR（DTR_CONTROL_ENABLE/DISABLE）。
  new (opts: { path: string; baudRate: number; autoOpen?: boolean; hupcl?: boolean }): SerialPortInstance;
  list(): Promise<SerialPortInfo[]>;
}

let cached: SerialPortCtor | null | undefined;

export async function loadSerialPort(warn: (msg: string, err?: unknown) => void): Promise<SerialPortCtor | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = nativeRequire("serialport") as { SerialPort: SerialPortCtor };
    cached = mod.SerialPort;
  } catch (err) {
    warn("無法載入 serialport（原生模組未安裝或編譯失敗）。實體序列裝置將停用；請修正安裝或確認平台支援。", err);
    cached = null;
  }
  return cached;
}

// vendorId/productId 在不同平台可能大小寫不一、長度不一 → 正規化成小寫 4 碼 hex 方便比對。
export function normalizeHexId(id: string | undefined): string | null {
  if (!id) return null;
  const cleaned = id.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{1,4}$/.test(cleaned)) return null;
  return cleaned.padStart(4, "0");
}
