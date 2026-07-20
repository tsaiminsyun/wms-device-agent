import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getRunMode, hasCliFlag } from "../src/runtime/runMode";

let origArgv: string[];

beforeEach(() => {
  origArgv = process.argv;
  delete process.env.WMS_RUN_MODE;
});
afterEach(() => {
  process.argv = origArgv;
  delete process.env.WMS_RUN_MODE;
});

describe("getRunMode", () => {
  it("預設為 default", () => {
    process.argv = ["node", "index.js"];
    expect(getRunMode()).toBe("default");
  });

  it("WMS_RUN_MODE=service（NSSM 服務環境變數）→ service", () => {
    process.argv = ["node", "index.js"];
    process.env.WMS_RUN_MODE = "service";
    expect(getRunMode()).toBe("service");
  });

  it("--tray 旗標 → tray；--service 旗標 → service", () => {
    process.argv = ["node", "index.js", "--tray"];
    expect(getRunMode()).toBe("tray");
    process.argv = ["node", "index.js", "--service"];
    expect(getRunMode()).toBe("service");
  });

  it("service 優先於 tray（環境變數與旗標混用時不歧義）", () => {
    process.argv = ["node", "index.js", "--tray"];
    process.env.WMS_RUN_MODE = "service";
    expect(getRunMode()).toBe("service");
  });

  it("hasCliFlag 掃描 argv（含 SEA 情境的多引數）", () => {
    process.argv = ["C:\\app\\wms.exe", "C:\\app\\wms.exe", "--harmony", "--install-service"];
    expect(hasCliFlag("--install-service")).toBe(true);
    expect(hasCliFlag("--uninstall-service")).toBe(false);
  });
});
