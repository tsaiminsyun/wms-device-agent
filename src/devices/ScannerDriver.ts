// CDC（虛擬 COM）模式掃碼槍驅動：一行即一條 barcode，依 Zebra/Symbol VID 認埠。
// 掃碼槍須先切至 CDC 模式（見 README）。

import { SerialDeviceDriver, type SerialPortHandle } from "./serial/SerialDeviceDriver.js";
import { ScanEmitter } from "./scanDedup.js";
import type { SerialPortInfo } from "./serial/serialLoader.js";
import type { DeviceBus } from "../core/DeviceBus.js";
import type { Logger } from "../logger.js";
import type { PortRegistry, SerialDriverOptions } from "./serial/SerialDeviceDriver.js";

export class ScannerDriver extends SerialDeviceDriver {
  readonly name = "ScannerDriver(Zebra CDC)";
  protected readonly kind = "scanner" as const;
  protected readonly displayName = "掃碼槍";
  private readonly scan: ScanEmitter;

  constructor(
    bus: DeviceBus,
    log: Logger,
    registry: PortRegistry,
    options: SerialDriverOptions,
    private readonly vendorIds: readonly string[],
    dedupWindowMs: number,
  ) {
    super(bus, log, registry, options);
    this.scan = new ScanEmitter(bus, this.log, this.displayName, dedupWindowMs);
  }

  protected selectPort(_info: SerialPortInfo, vid: string | null): boolean {
    return vid !== null && this.vendorIds.includes(vid);
  }

  protected override onOpen(h: SerialPortHandle): void {
    super.onOpen(h); // 內部狀態回報＋（debug）詳細 log
    // 使用者面：掃碼槍已連線（COM 埠等技術細節只進完整技術檔）。
    this.log.user("掃碼槍已連線");
  }

  protected handleLine(line: string, h: SerialPortHandle): void {
    const barcode = line.trim();
    if (barcode) this.scan.emit(h.uid, barcode);
  }
}
