// 原生選用相依的統一載入器：SEA 打包時 require 只支援 builtin，須以 createRequire(process.execPath)
// 從 exe 旁的 node_modules 解析；開發/dist 照常解析。

import { createRequire } from "node:module";

/** 目前是否以 Node SEA 單一執行檔執行。 */
export function isSeaBuild(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    return sea.isSea?.() ?? false;
  } catch {
    return false; // node:sea 不存在（舊版 Node）
  }
}

let cachedRequire: NodeJS.Require | null = null;

/** 以執行情境對應的基準路徑 require 原生模組；解析失敗會拋錯，由呼叫端降級處理。 */
export function nativeRequire(id: string): unknown {
  if (!cachedRequire) {
    cachedRequire = createRequire(isSeaBuild() ? process.execPath : import.meta.url);
  }
  return cachedRequire(id);
}
