// 原生選用相依（serialport / node-hid / nut.js）的統一載入器。
//
// 為何用 createRequire 而非 import()：打包成單一執行檔（Node SEA，見 packaging/windows/）時，
// 原生 .node 模組無法嵌入 exe，須從 exe 旁的 node_modules 載入；SEA 內建的 require 只支援
// builtin 模組，必須以 createRequire(process.execPath) 從磁碟解析。
// 開發模式（tsx）與編譯後（dist/）則照常從專案 node_modules 解析，行為不變。

import { createRequire } from "node:module";

/** 目前是否以 Node SEA 單一執行檔執行。 */
export function isSeaBuild(): boolean {
  try {
    const sea = createRequire(import.meta.url)("node:sea") as { isSea?: () => boolean };
    return sea.isSea?.() ?? false;
  } catch {
    return false;
  }
}

let cachedRequire: NodeJS.Require | null = null;

/** 以執行情境對應的基準路徑 require 一個（原生）模組；解析失敗會拋錯，由呼叫端降級處理。 */
export function nativeRequire(id: string): unknown {
  if (!cachedRequire) {
    cachedRequire = createRequire(isSeaBuild() ? process.execPath : import.meta.url);
  }
  return cachedRequire(id);
}
