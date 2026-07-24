// 埠接管（單一實例保障）：占用者確為本程式舊實例才處理，先優雅關閉逾時才強殺；絕不誤殺其他程式。

import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pexec } from "./proc.js";
import type { Logger } from "../logger.js";

// 優雅關閉請求逾時／等舊實例退出上限（對方關閉看門狗 4s，取 6s 留餘裕）。
const GRACEFUL_REQUEST_TIMEOUT_MS = 1_500;
const GRACEFUL_EXIT_TIMEOUT_MS = 6_000;

// 我方執行檔名（打包後 exe，開發期 node）。
function ownImageName(): string {
  return basename(process.execPath).toLowerCase();
}

// 找出占用該本地埠的 PID（排除自己）。
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

// PID 是否仍存活（signal 0 探測；EPERM＝活著但無權限）。
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// 請舊實例優雅關閉；202 才算受理（舊版無此端點會回 404 → 交回強制結束）。
async function requestGracefulShutdown(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(GRACEFUL_REQUEST_TIMEOUT_MS),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

async function waitForPidsExit(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(pidAlive)) {
    if (Date.now() >= deadline) return false;
    await delay(250);
  }
  return true;
}

/** 若埠被本程式的另一實例占用，接手釋放：先優雅關閉，逾時才強制結束。回傳是否有結束任何程序。 */
export async function freePortIfOwnedByUs(port: number, log: Logger): Promise<boolean> {
  const pids = await findPortPids(port);
  if (pids.length === 0) return false;
  const ours: number[] = [];
  for (const pid of pids) {
    if (await pidIsOwnExe(pid)) ours.push(pid);
    else log.warn(`埠占用者 PID ${pid} 並非 ${ownImageName()}，不予結束（避免誤殺其他程式）。`);
  }
  if (ours.length === 0) return false;

  // 【重連關鍵】強殺會硬斷 COM 控制代碼使 CH340 驅動卡死（下次開埠 SetCommState error 31，需重插）；
  // 故先請舊實例優雅關閉，讓它 flush＋close 序列埠後退出，交接才乾淨。
  log.notice(`埠 ${port} 由本程式舊實例占用（PID ${ours.join("、")}）：請求優雅關閉…`);
  if ((await requestGracefulShutdown(port)) && (await waitForPidsExit(ours, GRACEFUL_EXIT_TIMEOUT_MS))) {
    log.notice("舊實例已優雅結束（序列埠已乾淨釋放），接手啟動。");
    return true;
  }

  let killed = false;
  for (const pid of ours) {
    if (!pidAlive(pid)) {
      killed = true;
      continue;
    }
    try {
      log.notice(`舊實例（PID ${pid}）未回應優雅關閉，強制結束以接手（COM 埠可能需重插或自動重啟 USB 才能恢復）…`);
      await killPid(pid);
      killed = true;
    } catch (err) {
      log.warn(`結束 PID ${pid} 失敗：`, err);
    }
  }
  return killed;
}
