import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 模擬「Windows＋SEA 打包」環境，驗證前台視窗／背景工作實例的分流邏輯（不真的 spawn）。
const seaState = vi.hoisted(() => ({ isSea: true }));
vi.mock("../src/runtime/nativeRequire", () => ({
  isSeaBuild: () => seaState.isSea,
  nativeRequire: () => ({}),
}));

// 讓監管者（superviseWorker）能在測試中驅動「worker 結束/崩潰」。
const spawnState = vi.hoisted(() => ({ exitQueue: [] as number[] }));
const spawnMock = vi.hoisted(() =>
  vi.fn(() => {
    const handlers: Record<string, (a?: unknown) => void> = {};
    const child = { unref: vi.fn(), on: vi.fn((ev: string, cb: (a?: unknown) => void) => void (handlers[ev] = cb)) };
    Promise.resolve().then(() => {
      if (!handlers.exit) return; // 只有等 exit 的（runWorkerToExit）才消耗佇列
      handlers.exit(spawnState.exitQueue.length ? spawnState.exitQueue.shift() : 0);
    });
    return child;
  }),
);
const execFileMock = vi.hoisted(() =>
  vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, o: unknown) => void) => cb(null, { stdout: "", stderr: "" })),
);
vi.mock("node:child_process", () => ({ spawn: spawnMock, execFile: execFileMock }));

vi.mock("node:fs", () => ({
  openSync: vi.fn(() => 7),
  closeSync: vi.fn(),
  writeSync: vi.fn(),
  readSync: vi.fn(() => 0),
  statSync: vi.fn(() => ({ size: 0 })),
}));

import { runWindowsLauncherIfNeeded, killRelatedProcesses, showStatusWindow } from "../src/runtime/detach";

const HEALTH = "http://127.0.0.1:8788/health";
let origPlatform: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.useFakeTimers(); // tail 的 setInterval 用假時鐘，避免測試殘留計時器
  spawnMock.mockClear();
  execFileMock.mockClear();
  spawnState.exitQueue = [];
  seaState.isSea = true;
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  delete process.env.WMS_AGENT_WORKER;
  delete process.env.WMS_LAUNCHER_QUIET;
  delete process.env.WMS_FORCE_RESTART;
  delete process.env.WMS_NO_DETACH;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
});

afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.WMS_AGENT_WORKER;
  delete process.env.WMS_LAUNCHER_QUIET;
  delete process.env.WMS_FORCE_RESTART;
  delete process.env.WMS_NO_DETACH;
});

describe("runWindowsLauncherIfNeeded", () => {
  it("前台模式：未在執行 → spawn 背景工作實例（detached＋隱藏＋WORKER 旗標）並回傳 true", async () => {
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

  it("已在執行（health 回 200）→ 不再 spawn，只當狀態視窗", async () => {
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

  it("WMS_LAUNCHER_QUIET=1 且已在執行 → 直接退出、不 spawn（不重複監管）", async () => {
    process.env.WMS_LAUNCHER_QUIET = "1";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("__exit__"); }) as never);
    await expect(runWindowsLauncherIfNeeded(HEALTH)).rejects.toThrow("__exit__");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("WMS_LAUNCHER_QUIET=1（登入自動啟動）→ 當監管者起背景 worker；worker 正常結束(0)則不重生", async () => {
    process.env.WMS_LAUNCHER_QUIET = "1";
    spawnState.exitQueue = [0];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("__exit__"); }) as never);
    await expect(runWindowsLauncherIfNeeded(HEALTH)).rejects.toThrow("__exit__");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, , opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect((opts.env as Record<string, string>).WMS_AGENT_WORKER).toBe("1");
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it("背景 worker 崩潰(code≠0) → 監管者自動重生（spawn 兩次），再正常結束則停止", async () => {
    vi.useRealTimers(); // 讓重生前的 backoff delay 真正經過
    process.env.WMS_LAUNCHER_QUIET = "1";
    spawnState.exitQueue = [1, 0]; // 第一次崩潰、第二次正常收攤
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("__exit__"); }) as never);
    await runWindowsLauncherIfNeeded(HEALTH).catch(() => undefined);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  }, 10000);

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
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), notice: vi.fn(), user: vi.fn(), child() { return log; } } as never;
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
    const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), notice: vi.fn(), user: vi.fn(), child() { return log; } } as never;
    await killRelatedProcesses(log);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("showStatusWindow", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), notice: vi.fn(), user: vi.fn(), child() { return this; } } as never);

  it("直接以 cmd start 啟動 wms-device-agent.exe 當狀態視窗（清掉 WORKER 旗標，不依賴 PowerShell）", async () => {
    process.env.WMS_AGENT_WORKER = "1"; // 模擬本行程是背景工作實例
    await showStatusWindow(mkLog());
    // 不再用 PowerShell 找回既有視窗（企業機器常封鎖 PowerShell）
    const psCall = execFileMock.mock.calls.find((c) => (c as unknown as [string])[0] === "powershell");
    expect(psCall).toBeFalsy();
    // 一律啟動一個新的 exe 狀態視窗實例
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe("cmd");
    expect(args[0]).toBe("/c");
    expect(args[1]).toBe("start");
    expect(args).toContain(process.execPath);
    // 新視窗實例不可帶 WORKER 旗標，否則會被當成背景實例、搶埠
    expect((opts.env as Record<string, string>).WMS_AGENT_WORKER).toBeUndefined();
  });

  it("非 Windows → 什麼都不做", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    await showStatusWindow(mkLog());
    expect(execFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("開新狀態視窗時不可設 windowsHide（否則視窗會被隱藏）", async () => {
    await showStatusWindow(mkLog());
    const [, , opts] = spawnMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(opts.windowsHide).toBeUndefined();
    expect(opts.detached).toBeUndefined();
  });
});
