import { describe, it, expect } from "vitest";
import { parseHidPosReport } from "../src/parsing/hidPosReport";

// 以 4 bytes 表頭 + ASCII 條碼組出一筆 report。
function report(barcode: string, { header = [0, 0, 0, 0], trailer = [] as number[] } = {}): number[] {
  return [...header, ...[...barcode].map((c) => c.charCodeAt(0)), ...trailer];
}

describe("parseHidPosReport", () => {
  it("IBM 模式：一筆 report＝一條 barcode（無 CR/LF）", () => {
    expect(parseHidPosReport(report("4710088123456"))).toEqual(["4710088123456"]);
  });

  it("跳過表頭 bytes（預設 4）", () => {
    // 前 4 byte 是表頭（含可列印字元也要被跳過）
    const bytes = [0x41, 0x42, 0x43, 0x44, ...[..."CODE39"].map((c) => c.charCodeAt(0))];
    expect(parseHidPosReport(bytes)).toEqual(["CODE39"]);
  });

  it("CR 結尾也能解析（去除終止符）", () => {
    expect(parseHidPosReport(report("ABC", { trailer: [0x0d] }))).toEqual(["ABC"]);
  });

  it("NUL 視為結束，後面的 padding 不計入", () => {
    expect(parseHidPosReport(report("ABC", { trailer: [0x00, 0x41, 0x42] }))).toEqual(["ABC"]);
  });

  it("同一 report 內 CR 分隔多條", () => {
    const bytes = [0, 0, 0, 0, ...[..."AAA"].map((c) => c.charCodeAt(0)), 0x0d, ...[..."BBB"].map((c) => c.charCodeAt(0))];
    expect(parseHidPosReport(bytes)).toEqual(["AAA", "BBB"]);
  });

  it("空 / 全表頭 report 回空陣列", () => {
    expect(parseHidPosReport([0, 0, 0, 0])).toEqual([]);
    expect(parseHidPosReport([])).toEqual([]);
  });

  it("可調 headerBytes（例如 node-hid 前置 reportId 時設 5）", () => {
    const bytes = [0x02, 0, 0, 0, 0, ...[..."X1"].map((c) => c.charCodeAt(0))];
    expect(parseHidPosReport(bytes, 5)).toEqual(["X1"]);
  });
});
