import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 以假的 nut.js 模組注入，驗證 paste/type 兩種送出路徑（不觸發真實按鍵）。
const nutMock = vi.hoisted(() => {
  const calls: string[] = [];
  const clipboardStore = { content: "USER-CLIP" };
  const Key = { Enter: 1, V: 2, LeftControl: 3, LeftSuper: 4 };
  const mod = {
    calls,
    clipboardStore,
    Key,
    keyboard: {
      config: { autoDelayMs: 0 },
      type: vi.fn(async (t: string) => void calls.push(`type:${t}`)),
      pressKey: vi.fn(async (...keys: number[]) => void calls.push(`press:${keys.join("+")}`)),
      releaseKey: vi.fn(async (...keys: number[]) => void calls.push(`release:${keys.join("+")}`)),
    },
    clipboard: {
      getContent: vi.fn(async () => clipboardStore.content),
      setContent: vi.fn(async (t: string) => {
        clipboardStore.content = t;
        calls.push(`clip:${t}`);
      }),
    },
  };
  return mod;
});

vi.mock("../src/runtime/nativeRequire", () => ({
  nativeRequire: () => nutMock,
  isSeaBuild: () => false,
}));

// Windows 貼上路徑：mock wscript（execFile）、clip.exe（spawn）與 VBS 檔寫入（不真的動剪貼簿/按鍵）。
const execFileMock = vi.hoisted(() =>
  vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, o?: unknown) => void) => cb(null, { stdout: "", stderr: "" })),
);
const clipState = vi.hoisted(() => ({ writes: [] as string[], failClose: false }));
const spawnMock = vi.hoisted(() =>
  vi.fn(() => {
    const child = {
      stdin: { once: vi.fn(), end: vi.fn((data: string) => clipState.writes.push(String(data))) },
      once(ev: string, cb: (arg?: unknown) => void) {
        if (ev === "close") setTimeout(() => cb(clipState.failClose ? 1 : 0), 0);
        return child;
      },
    };
    return child;
  }),
);
vi.mock("node:child_process", () => ({ execFile: execFileMock, spawn: spawnMock }));
const writeFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ writeFileSync: writeFileSyncMock }));

import { KeyboardEmulator } from "../src/keyboard/KeyboardEmulator";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log } as never;
const flush = () => new Promise((r) => setTimeout(r, 250)); // 等佇列與剪貼簿還原完成

beforeEach(() => {
  nutMock.calls.length = 0;
  nutMock.clipboardStore.content = "USER-CLIP";
  clipState.writes.length = 0;
  clipState.failClose = false;
  vi.clearAllMocks();
});

describe("KeyboardEmulator paste 模式", () => {
  it("以剪貼簿貼上整串，且不逐字輸入", async () => {
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: false, paste: true });
    kb.typeBarcode("8710033012345");
    await flush();
    // 應設剪貼簿為條碼、送出貼上快捷鍵（darwin=LeftSuper(4)，其他=LeftControl(3)）＋V(2)，且沒有逐字 type。
    const modifier = process.platform === "darwin" ? 4 : 3;
    expect(nutMock.clipboard.setContent).toHaveBeenCalledWith("8710033012345");
    expect(nutMock.keyboard.pressKey).toHaveBeenCalledWith(modifier, 2);
    expect(nutMock.keyboard.type).not.toHaveBeenCalledWith("8710033012345");
  });

  it("貼上後還原使用者原本的剪貼簿內容", async () => {
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: false, paste: true });
    kb.typeBarcode("ABC123");
    await flush();
    expect(nutMock.clipboardStore.content).toBe("USER-CLIP"); // 已還原
  });

  it("pressEnter=true 時貼上後補送 Enter", async () => {
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: true, paste: true });
    kb.typeBarcode("X");
    await flush();
    expect(nutMock.keyboard.pressKey).toHaveBeenCalledWith(1); // Key.Enter
  });
});

describe("KeyboardEmulator type 模式", () => {
  it("paste=false 時逐字輸入，不動剪貼簿", async () => {
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: false, paste: false });
    kb.typeBarcode("9900");
    await flush();
    expect(nutMock.keyboard.type).toHaveBeenCalledWith("9900");
    expect(nutMock.clipboard.setContent).not.toHaveBeenCalled();
  });
});

describe("KeyboardEmulator 停用", () => {
  it("enabled=false 時完全不送出", async () => {
    const kb = new KeyboardEmulator(log, { enabled: false, pressEnter: true, paste: true });
    kb.typeBarcode("NOPE");
    await flush();
    expect(nutMock.keyboard.type).not.toHaveBeenCalled();
    expect(nutMock.clipboard.setContent).not.toHaveBeenCalled();
  });
});

describe("KeyboardEmulator Windows 貼上模式", () => {
  let origPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });
  afterEach(() => {
    if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
  });

  const lastWscriptCall = () => {
    const call = execFileMock.mock.calls.at(-1) as unknown as [string, string[]];
    return { cmd: call[0], args: call[1] };
  };

  it("整串寫入剪貼簿後以 wscript 送 Ctrl+V 貼上，不用 nut.js", async () => {
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: false, paste: true });
    kb.typeBarcode("8710033012345");
    await flush();
    // clip.exe 收到完整條碼（一次貼入，非逐字）
    expect(spawnMock).toHaveBeenCalledWith("clip.exe", [], expect.anything());
    expect(clipState.writes).toContain("8710033012345");
    // wscript 執行 VBS helper（送 Ctrl+V）
    const { cmd, args } = lastWscriptCall();
    expect(cmd).toBe("wscript.exe");
    expect(args.some((a) => a.endsWith(".vbs"))).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    expect(nutMock.clipboard.setContent).not.toHaveBeenCalled();
    expect(nutMock.keyboard.type).not.toHaveBeenCalled();
  });

  it("pressEnter=true → 傳給 VBS 的旗標為 \"1\"（貼上後補 Enter）", async () => {
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: true, paste: true });
    kb.typeBarcode("X1");
    await flush();
    expect(lastWscriptCall().args.at(-1)).toBe("1");
  });

  it("pressEnter=false → 旗標為 \"0\"（不補 Enter）", async () => {
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: false, paste: true });
    kb.typeBarcode("X2");
    await flush();
    expect(lastWscriptCall().args.at(-1)).toBe("0");
  });

  it("clip.exe 失敗 → 自動退回 nut.js", async () => {
    clipState.failClose = true;
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: false, paste: false });
    kb.typeBarcode("FALLBACK1");
    await flush();
    expect(nutMock.keyboard.type).toHaveBeenCalledWith("FALLBACK1");
  });

  it("wscript 失敗 → 自動退回 nut.js", async () => {
    execFileMock.mockImplementationOnce(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) => cb(new Error("wscript blocked")),
    );
    const kb = new KeyboardEmulator(log, { enabled: true, pressEnter: false, paste: false });
    kb.typeBarcode("FALLBACK2");
    await flush();
    expect(nutMock.keyboard.type).toHaveBeenCalledWith("FALLBACK2");
  });
});
