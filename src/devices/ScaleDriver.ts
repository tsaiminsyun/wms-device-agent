// 電子秤驅動（序列，9600 8N1）。
// 認埠：預設限定常見 USB-serial 轉接晶片 VID（CH340/FTDI/CP210x/PL2303），降低誤開其他裝置；
//       可用設定檔 scale.path 強制指定，或把 vendorIds 設成空陣列以接受所有非掃碼槍序列埠。
// 安全升級：開啟後先以中性名「序列裝置（待辨識）」顯示，待資料指紋（ST/US/OL 或 數字+kg/g）命中
//          才升級為「電子秤」並開始送出 weight，避免把非秤裝置誤標成電子秤。
// 去重限流：值在容差內且 stable 未變則略過（桌秤會以同值持續重送）。

import { SerialDeviceDriver, chipText, type SerialPortHandle } from "./serial/SerialDeviceDriver.js";
import { hasScaleSignature, parseScaleLine } from "../parsing/scaleProtocol.js";
import type { SerialPortInfo } from "./serial/serialLoader.js";
import type { DeviceBus } from "../core/DeviceBus.js";
import type { Logger } from "../logger.js";
import type { PortRegistry, SerialDriverOptions } from "./serial/SerialDeviceDriver.js";

const WEIGHT_EPSILON = 0.005; // kg
const NEUTRAL_NAME = "序列裝置（待辨識）";
// 桌秤會持續串流讀數；逾此毫秒數無任何序列資料即視為離線（關機／拔線／線路異常）。
// 取值需大於秤的串流間隔又能及時反映；監看以 serial.pollIntervalMs 為節奏檢查。
const SCALE_LIVENESS_TIMEOUT_MS = 4000;

interface LastEmit {
  kg: number;
  stable: boolean;
}

export class ScaleDriver extends SerialDeviceDriver {
  readonly name = "ScaleDriver";
  protected readonly kind = "scale" as const;
  protected readonly displayName = "電子秤";
  // 啟用斷流監看：秤關機但 USB-serial 晶片仍在（埠不會消失）時，靠此把狀態改為離線（紅）。
  protected override readonly livenessTimeoutMs = SCALE_LIVENESS_TIMEOUT_MS;

  // 每個 uid 的最後送出值（去重用）。
  private readonly lastEmit = new Map<string, LastEmit>();

  constructor(
    bus: DeviceBus,
    log: Logger,
    registry: PortRegistry,
    options: SerialDriverOptions,
    private readonly vendorIds: readonly string[],
    private readonly scannerVendorIds: readonly string[],
  ) {
    super(bus, log, registry, options);
  }

  protected selectPort(_info: SerialPortInfo, vid: string | null): boolean {
    // 永不搶掃碼槍的埠。
    if (vid !== null && this.scannerVendorIds.includes(vid)) return false;
    // vendorIds 為空 → 接受所有非掃碼槍序列埠（仍靠資料指紋確認才會送 weight）。
    if (this.vendorIds.length === 0) return true;
    return vid !== null && this.vendorIds.includes(vid);
  }

  protected override onOpen(h: SerialPortHandle): void {
    // 先中性連線，待指紋命中再升級為電子秤。
    h.pushStatus("connected", `${chipText(h.info)}（等待秤資料…）`, NEUTRAL_NAME);
    this.log.info(`[${h.uid}] 已開啟 ${h.info.path}｜${chipText(h.info) || "無 VID/PID"}（待資料指紋辨識）`);
  }

  protected override onLivenessLost(h: SerialPortHandle): void {
    this.lastEmit.delete(h.uid); // 清去重快取：恢復送電後即使同重量也重新送出
    h.pushStatus("error", "電子秤無資料（可能已關機或線路異常）");
  }

  protected handleLine(line: string, h: SerialPortHandle): void {
    if (!h.isIdentified()) {
      if (!hasScaleSignature(line)) return; // 還沒確認是秤前，只認帶指紋的行
      h.markIdentified();
      h.pushStatus("connected", chipText(h.info)); // 升級顯示為「電子秤」(displayName)
      this.log.info(`[${h.uid}] 資料指紋命中 → 辨識為電子秤`);
    }
    const parsed = parseScaleLine(line);
    if (parsed) this.emitReading(h.uid, parsed.kg, parsed.stable);
  }

  private emitReading(uid: string, kg: number, stable: boolean): void {
    const last = this.lastEmit.get(uid);
    if (last && Math.abs(kg - last.kg) < WEIGHT_EPSILON && last.stable === stable) return;
    this.lastEmit.set(uid, { kg, stable });
    this.bus.emit("weight", {
      deviceId: uid,
      deviceName: this.displayName,
      kg,
      stable,
      kind: "scale",
      ts: Date.now(),
    });
    this.log.debug(`[${uid}] 重量 ${kg.toFixed(3)} kg（stable=${stable}）`);
  }
}
