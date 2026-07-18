import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, enableFileLog, currentLogFile, logFileDir, setLogLevel } from "../src/logger";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wms-log-test-"));
  setLogLevel("info");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const today = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

describe("logger 檔案輸出（每日輪替）", () => {
  it("檔名帶當日日期（wms-agent-YYYY-MM-DD.log），notice 與 warn/error 都寫入", () => {
    enableFileLog(dir);
    const log = createLogger("t");
    log.notice("hello-notice");
    log.warn("hello-warn");
    log.error("hello-error");

    const file = currentLogFile()!;
    expect(file).toContain(`wms-agent-${today()}.log`);
    const content = readFileSync(file, "utf8");
    expect(content).toContain("hello-notice");
    expect(content).toContain("hello-warn");
    expect(content).toContain("hello-error");
  });

  it("精選模式（logLevel=info）下 info 不進主控台，但仍寫入檔案（遠端除錯用）", () => {
    enableFileLog(dir);
    createLogger("t").info("file-only-info");
    expect(readFileSync(currentLogFile()!, "utf8")).toContain("file-only-info");
  });

  it("低於門檻的等級不寫入（logLevel=warn 時 info 被濾掉）", () => {
    enableFileLog(dir);
    setLogLevel("warn");
    const log = createLogger("t");
    log.info("filtered-info");
    log.warn("kept-warn");
    const content = readFileSync(currentLogFile()!, "utf8");
    expect(content).not.toContain("filtered-info");
    expect(content).toContain("kept-warn");
  });

  it("自訂前綴（工作列元件用 wms-agent-tray）", () => {
    enableFileLog(dir, "wms-agent-tray");
    createLogger("t").notice("x");
    expect(currentLogFile()!).toContain(`wms-agent-tray-${today()}.log`);
    expect(logFileDir()).toBe(dir);
  });

  it("啟用時清掉超過保留天數的舊輪替檔，保留新檔", () => {
    const oldFile = join(dir, "wms-agent-2020-01-01.log");
    writeFileSync(oldFile, "old");
    const oldTime = new Date("2020-01-02");
    utimesSync(oldFile, oldTime, oldTime);
    const keepFile = join(dir, "not-a-rolling-log.txt");
    writeFileSync(keepFile, "keep");

    enableFileLog(dir);
    createLogger("t").notice("x");

    const names = readdirSync(dir);
    expect(names).not.toContain("wms-agent-2020-01-01.log");
    expect(names).toContain("not-a-rolling-log.txt");
    expect(names).toContain(`wms-agent-${today()}.log`);
  });

  it("目錄無法建立 → 降級為僅主控台（不丟例外）", () => {
    // 以「已存在的檔案」當目錄路徑，mkdir 必失敗。
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    enableFileLog(join(blocker, "sub"));
    expect(() => createLogger("t").notice("no-crash")).not.toThrow();
    expect(currentLogFile()).toBeNull();
  });
});
