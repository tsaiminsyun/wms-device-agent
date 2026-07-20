// 執行模式判定：同一顆 exe 依旗標/環境變數扮演不同角色。
//   default：雙擊＝靜默啟動器（不開視窗）＋背景工作實例（見 detach.ts）。
//   service：Windows 服務模式（NSSM 註冊時寫入 WMS_RUN_MODE=service）——單行程、無視窗、
//            log 寫每日輪替檔；不掛工作列圖示（session 0 畫不出來）、鍵盤輸出改委派給 tray 元件。
//   tray   ：每位使用者登入時啟動的工作列元件（--tray）——顯示系統匣選單，
//            並以 WS 連上服務接收條碼、在使用者桌面做鍵盤輸出。

export type RunMode = "default" | "service" | "tray";

/** 是否帶有指定 CLI 旗標（SEA 打包下 argv[0]/argv[1] 皆為 exe 路徑，掃 argv 其餘即可）。 */
export function hasCliFlag(flag: string): boolean {
  return process.argv.slice(1).includes(flag);
}

export function getRunMode(): RunMode {
  const env = (process.env.WMS_RUN_MODE ?? "").trim().toLowerCase();
  if (env === "service" || hasCliFlag("--service")) return "service";
  if (env === "tray" || hasCliFlag("--tray")) return "tray";
  return "default";
}
