import { describe, it, expect } from "vitest";
import { ScanDebouncer } from "../src/devices/scanDedup";

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
