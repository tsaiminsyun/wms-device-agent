// Windows：以 pnputil 重啟 COM 埠對應的 USB 裝置（等同裝置管理員「停用→啟用」＝軟體重插）。
// 用途：救回 CH340 等驅動卡死（開埠時 SetCommState error 31）。需系統管理員權限（服務模式為 SYSTEM，可用）。

import { pexec } from "../../runtime/proc.js";
import type { Logger } from "../../logger.js";
import type { SerialPortInfo } from "./serialLoader.js";

const RESTART_TIMEOUT_MS = 15_000;

/** 重啟埠背後的 USB 裝置；成功回 true（裝置會短暫消失後重新列舉）。失敗（無權限／無實例 ID）回 false。 */
export async function restartUsbDevice(info: SerialPortInfo, log: Logger): Promise<boolean> {
  if (process.platform !== "win32") return false;
  // Windows 的 pnpId 即裝置實例 ID（如 USB\VID_1A86&PID_7523\5&…），pnputil 直接可用。
  const id = info.pnpId;
  if (!id) {
    log.debug(`無法自動重啟 ${info.path}：缺少裝置實例 ID（pnpId）`);
    return false;
  }
  try {
    await pexec("pnputil", ["/restart-device", id], { windowsHide: true, timeout: RESTART_TIMEOUT_MS });
    return true;
  } catch (err) {
    log.debug(`重啟 USB 裝置失敗（${id}）：`, err);
    return false;
  }
}
