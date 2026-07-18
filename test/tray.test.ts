import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 擷取假 systray2 的建構參數與點擊 callback，驗證選單與點擊行為（不需真的工作列）。
const trayState = vi.hoisted(() => ({
  conf: null as null | { menu: { icon: string; tooltip: string; items: { title: string }[] } },
  clickCb: null as null | ((a: { item?: unknown; __id?: number }) => void),
  killed: false,
  readyResolve: true, // ready() 是否 resolve
}));

class FakeSysTray {
  constructor(conf: unknown) {
    trayState.conf = conf as typeof trayState.conf;
  }
  ready(): Promise<void> {
    return trayState.readyResolve ? Promise.resolve() : Promise.reject(new Error("init failed"));
  }
  onError(): void {}
  onExit(): void {}
  async onClick(cb: (a: { item?: unknown; __id?: number }) => void): Promise<this> {
    trayState.clickCb = cb;
    return this;
  }
  async kill(): Promise<void> {
    trayState.killed = true;
  }
}

vi.mock("../src/runtime/nativeRequire", () => ({
  nativeRequire: () => ({ default: FakeSysTray }),
  isSeaBuild: () => false,
}));

import { Tray, type TrayMenuItem } from "../src/tray/Tray";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log } as never;
const flush = () => new Promise((r) => setTimeout(r, 0)); // 等 ready().then 掛好 onClick

// 標準測試選單：兩個項目（模擬「開啟」與「結束」）。
function makeItems(): { items: TrayMenuItem[]; onLogs: ReturnType<typeof vi.fn>; onExit: ReturnType<typeof vi.fn> } {
  const onLogs = vi.fn();
  const onExit = vi.fn();
  return {
    items: [
      { title: "開啟", tooltip: "開啟 log 資料夾", onClick: onLogs },
      { title: "結束", tooltip: "完全結束程式", onClick: onExit },
    ],
    onLogs,
    onExit,
  };
}

// 取回 Tray 內部建立、放進選單的項目物件（模擬 systray2 回傳同一參照）。
const menuItem = (title: string) => trayState.conf!.menu.items.find((i) => i.title === title);

let origPlatform: PropertyDescriptor | undefined;
beforeEach(() => {
  trayState.conf = null;
  trayState.clickCb = null;
  trayState.killed = false;
  trayState.readyResolve = true;
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});
afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
});

describe("Tray (win32)", () => {
  it("依 items 建立選單，並帶入圖示與版本", () => {
    const { items } = makeItems();
    new Tray(log, { version: "1.2.3", items }).start();
    const conf = trayState.conf!;
    expect(conf.menu.icon.length).toBeGreaterThan(100);
    expect(conf.menu.tooltip).toContain("1.2.3");
    const titles = conf.menu.items.map((i) => i.title);
    expect(titles).toContain("開啟");
    expect(titles).toContain("結束");
  });

  it("onClick 只在 ready() 後才註冊（避免 _process 尚未建立而丟錯）", async () => {
    new Tray(log, { version: "1", items: makeItems().items }).start();
    expect(trayState.clickCb).toBeNull(); // ready 尚未解析前不掛
    await flush();
    expect(trayState.clickCb).not.toBeNull(); // ready 後才掛
  });

  it("點選單項目（以物件參照回傳）→ 呼叫對應 onClick，且只呼叫該項", async () => {
    const { items, onLogs, onExit } = makeItems();
    new Tray(log, { version: "1", items }).start();
    await flush();
    trayState.clickCb!({ item: menuItem("結束") });
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onLogs).not.toHaveBeenCalled();
    trayState.clickCb!({ item: menuItem("開啟") });
    expect(onLogs).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("點擊比對也支援標題（參照對不上時的後備）", async () => {
    const { items, onExit } = makeItems();
    new Tray(log, { version: "1", items }).start();
    await flush();
    trayState.clickCb!({ item: { title: "結束" } }); // 不同物件，只有標題相同
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("onClick 丟例外 → 不往外拋（記 warn）", async () => {
    const boom = vi.fn(() => {
      throw new Error("boom");
    });
    new Tray(log, { version: "1", items: [{ title: "爆", tooltip: "", onClick: boom }] }).start();
    await flush();
    expect(() => trayState.clickCb!({ item: menuItem("爆") })).not.toThrow();
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("stop() 收攤 helper", async () => {
    const t = new Tray(log, { version: "1", items: makeItems().items });
    t.start();
    await flush();
    await t.stop();
    expect(trayState.killed).toBe(true);
  });

  it("ready() 失敗不丟出、不掛 onClick（降級）", async () => {
    trayState.readyResolve = false;
    new Tray(log, { version: "1", items: makeItems().items }).start();
    await flush();
    expect(trayState.clickCb).toBeNull();
  });
});

describe("Tray (非 win32)", () => {
  it("非 Windows 平台不建立工作列（不呼叫 systray2）", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    new Tray(log, { version: "1", items: makeItems().items }).start();
    expect(trayState.conf).toBeNull();
  });
});
