// 懶載入 node-hid（選用原生相依）：失敗回 null 並告警一次；只宣告用到的最小介面。

import { nativeRequire } from "../../runtime/nativeRequire.js";

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
    const mod = nativeRequire("node-hid") as HidModule & { default?: HidModule };
    const resolved = (mod.default ?? mod) as HidModule; // CJS：具名或 default 皆可能
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

// 數字 id → 小寫 4 碼 hex 字串。
export function hex4(id: number): string {
  return (id >>> 0).toString(16).padStart(4, "0");
}
