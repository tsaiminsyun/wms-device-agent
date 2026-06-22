import { describe, it, expect, vi } from "vitest";
import { DeviceBus } from "../src/core/DeviceBus";
import { TrafficCop } from "../src/TrafficCop";
import type { KeyboardEmulator } from "../src/keyboard/KeyboardEmulator";
import type { ScanEvent } from "../src/core/types";

function fakeKeyboard(enabled: boolean): { kb: KeyboardEmulator; typeBarcode: ReturnType<typeof vi.fn> } {
  const typeBarcode = vi.fn();
  const kb = { get enabled() { return enabled; }, typeBarcode } as unknown as KeyboardEmulator;
  return { kb, typeBarcode };
}

function scan(barcode: string): ScanEvent {
  return { deviceId: "scanner-1", deviceName: "掃碼槍", barcode, kind: "scanner", ts: 1 };
}

describe("TrafficCop（交警模式仲裁，焦點認領）", () => {
  it("有焦點認領的 WMS 頁面 → 走 WS，不打鍵盤", () => {
    const bus = new DeviceBus();
    const { kb, typeBarcode } = fakeKeyboard(true);
    const routeScanToWs = vi.fn(() => 1); // 成功送達 1 個認領者
    new TrafficCop(bus, mutedLog(), kb, () => true, routeScanToWs, { keyboardFallback: true }).start();

    bus.emit("scan", scan("ABC"));
    expect(routeScanToWs).toHaveBeenCalledTimes(1);
    expect(typeBarcode).not.toHaveBeenCalled();
  });

  it("無認領（操作員在其他 app）→ 走鍵盤模擬", () => {
    const bus = new DeviceBus();
    const { kb, typeBarcode } = fakeKeyboard(true);
    const routeScanToWs = vi.fn(() => 0);
    new TrafficCop(bus, mutedLog(), kb, () => false, routeScanToWs, { keyboardFallback: true }).start();

    bus.emit("scan", scan("ABC"));
    expect(routeScanToWs).not.toHaveBeenCalled();
    expect(typeBarcode).toHaveBeenCalledWith("ABC");
  });

  it("認領在送出瞬間失效（routeScanToWs 回 0）→ 退回鍵盤", () => {
    const bus = new DeviceBus();
    const { kb, typeBarcode } = fakeKeyboard(true);
    const routeScanToWs = vi.fn(() => 0); // 認領剛好失效，沒送出
    new TrafficCop(bus, mutedLog(), kb, () => true, routeScanToWs, { keyboardFallback: true }).start();

    bus.emit("scan", scan("ABC"));
    expect(routeScanToWs).toHaveBeenCalledTimes(1);
    expect(typeBarcode).toHaveBeenCalledWith("ABC");
  });

  it("無認領 + keyboardFallback=false → 不打字也不走 WS（丟棄）", () => {
    const bus = new DeviceBus();
    const { kb, typeBarcode } = fakeKeyboard(true);
    const routeScanToWs = vi.fn(() => 0);
    new TrafficCop(bus, mutedLog(), kb, () => false, routeScanToWs, { keyboardFallback: false }).start();

    bus.emit("scan", scan("ABC"));
    expect(typeBarcode).not.toHaveBeenCalled();
  });

  it("stop() 後不再處理掃碼", () => {
    const bus = new DeviceBus();
    const { kb, typeBarcode } = fakeKeyboard(true);
    const routeScanToWs = vi.fn(() => 0);
    const cop = new TrafficCop(bus, mutedLog(), kb, () => false, routeScanToWs, { keyboardFallback: true });
    cop.start();
    cop.stop();
    bus.emit("scan", scan("ABC"));
    expect(typeBarcode).not.toHaveBeenCalled();
  });
});

function mutedLog() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => mutedLog() } as never;
}
