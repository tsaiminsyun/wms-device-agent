import { describe, it, expect, vi } from "vitest";
import { ScanDebouncer, ScanEmitter } from "../src/devices/scanDedup";

describe("ScanDebouncer", () => {
  it("連續重讀同一條碼：只放行第一筆", () => {
    let t = 0;
    const d = new ScanDebouncer(1500, () => t);
    expect(d.accept("s", "ABC")).toBe(true); // 第一筆
    t = 300;
    expect(d.accept("s", "ABC")).toBe(false); // 連續重讀 → 抑制
    t = 600;
    expect(d.accept("s", "ABC")).toBe(false);
    t = 900;
    expect(d.accept("s", "ABC")).toBe(false);
  });

  it("延長式抑制：持續重讀期間即使超過原始窗仍被壓住", () => {
    let t = 0;
    const d = new ScanDebouncer(1000, () => t);
    expect(d.accept("s", "X")).toBe(true);
    for (const step of [800, 1600, 2400, 3200]) {
      t = step; // 每 800ms 一筆（< 1000ms 窗）→ 一直抑制
      expect(d.accept("s", "X")).toBe(false);
    }
  });

  it("出現空檔（> 窗）後同一條碼再讀 → 放行（刻意重掃）", () => {
    let t = 0;
    const d = new ScanDebouncer(1000, () => t);
    expect(d.accept("s", "X")).toBe(true);
    t = 500;
    expect(d.accept("s", "X")).toBe(false);
    t = 2000; // 距上次 1500ms > 1000ms 窗 → 放行
    expect(d.accept("s", "X")).toBe(true);
  });

  it("不同條碼一律立即放行", () => {
    let t = 0;
    const d = new ScanDebouncer(1500, () => t);
    expect(d.accept("s", "A")).toBe(true);
    t = 100;
    expect(d.accept("s", "B")).toBe(true);
    t = 200;
    expect(d.accept("s", "A")).toBe(true); // 與上一筆(B)不同 → 放行
  });

  it("不同裝置 key 各自獨立", () => {
    let t = 0;
    const d = new ScanDebouncer(1500, () => t);
    expect(d.accept("s1", "SAME")).toBe(true);
    expect(d.accept("s2", "SAME")).toBe(true); // 另一台照樣放行
  });

  it("windowMs=0 關閉去重：全部放行", () => {
    let t = 0;
    const d = new ScanDebouncer(0, () => t);
    expect(d.accept("s", "A")).toBe(true);
    expect(d.accept("s", "A")).toBe(true);
  });

  it("forget 後同一條碼視為新的一次", () => {
    let t = 0;
    const d = new ScanDebouncer(1500, () => t);
    expect(d.accept("s", "A")).toBe(true);
    t = 100;
    expect(d.accept("s", "A")).toBe(false);
    d.forget("s");
    t = 200;
    expect(d.accept("s", "A")).toBe(true);
  });
});

describe("ScanEmitter 忽略連線後首筆自動觸發（計數式，不受時間影響）", () => {
  function make(ignoreFirstScans: number, dedupMs = 0) {
    let t = 0;
    const emitted: string[] = [];
    const bus = { emit: (_e: string, p: { barcode: string }) => emitted.push(p.barcode) } as never;
    const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log } as never;
    const em = new ScanEmitter(bus, log, "掃碼槍", dedupMs, ignoreFirstScans, () => t);
    return { em, emitted, at: (ms: number) => (t = ms) };
  }

  it("連線後首筆（自動觸發）被忽略，之後照常", () => {
    const { em, emitted } = make(1);
    em.armIgnoreFirst("s");
    em.emit("s", "MOTEVTTC110"); // 連線後第一筆 → 忽略
    expect(emitted).toEqual([]);
    em.emit("s", "REAL-1");
    em.emit("s", "REAL-2");
    expect(emitted).toEqual(["REAL-1", "REAL-2"]);
  });

  it("不受時間影響：即使首筆延遲很久（Windows 卡住迴圈）仍被忽略", () => {
    const { em, emitted, at } = make(1);
    em.armIgnoreFirst("s");
    at(60_000); // 原生模組載入卡住 60 秒後才處理到自動觸發那筆
    em.emit("s", "MOTEVTTC110"); // 計數式 → 照樣忽略（時間窗式會失準放行）
    expect(emitted).toEqual([]);
  });

  it("只守首筆：第二筆立刻放行", () => {
    const { em, emitted } = make(1);
    em.armIgnoreFirst("s");
    em.emit("s", "AUTO"); // 忽略
    em.emit("s", "REAL"); // 放行
    expect(emitted).toEqual(["REAL"]);
  });

  it("可設定忽略前 N 筆", () => {
    const { em, emitted } = make(2);
    em.armIgnoreFirst("s");
    em.emit("s", "AUTO1");
    em.emit("s", "AUTO2");
    em.emit("s", "REAL");
    expect(emitted).toEqual(["REAL"]);
  });

  it("ignoreFirstScans=0 關閉：首筆照常放行", () => {
    const { em, emitted } = make(0);
    em.armIgnoreFirst("s");
    em.emit("s", "AUTO");
    expect(emitted).toEqual(["AUTO"]);
  });

  it("forget 清掉首筆過濾狀態", () => {
    const { em, emitted } = make(1);
    em.armIgnoreFirst("s");
    em.forget("s");
    em.emit("s", "X"); // 已 forget → 不再守首筆
    expect(emitted).toEqual(["X"]);
  });
});
