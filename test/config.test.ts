import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../src/config";

describe("ConfigSchema", () => {
  it("空輸入即產生完整預設值（子物件缺席不應報 Required）", () => {
    const c = ConfigSchema.parse({});
    expect(c.server.host).toBe("127.0.0.1");
    expect(c.server.port).toBe(8788);
    expect(c.server.wsPath).toBe("/ws");
    expect(c.security.allowNoOrigin).toBe(true);
    expect(c.scanner.vendorIds).toEqual(["05e0"]);
    expect(c.scale.vendorIds).toEqual(["1a86", "0403", "10c4", "067b"]);
    expect(c.scanner.keyboardFallback).toBe(true);
    expect(c.logLevel).toBe("info");
  });

  it("vendorId 正規化為小寫 4 碼 hex", () => {
    const c = ConfigSchema.parse({ scanner: { vendorIds: ["5E0", "0x1A86"] } });
    expect(c.scanner.vendorIds).toEqual(["05e0", "1a86"]);
  });

  it("hidScanner.usagePages 預設為空（接受任何非鍵盤 collection）", () => {
    expect(ConfigSchema.parse({}).hidScanner.usagePages).toEqual([]);
  });

  it("hidScanner.usagePages 接受數字與 0x hex 字串", () => {
    const c = ConfigSchema.parse({ hidScanner: { usagePages: ["0x8c", 12] } });
    expect(c.hidScanner.usagePages).toEqual([0x8c, 12]);
  });

  it("部分覆寫保留其餘預設", () => {
    const c = ConfigSchema.parse({ server: { port: 9000 } });
    expect(c.server.port).toBe(9000);
    expect(c.server.host).toBe("127.0.0.1");
  });
});
