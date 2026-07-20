import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 攔截 pnputil 呼叫（不真的重啟裝置）。
const execState = vi.hoisted(() => ({ fail: false, calls: [] as Array<{ cmd: string; args: string[] }> }));
const execFileMock = vi.hoisted(() =>
  vi.fn((cmd: string, args: string[], _opts: unknown, cb: (e: unknown, o: unknown) => void) => {
    execState.calls.push({ cmd, args });
    cb(execState.fail ? new Error("Access is denied.") : null, { stdout: "", stderr: "" });
  }),
);
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { restartUsbDevice } from "../src/devices/serial/usbRestart";
import type { Logger } from "../src/logger";

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

const INFO = { path: "COM4", vendorId: "1a86", productId: "7523", pnpId: "USB\\VID_1A86&PID_7523\\5&2C0A&0&2" };

let origPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  execState.fail = false;
  execState.calls = [];
  execFileMock.mockClear();
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
});

describe("restartUsbDevice", () => {
  it("以 pnputil /restart-device 帶入 pnpId（裝置實例 ID）重啟", async () => {
    await expect(restartUsbDevice(INFO, log)).resolves.toBe(true);
    expect(execState.calls).toEqual([{ cmd: "pnputil", args: ["/restart-device", INFO.pnpId] }]);
  });

  it("pnputil 失敗（如無管理員權限）回 false", async () => {
    execState.fail = true;
    await expect(restartUsbDevice(INFO, log)).resolves.toBe(false);
  });

  it("缺 pnpId 時不執行並回 false", async () => {
    await expect(restartUsbDevice({ path: "COM4" }, log)).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("非 Windows 平台直接回 false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    await expect(restartUsbDevice(INFO, log)).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
