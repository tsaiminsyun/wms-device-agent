import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 模擬「Windows＋SEA 打包」環境，驗證前台視窗／背景工作實例的分流邏輯（不真的 spawn）。
const seaState = vi.hoisted(() => ({ isSea: true }));
vi.mock("../src/runtime/nativeRequire", () => ({
  isSeaBuild: () => seaState.isSea,
  nativeRequire: () => ({}),
}));

const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })));
const execFileMock = vi.hoisted(() =>
  vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, o: unknown) => void) => cb(null, { stdout: "", stderr: "" })),
);
vi.mock("node:child_process", () => ({ spawn: spawnMock, execFile: execFileMock }));

const fsState = vi.hoisted(() => ({ entries: [] as string[], unlinkFail: new Set<string>() }));
const unlinkSyncMock = vi.hoisted(() =>
  vi.fn((p: string) => {
    if (fsState.unlinkFail.has(p.split(/[\\/]/).pop() ?? "")) throw new Error("EBUSY");
  }),
);
vi.mock("node:fs", () => ({
  openSync: vi.fn(() => 7),
  closeSync: vi.fn(),
  readSync: vi.fn(() => 0),
  statSync: vi.fn(() => ({ size: 0 })),
  readdirSync: vi.fn(() => fsState.entries),
  unlinkSync: unlinkSyncMock,
}));

import { runWindowsLauncherIfNeeded, killRelatedProcesses, openWithShell, cleanupLogFiles } from "../src/runtime/detach";

const HEALTH = "http://127.0.0.1:8788/health";
let origPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers(); // tail 的 setInterval 用假時鐘，避免測試殘留計時器
  spawnMock.mockClear();
  execFileMock.mockClear();
  unlinkSyncMock.mockClear();
  fsState.entries = [];
  fsState.unlinkFail = new Set();
  seaState.isSea = true;
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  delete process.env.WMS_AGENT_WORKER;
  delete process.env.WMS_LAUNCHER_QUIET;
  delete process.env.WMS_NO_DETACH;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
});

afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.WMS_AGENT_WORKER;
  delete process.env.WMS_LAUNCHER_QUIET;
  delete process.env.WMS_NO_DETACH;
});

describe("runWindowsLauncherIfNeeded", () => {
  it("啟動器：未在執行 → spawn 背景工作實例（detached＋隱藏＋WORKER 旗標）並回傳 true（不開視窗）", async () => {
    const isLauncher = await runWindowsLauncherIfNeeded(HEALTH);
    expect(isLauncher).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([]);
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect((opts.env as Record<string, string>).WMS_AGENT_WORKER).toBe("1");
  });

  it("已在執行（health 回 200）→ 不再 spawn（不重複啟動），靜默結束", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const isLauncher = await runWindowsLauncherIfNeeded(HEALTH);
    expect(isLauncher).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("背景工作實例（WMS_AGENT_WORKER=1）→ 回傳 false，照常執行代理", async () => {
    process.env.WMS_AGENT_WORKER = "1";
    expect(await runWindowsLauncherIfNeeded(HEALTH)).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("WMS_NO_DETACH=1 逃生開關 → 回傳 false（單行程直跑）", async () => {
    process.env.WMS_NO_DETACH = "1";
    expect(await runWindowsLauncherIfNeeded(HEALTH)).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("WMS_LAUNCHER_QUIET=1（開機自動啟動）→ spawn 後直接退出、不留視窗", async () => {
    process.env.WMS_LAUNCHER_QUIET = "1";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as never);
    await runWindowsLauncherIfNeeded(HEALTH);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("非 Windows → 一律回傳 false", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(await runWindowsLauncherIfNeeded(HEALTH)).toBe(false);
  });

  it("非 SEA（開發環境）→ 一律回傳 false", async () => {
    seaState.isSea = false;
    expect(await runWindowsLauncherIfNeeded(HEALTH)).toBe(false);
  });
});

describe("killRelatedProcesses", () => {
  it("Windows：taskkill 關掉其他同名實例（排除自己）與工作列 helper", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return log; } } as never;
    await killRelatedProcesses(log);
    const calls = execFileMock.mock.calls.map((c) => (c as unknown as [string, string[]])[1]);
    // 第一個 taskkill：/IM <exe> 且 PID ne 自己
    const others = calls.find((a) => a.includes("/IM") && a.some((s) => s.startsWith("PID ne ")));
    expect(others).toBeTruthy();
    expect(others!.some((s) => s === `PID ne ${process.pid}`)).toBe(true);
    // 第二個 taskkill：收掉 tray helper
    expect(calls.some((a) => a.includes("tray_windows_release.exe"))).toBe(true);
  });

  it("非 Windows → 不執行 taskkill", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return log; } } as never;
    await killRelatedProcesses(log);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("openWithShell（開啟 Log 資料夾／連線狀態頁）", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child() { return this; } } as never);

  it("以 explorer.exe 開啟目標（不經 cmd，不閃主控台）", () => {
    openWithShell("C:\\app\\logs", mkLog());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(cmd).toBe("explorer.exe");
    expect(args).toEqual(["C:\\app\\logs"]);
  });

  it("URL 也交給 explorer（開預設瀏覽器）", () => {
    openWithShell("http://127.0.0.1:8788/devices", mkLog());
    const [, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual(["http://127.0.0.1:8788/devices"]);
  });

  it("非 Windows → 什麼都不做", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    openWithShell("x", mkLog());
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("cleanupLogFiles", () => {
  it("Windows＋SEA：刪掉 agent.log 與 agent.log.* 輪替檔，略過其他檔案", () => {
    fsState.entries = ["agent.log", "agent.log.1", "agent.log.2026-07-15", "config.json", "wms-device-agent.exe"];
    const { removed, failed } = cleanupLogFiles();
    expect(removed).toEqual(["agent.log", "agent.log.1", "agent.log.2026-07-15"]);
    expect(failed).toEqual([]);
    expect(unlinkSyncMock).toHaveBeenCalledTimes(3);
  });

  it("仍被占用而刪不掉的檔 → 歸入 failed（不丟例外）", () => {
    fsState.entries = ["agent.log", "agent.log.1"];
    fsState.unlinkFail = new Set(["agent.log"]); // 模擬本行程 stdout 仍持有
    const { removed, failed } = cleanupLogFiles();
    expect(removed).toEqual(["agent.log.1"]);
    expect(failed).toEqual(["agent.log"]);
  });

  it("非 Windows → 不刪任何檔", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    fsState.entries = ["agent.log"];
    const { removed } = cleanupLogFiles();
    expect(removed).toEqual([]);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it("非 SEA（開發環境）→ 不刪任何檔（避免誤刪）", () => {
    seaState.isSea = false;
    fsState.entries = ["agent.log"];
    const { removed } = cleanupLogFiles();
    expect(removed).toEqual([]);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });
});
