import { describe, it, expect } from "vitest";
import { LineFramer } from "../src/parsing/LineFramer";

describe("LineFramer", () => {
  it("CRLF 終止單行", () => {
    const f = new LineFramer();
    expect(f.push("abc\r\n")).toEqual(["abc"]);
  });

  it("跨片段組裝（殘段保留至下次）", () => {
    const f = new LineFramer();
    expect(f.push("ab")).toEqual([]);
    expect(f.push("c\n")).toEqual(["abc"]);
  });

  it("一次多行、最後殘段留在 buffer", () => {
    const f = new LineFramer();
    expect(f.push("a\nb\nc")).toEqual(["a", "b"]);
    expect(f.push("\n")).toEqual(["c"]);
  });

  it("接受 lone CR 與 lone LF", () => {
    const f = new LineFramer();
    expect(f.push("x\ry\n")).toEqual(["x", "y"]);
  });

  it("無終止符暴長超過上限時丟棄整段（不當成一行吐出）並清空", () => {
    const f = new LineFramer(8);
    const long = "0123456789"; // 10 chars > 8
    expect(f.push(long)).toEqual([]); // 丟棄，不回傳毀損資料
    expect(f.overflowCount).toBe(1);
    // 已清空，後續從頭累積
    expect(f.push("ok\n")).toEqual(["ok"]);
  });

  it("reset 清空殘段", () => {
    const f = new LineFramer();
    f.push("partial");
    f.reset();
    expect(f.push("\n")).toEqual([""]);
  });
});
