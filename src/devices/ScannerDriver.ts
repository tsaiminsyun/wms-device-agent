// 掃碼槍驅動（Zebra LS4278，CDC 模式 = 虛擬 COM 埠）。
// 前置：須先把掃碼槍由 HID 模式切到 CDC（USB-COM）模式（見 README 設定條碼）。
// CDC 模式下每次掃碼以 CR/LF 結尾送出一整條條碼 → 一行即一條 barcode。
// 依 Zebra/Symbol VID（預設 05e0）認埠；可用設定檔 scanner.path 強制指定。

import { SerialDeviceDriver, type SerialPortHandle } from "./serial/SerialDeviceDriver.js";
import { ScanDebouncer } from "./scanDedup.js";
import type { SerialPortInfo } from "./serial/serialLoader.js";
import type { DeviceBus } from "../core/DeviceBus.js";
import type { Logger } from "../logger.js";
import type { PortRegistry, SerialDriverOptions } from "./serial/SerialDeviceDriver.js";

export class ScannerDriver extends SerialDeviceDriver {
  readonly name = "ScannerDriver(Zebra CDC)";
  protected readonly kind = "scanner" as const;
  protected readonly displayName = "掃碼槍";
  private readonly dedup: ScanDebouncer;

  constructor(
    bus: DeviceBus,
    log: Logger,
    registry: PortRegistry,
    options: SerialDriverOptions,
    private readonly vendorIds: readonly string[],
    dedupWindowMs: number,
  ) {
    super(bus, log, registry, options);
    this.dedup = new ScanDebouncer(dedupWindowMs);
  }

  protected selectPort(_info: SerialPortInfo, vid: string | null): boolean {
    return vid !== null && this.vendorIds.includes(vid);
  }

  protected handleLine(line: string, h: SerialPortHandle): void {
    const barcode = line.trim();
    if (!barcode) return;
    if (!this.dedup.accept(h.uid, barcode)) {
      this.log.debug(`[${h.uid}] 連續重讀，抑制：${barcode}`);
      return;
    }
    this.log.info(`[${h.uid}] 掃碼：${barcode}（${barcode.length} 字）`);
    this.bus.emit("scan", {
      deviceId: h.uid,
      deviceName: this.displayName,
      barcode,
      kind: "scanner",
      ts: Date.now(),
    });
  }
}
