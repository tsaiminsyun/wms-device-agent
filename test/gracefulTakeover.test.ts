import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

// ---- POST /shutdown 端點 ----

import { createApiServer } from "../src/server/httpApi";
import type { DeviceManager } from "../src/core/DeviceManager";
import type { Logger } from "../src/logger";

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

function makeServer(onShutdownRequest: () => void) {
  return createApiServer({
    log,
    agentInfo: { name: "t", version: "0", platform: "test", protocolVersion: 1 },
    deviceManager: { connectedCount: () => 0, snapshot: () => [] } as unknown as DeviceManager,
    activeClientCount: () => 0,
    claimingClientCount: () => 0,
    // allowNoOrigin=false：證明 /shutdown 不受 Origin 白名單閘門影響（本機非瀏覽器來源專用）。
    security: { allowedOrigins: ["https://wms.example"], allowNoOrigin: false },
    startedAt: Date.now(),
    onShutdownRequest,
  });
}

describe("POST /shutdown（新實例接手）", () => {
  it("無 Origin → 202 並觸發關閉回呼；帶 Origin（瀏覽器）→ 403 不觸發", async () => {
    const onShutdown = vi.fn();
    const server = makeServer(onShutdown);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" });
      expect(ok.status).toBe(202);
      expect(onShutdown).toHaveBeenCalledTimes(1);

      const browser = await fetch(`http://127.0.0.1:${port}/shutdown`, {
        method: "POST",
        headers: { origin: "https://wms.example" },
      });
      expect(browser.status).toBe(403);
      expect(onShutdown).toHaveBeenCalledTimes(1);
    } finally {
      server.close();
    }
  });
});

// ---- freePortIfOwnedByUs：優雅關閉優先，逾時才強殺 ----

const OLD_PID = 999_999;
const exec = vi.hoisted(() => ({ calls: [] as Array<{ cmd: string; args: string[] }> }));
const execFileMock = vi.hoisted(() =>
  vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: unknown, o: unknown) => void) => {
    exec.calls.push({ cmd, args });
    if (cmd === "netstat") {
      return cb(null, { stdout: `  TCP    127.0.0.1:8788    0.0.0.0:0    LISTENING    999999\r\n` });
    }
    if (cmd === "tasklist") {
      return cb(null, { stdout: `"node","999999","Console","1","10,000 K"\r\n` });
    }
    cb(null, { stdout: "", stderr: "" });
  }),
);
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { freePortIfOwnedByUs } from "../src/runtime/freePort";

let origPlatform: PropertyDescriptor | undefined;
let killSpy: ReturnType<typeof vi.spyOn>;

describe("freePortIfOwnedByUs（優雅接手）", () => {
  beforeEach(() => {
    exec.calls = [];
    execFileMock.mockClear();
    origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    killSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it("舊實例受理優雅關閉並退出 → 不執行 taskkill", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 202 }));
    // signal 0 探測：ESRCH＝已退出。
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    await expect(freePortIfOwnedByUs(8788, log)).resolves.toBe(true);
    expect(exec.calls.some((c) => c.cmd === "taskkill")).toBe(false);
  });

  it("舊版無 /shutdown 端點（404）→ 退回強制結束", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true); // 存活
    await expect(freePortIfOwnedByUs(8788, log)).resolves.toBe(true);
    expect(exec.calls).toContainEqual({ cmd: "taskkill", args: ["/F", "/PID", String(OLD_PID)] });
  });

  it("占用者非本程式 → 不動它", async () => {
    execFileMock.mockImplementationOnce((cmd, _args, _opts, cb) => {
      exec.calls.push({ cmd, args: [] });
      cb(null, { stdout: `  TCP    127.0.0.1:8788    0.0.0.0:0    LISTENING    999999\r\n` });
    });
    execFileMock.mockImplementationOnce((cmd, _args, _opts, cb) => {
      exec.calls.push({ cmd, args: [] });
      cb(null, { stdout: `"other.exe","999999","Console","1","10,000 K"\r\n` });
    });
    vi.stubGlobal("fetch", vi.fn());
    await expect(freePortIfOwnedByUs(8788, log)).resolves.toBe(false);
    expect(exec.calls.some((c) => c.cmd === "taskkill")).toBe(false);
  });
});
