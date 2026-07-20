import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 換掉 loadSerialPort（不載入真的 serialport 原生模組），其餘（normalizeHexId 等）用原實作。
const fake = vi.hoisted(() => ({
  ops: [] as string[],
  ports: [] as unknown[],
  list: [{ path: "COM9", vendorId: "1a86", productId: "7523", pnpId: "USB\\VID_1A86&PID_7523\\5&1" }],
}));
vi.mock("../src/devices/serial/serialLoader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/devices/serial/serialLoader")>();
  class FakePort {
    isOpen = true;
    constructor(public readonly opts: unknown) {
      fake.ports.push(this);
    }
    on(): void {}
    removeAllListeners(): void {}
    flush(cb?: (err?: Error | null) => void): void {
      fake.ops.push("flush");
      cb?.(null);
    }
    close(cb?: (err?: Error | null) => void): void {
      fake.ops.push("close");
      this.isOpen = false;
      cb?.(null);
    }
    static list = async (): Promise<unknown[]> => fake.list;
  }
  return { ...actual, loadSerialPort: async () => FakePort };
});

import { SerialDeviceDriver, PortRegistry, openFailureHint, type SerialPortHandle } from "../src/devices/serial/SerialDeviceDriver";
import { RetryCooldown } from "../src/devices/hotplug";
import { DeviceBus } from "../src/core/DeviceBus";
import type { SerialPortInfo } from "../src/devices/serial/serialLoader";
import type { Logger } from "../src/logger";

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  notice: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;
(log.child as ReturnType<typeof vi.fn>).mockReturnValue(log);

class TestDriver extends SerialDeviceDriver {
  readonly name = "TestDriver";
  protected readonly kind = "scale" as const;
  protected readonly displayName = "測試裝置";
  protected selectPort(_info: SerialPortInfo): boolean {
    return true;
  }
  protected handleLine(_line: string, _h: SerialPortHandle): void {}
}

describe("SerialDeviceDriver 關閉流程", () => {
  beforeEach(() => {
    fake.ops = [];
    fake.ports = [];
  });

  it("stop() 先 flush（中止未完成 I/O）再 close，確保埠乾淨釋放", async () => {
    const driver = new TestDriver(new DeviceBus(), log, new PortRegistry(), {
      baudRate: 9600,
      forcedPath: null,
      pollIntervalMs: 60_000,
    });
    await driver.start(); // 首次輪詢即 attach COM9
    expect(fake.ports).toHaveLength(1);
    await driver.stop();
    expect(fake.ops).toEqual(["flush", "close"]);
  });
});

describe("RetryCooldown 首次快重試", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("第一次失敗用短冷卻，連續失敗退回長冷卻", () => {
    const rc = new RetryCooldown(5000, 1000);
    expect(rc.schedule("COM4")).toBe(1000);
    expect(rc.isCoolingDown("COM4")).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(rc.isCoolingDown("COM4")).toBe(false);
    expect(rc.schedule("COM4")).toBe(5000);
  });

  it("clear／prune（裝置消失）後重新從短冷卻開始", () => {
    const rc = new RetryCooldown(5000, 1000);
    rc.schedule("COM4");
    rc.schedule("COM4");
    rc.clear("COM4");
    expect(rc.schedule("COM4")).toBe(1000);
    rc.schedule("COM4");
    rc.prune(new Set());
    expect(rc.schedule("COM4")).toBe(1000);
  });

  it("未指定短冷卻時行為不變（固定冷卻）", () => {
    const rc = new RetryCooldown(5000);
    expect(rc.schedule("COM4")).toBe(5000);
  });
});

describe("openFailureHint 錯誤分類", () => {
  it("SetCommState（error 31）→ 驅動卡死", () => {
    expect(openFailureHint("Open (SetCommState): Unknown error code 31")).toContain("驅動未回應");
  });
  it("Access denied / Cannot lock → 埠被占用", () => {
    expect(openFailureHint("Opening COM4: Access denied")).toContain("佔用");
    expect(openFailureHint("Cannot lock port")).toContain("佔用");
  });
  it("File not found → 裝置不存在", () => {
    expect(openFailureHint("Opening COM4: File not found")).toContain("裝置不存在");
  });
  it("其他 → 通用提示", () => {
    expect(openFailureHint("Something weird")).toContain("常見原因");
  });
});
