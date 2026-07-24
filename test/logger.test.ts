import { describe, it, expect, vi, beforeEach } from "vitest";

// 攔截檔案寫入，驗證「只有 user() 精選訊息寫入 .log；技術等級(debug/info/warn/error/notice)一律不寫檔」。
const writes = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("node:fs", () => ({
  openSync: vi.fn(() => 5),
  writeSync: vi.fn((_fd: number, s: string) => void writes.lines.push(s)),
  closeSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { createLogger, setLogLevel, initFileLogging } from "../src/logger";

beforeEach(() => {
  writes.lines = [];
});

describe("logger 檔案輸出", () => {
  it("只有 user() 寫入精選檔；debug/info/warn/error/notice 一律不寫檔", () => {
    initFileLogging("/var/log/wms");
    setLogLevel("info"); // curated=true（主控台只留 notice/user）
    const log = createLogger("t");
    log.debug("dee");
    log.info("eye");
    log.warn("dbl");
    log.error("err");
    log.notice("noti");
    expect(writes.lines.length).toBe(0); // 技術等級都不寫檔
    log.user("hello-user");
    expect(writes.lines.join("\n")).toContain("hello-user"); // 只有 user() 寫檔
  });

  it("user 寫檔格式：只有時間＋訊息，不含 scope／等級字樣", () => {
    initFileLogging("/var/log/wms");
    setLogLevel("info");
    createLogger("myscope").user("開機");
    const line = writes.lines.join("\n");
    expect(line).toContain("開機");
    expect(line).not.toContain("myscope"); // 不含 scope
    expect(line).not.toContain("USER"); // 不含等級字樣
  });

  it("logLevel=debug 也不會讓技術等級寫檔（檔案只收 user）", () => {
    initFileLogging("/var/log/wms");
    setLogLevel("debug");
    createLogger("t").debug("verbose-detail");
    expect(writes.lines.length).toBe(0);
  });

  it("即時寫入：每筆 user() 同步對應一次寫檔（無緩衝）", () => {
    initFileLogging("/var/log/wms");
    setLogLevel("info");
    const log = createLogger("t");
    log.user("one");
    expect(writes.lines.length).toBe(1); // 呼叫後立即（同步）就寫好，不需等待
    log.user("two");
    expect(writes.lines.length).toBe(2);
  });

  it("initFileLogging 會建立目錄", async () => {
    const fs = await import("node:fs");
    initFileLogging("/some/new/dir");
    expect(fs.mkdirSync).toHaveBeenCalledWith("/some/new/dir", { recursive: true });
  });
});
