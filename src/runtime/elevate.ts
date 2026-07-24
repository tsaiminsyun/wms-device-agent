// Windows 打包版：開啟時強制以系統管理員身分執行。未提權則以 UAC（runas）重啟自己並結束本行程。
// 用 cscript/VBS 的 ShellExecute runas（不使用 PowerShell，避免企業政策封鎖）。

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSeaBuild } from "./nativeRequire.js";

// 是否已以系統管理員執行：'net session' 需管理員權限，成功（exit 0）即為已提權。
function isAdmin(): boolean {
  try {
    return spawnSync("net", ["session"], { windowsHide: true, stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** Windows 打包版未提權時以 UAC 重啟自己並結束本行程；已提權或非 Windows/開發環境則直接返回。 */
export function ensureAdminOrRelaunch(): void {
  if (process.platform !== "win32" || !isSeaBuild()) return;
  if (isAdmin()) return;

  const exe = process.execPath;
  const cwd = process.cwd();
  // 保留使用者旗標（SEA 下 argv[1] 起才是使用者引數）；各引數以雙引號包住（VBS 內雙引號寫作 ""）。
  const argStr = process.argv
    .slice(1)
    .map((a) => `""${a}""`)
    .join(" ");
  const vbsPath = join(tmpdir(), "wms-agent-elevate.vbs");
  const vbs =
    `Set sh = CreateObject("Shell.Application")\r\n` + `sh.ShellExecute "${exe}", "${argStr}", "${cwd}", "runas", 1\r\n`;
  try {
    writeFileSync(vbsPath, vbs, "utf8");
    // spawnSync：等 wscript 觸發 UAC 並啟動提權實例後才結束本行程，避免提前退出中斷啟動。
    spawnSync("wscript.exe", ["//B", "//Nologo", vbsPath], { windowsHide: true, stdio: "ignore" });
  } catch {
    return; // 提權啟動失敗：以目前權限繼續（總比完全不啟動好）
  }
  process.exit(0);
}
