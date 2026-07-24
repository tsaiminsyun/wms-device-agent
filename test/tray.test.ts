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

import { Tray } from "../src/tray/Tray";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), notice: vi.fn(), user: vi.fn(), child: () => log } as never;
const LOGS_TITLE = "開啟 Log";
const RESTART_TITLE = "重啟服務";
const EXIT_TITLE = "結束";
const flush = () => new Promise((r) => setTimeout(r, 0)); // 等 ready().then 掛好 onClick

// 取回 Tray 內部建立、放進選單的項目物件（模擬 systray2 回傳同一參照）。
const itemBy = (title: string) => trayState.conf!.menu.items.find((i) => i.title === title);

const mkOpts = (over: Partial<Record<"onOpenLog" | "onRestart" | "onExit", () => void>> = {}) => ({
  version: "1.2.3",
  onOpenLog: vi.fn(),
  onRestart: vi.fn(),
  onExit: vi.fn(),
  ...over,
});

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
  it("建立含三個選單項目的選單，並帶入圖示與版本", () => {
    new Tray(log, mkOpts()).start();
    const conf = trayState.conf!;
    expect(conf.menu.icon.length).toBeGreaterThan(100);
    expect(conf.menu.tooltip).toContain("1.2.3");
    const titles = conf.menu.items.map((i) => i.title);
    expect(titles).toContain(LOGS_TITLE);
    expect(titles).not.toContain("檢查連線狀態");
    expect(titles).toContain(RESTART_TITLE);
    expect(titles).toContain(EXIT_TITLE);
  });

  it("onClick 只在 ready() 後才註冊（避免 _process 尚未建立而丟錯）", async () => {
    new Tray(log, mkOpts()).start();
    expect(trayState.clickCb).toBeNull(); // ready 尚未解析前不掛
    await flush();
    expect(trayState.clickCb).not.toBeNull(); // ready 後才掛
  });

  it("點各項目（以物件參照回傳）→ 呼叫對應 callback", async () => {
    const opts = mkOpts();
    new Tray(log, opts).start();
    await flush();
    trayState.clickCb!({ item: itemBy(LOGS_TITLE) });
    trayState.clickCb!({ item: itemBy(RESTART_TITLE) });
    trayState.clickCb!({ item: itemBy(EXIT_TITLE) });
    expect(opts.onOpenLog).toHaveBeenCalledTimes(1);
    expect(opts.onRestart).toHaveBeenCalledTimes(1);
    expect(opts.onExit).toHaveBeenCalledTimes(1);
  });

  it("點擊比對也支援標題（參照對不上時的後備）", async () => {
    const opts = mkOpts();
    new Tray(log, opts).start();
    await flush();
    trayState.clickCb!({ item: { title: RESTART_TITLE } }); // 不同物件，只有標題相同
    expect(opts.onRestart).toHaveBeenCalledTimes(1);
    expect(opts.onOpenLog).not.toHaveBeenCalled();
  });

  it("stop() 收攤 helper", async () => {
    const t = new Tray(log, mkOpts());
    t.start();
    await flush();
    await t.stop();
    expect(trayState.killed).toBe(true);
  });

  it("ready() 失敗不丟出、不掛 onClick（降級）", async () => {
    trayState.readyResolve = false;
    new Tray(log, mkOpts()).start();
    await flush();
    expect(trayState.clickCb).toBeNull();
  });
});

describe("Tray (非 win32)", () => {
  it("非 Windows 平台不建立工作列（不呼叫 systray2）", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    new Tray(log, mkOpts()).start();
    expect(trayState.conf).toBeNull();
  });
});
