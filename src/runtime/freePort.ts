// 埠接管（單一實例保障）：重啟時若埠仍被占用，多半是舊的 wms-device-agent 尚未退出
// （常見於：以隱藏視窗/排程啟動的孤兒程序、或用工作管理員對無視窗程序「結束工作」時收不到訊號）。
// 這裡找出正在監聽該埠的程序，「只有在它確實是我們自己的執行檔」時才強制結束它，
// 讓新實例接手。強制結束會由 OS 一併回收該程序的所有控制代碼——包含被它卡住的序列埠。
//
// 安全界線：絕不亂殺 PID。務必先確認占用者的映像名／執行檔與本程式相同，避免誤殺其他程式。

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../logger.js";

const pexec = promisify(execFile);

// 我方執行檔名（打包後為 wms-device-agent.exe；開發期為 node）。用來比對占用者是否為「我們自己」。
function ownImageName(): string {
  return basename(process.execPath).toLowerCase();
}

// 找出正在監聽（或已在該本地埠上）的 PID 集合，排除自己。
async function findPortPids(port: number): Promise<number[]> {
  const pids = new Set<number>();
  try {
    if (process.platform === "win32") {
      // netstat 狀態字串在各語系 Windows 仍為英文，但為求穩健：不比對狀態，
      // 只要「本地位址以 :port 結尾」就取該行最後一欄為 PID（伺服器監聽與其已接受連線都屬同一 PID）。
      const { stdout } = await pexec("netstat", ["-ano", "-p", "tcp"], { windowsHide: true });
      for (const line of stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const local = parts[1];
        const pid = Number(parts[parts.length - 1]);
        if (local?.endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    } else {
      const { stdout } = await pexec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
      for (const line of stdout.split(/\r?\n/)) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
  } catch {
    // lsof/netstat 缺席或失敗：無法接管，交回上層繼續重試。
    return [];
  }
  pids.delete(process.pid);
  return [...pids];
}

// 確認某 PID 的執行檔／映像名是否與本程式相同（只有相同才允許結束它）。
async function pidIsOwnExe(pid: number): Promise<boolean> {
  const self = ownImageName();
  try {
    if (process.platform === "win32") {
      const { stdout } = await pexec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
      // 形如：\"wms-device-agent.exe\",\"12345\",...
      const m = stdout.match(/^"([^"]+)"/);
      return m?.[1] ? m[1].toLowerCase() === self : false;
    }
    const { stdout } = await pexec("ps", ["-p", String(pid), "-o", "comm="]);
    return basename(stdout.trim()).toLowerCase() === self;
  } catch {
    return false;
  }
}

async function killPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await pexec("taskkill", ["/F", "/PID", String(pid)], { windowsHide: true });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

/**
 * 若指定埠被「我們自己的另一個實例」占用，強制結束它以釋放埠（與其卡住的序列埠）。
 * 回傳是否確有結束任何程序。絕不結束非本程式的程序。
 */
export async function freePortIfOwnedByUs(port: number, log: Logger): Promise<boolean> {
  const pids = await findPortPids(port);
  if (pids.length === 0) return false;
  let killed = false;
  for (const pid of pids) {
    if (!(await pidIsOwnExe(pid))) {
      log.warn(`埠占用者 PID ${pid} 並非 ${ownImageName()}，不予結束（避免誤殺其他程式）。`);
      continue;
    }
    try {
      log.warn(`偵測到殘留的舊實例（PID ${pid}）占用埠，強制結束以接手…`);
      await killPid(pid);
      killed = true;
    } catch (err) {
      log.warn(`結束 PID ${pid} 失敗：`, err);
    }
  }
  return killed;
}
