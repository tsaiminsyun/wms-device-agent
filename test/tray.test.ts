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

// 「檢視 Log」委派給 detach 的 showStatusWindow（啟動狀態視窗），這裡只驗證有無被呼叫。
const showStatusWindowMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/runtime/detach", () => ({ showStatusWindow: showStatusWindowMock }));

import { Tray } from "../src/tray/Tray";

const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: () => log } as never;
const EXIT_TITLE = "結束";
const LOGS_TITLE = "開啟";
const flush = () => new Promise((r) => setTimeout(r, 0)); // 等 ready().then 掛好 onClick

// 取回 Tray 內部建立、放進選單的項目物件（模擬 systray2 回傳同一參照）。
const logsItem = () => trayState.conf!.menu.items.find((i) => i.title === LOGS_TITLE);
const exitItem = () => trayState.conf!.menu.items.find((i) => i.title === EXIT_TITLE);

let origPlatform: PropertyDescriptor | undefined;
beforeEach(() => {
  trayState.conf = null;
  trayState.clickCb = null;
  trayState.killed = false;
  trayState.readyResolve = true;
  showStatusWindowMock.mockClear();
  origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});
afterEach(() => {
  if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
});

describe("Tray (win32)", () => {
  it("建立含 Exit 與 View Logs 的選單，並帶入圖示與版本", () => {
    new Tray(log, { version: "1.2.3", onExit: vi.fn() }).start();
    const conf = trayState.conf!;
    expect(conf.menu.icon.length).toBeGreaterThan(100);
    expect(conf.menu.tooltip).toContain("1.2.3");
    const titles = conf.menu.items.map((i) => i.title);
    expect(titles).toContain(EXIT_TITLE);
    expect(titles).toContain(LOGS_TITLE);
  });

  it("onClick 只在 ready() 後才註冊（避免 _process 尚未建立而丟錯）", async () => {
    new Tray(log, { version: "1", onExit: vi.fn() }).start();
    expect(trayState.clickCb).toBeNull(); // ready 尚未解析前不掛
    await flush();
    expect(trayState.clickCb).not.toBeNull(); // ready 後才掛
  });

  it("點 Exit（以物件參照回傳）→ 呼叫 onExit", async () => {
    const onExit = vi.fn();
    new Tray(log, { version: "1", onExit }).start();
    await flush();
    trayState.clickCb!({ item: exitItem() });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("點 View Logs（以物件參照回傳）→ 啟動狀態視窗，不結束程式", async () => {
    const onExit = vi.fn();
    new Tray(log, { version: "1", onExit }).start();
    await flush();
    trayState.clickCb!({ item: logsItem() });
    expect(onExit).not.toHaveBeenCalled();
    expect(showStatusWindowMock).toHaveBeenCalledTimes(1);
  });

  it("點擊比對也支援標題（參照對不上時的後備）", async () => {
    const onExit = vi.fn();
    new Tray(log, { version: "1", onExit }).start();
    await flush();
    trayState.clickCb!({ item: { title: EXIT_TITLE } }); // 不同物件，只有標題相同
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("stop() 收攤 helper", async () => {
    const t = new Tray(log, { version: "1", onExit: vi.fn() });
    t.start();
    await flush();
    await t.stop();
    expect(trayState.killed).toBe(true);
  });

  it("ready() 失敗不丟出、不掛 onClick（降級）", async () => {
    trayState.readyResolve = false;
    new Tray(log, { version: "1", onExit: vi.fn() }).start();
    await flush();
    expect(trayState.clickCb).toBeNull();
  });
});

describe("Tray (非 win32)", () => {
  it("非 Windows 平台不建立工作列（不呼叫 systray2）", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    new Tray(log, { version: "1", onExit: vi.fn() }).start();
    expect(trayState.conf).toBeNull();
  });
});
