// 埠接管（單一實例保障）：僅當占用者確為本程式殘留實例時才強制結束以接手，絕不誤殺其他程式。

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../logger.js";

const pexec = promisify(execFile);

// 我方執行檔名（打包後 wms-device-agent.exe，開發期 node）。
function ownImageName(): string {
  return basename(process.execPath).toLowerCase();
}

// 找出占用該本地埠的 PID 集合（排除自己）。
async function findPortPids(port: number): Promise<number[]> {
  const pids = new Set<number>();
  try {
    if (process.platform === "win32") {
      // 不比對狀態字串（語系差異）；本地位址以 :port 結尾即取末欄 PID。
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
    // lsof/netstat 失敗：無法接管，交回上層重試。
    return [];
  }
  pids.delete(process.pid);
  return [...pids];
}

// 確認某 PID 執行檔名與本程式相同（相同才允許結束）。
async function pidIsOwnExe(pid: number): Promise<boolean> {
  const self = ownImageName();
  try {
    if (process.platform === "win32") {
      const { stdout } = await pexec("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true });
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

/** 若埠被本程式的另一實例占用，強制結束它以釋放埠。回傳是否有結束任何程序。 */
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
