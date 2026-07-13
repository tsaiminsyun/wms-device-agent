// node-hid 是「選用原生相依」(optionalDependencies)：載入失敗（未安裝／編譯失敗／平台不支援）時
// 回 null 並告警一次，讓 HID 掃碼槍功能停用但不影響代理其餘部分。一律動態 import 懶載入。
//
// 為了讓 typecheck 不被「node-hid 是否已安裝」綁住，這裡只宣告本專案用到的最小介面。

export interface HidDeviceInfo {
  vendorId: number;
  productId: number;
  path?: string;
  manufacturer?: string;
  product?: string;
  release?: number;
  interface?: number;
  usagePage?: number;
  usage?: number;
}

export interface HidDeviceInstance {
  on(event: "data", cb: (data: Buffer) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  close(): void;
}

export interface HidModule {
  devices(): HidDeviceInfo[];
  HID: new (path: string) => HidDeviceInstance;
}

let cached: HidModule | null | undefined;

export async function loadNodeHid(warn: (msg: string, err?: unknown) => void): Promise<HidModule | null> {
  if (cached !== undefined) return cached;
  try {
    const mod = (await import("node-hid")) as unknown as HidModule & { default?: HidModule };
    // ESM/CJS interop：node-hid 為 CJS，具名或 default 皆可能。
    const resolved = (mod.default ?? mod) as HidModule;
    if (typeof resolved.devices !== "function" || typeof resolved.HID !== "function") {
      throw new Error("node-hid 介面不符預期（缺 devices() 或 HID）");
    }
    cached = resolved;
  } catch (err) {
    warn("無法載入 node-hid（原生模組未安裝或不支援）。HID 掃碼槍將停用。", err);
    cached = null;
  }
  return cached;
}

// node-hid 的 vendorId 是數字 → 正規化成小寫 4 碼 hex 字串，方便與設定比對。
export function vendorHex(vid: number): string {
  return (vid >>> 0).toString(16).padStart(4, "0");
}
