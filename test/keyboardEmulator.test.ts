import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { KeyboardEmulator } from "../src/keyboard/KeyboardEmulator";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log } as never;
const flush = () => new Promise((r) => setTimeout(r, 250)); // 等佇列與剪貼簿還原完成

beforeEach(() => {
  nutMock.calls.length = 0;
  nutMock.clipboardStore.content = "USER-CLIP";
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
