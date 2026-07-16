// 電子秤驅動：依 USB-serial 晶片 VID 認埠，資料指紋命中才升級為「電子秤」並送 weight；
// 值在容差內且 stable 未變則去重。

import { SerialDeviceDriver, chipText, type SerialPortHandle } from "./serial/SerialDeviceDriver.js";
import { hasScaleSignature, parseScaleLine } from "../parsing/scaleProtocol.js";
import type { SerialPortInfo } from "./serial/serialLoader.js";
import type { DeviceBus } from "../core/DeviceBus.js";
import type { Logger } from "../logger.js";
import type { PortRegistry, SerialDriverOptions } from "./serial/SerialDeviceDriver.js";

const WEIGHT_EPSILON = 0.005; // kg
const NEUTRAL_NAME = "序列裝置（待辨識）";
// 逾此毫秒無資料視為離線（秤會持續串流讀數）。
const SCALE_LIVENESS_TIMEOUT_MS = 4000;
// 斷流逾此毫秒則關閉重開埠（軟體重插）。
const SCALE_LIVENESS_RECOVERY_MS = 15_000;

interface LastEmit {
  kg: number;
  stable: boolean;
}

export class ScaleDriver extends SerialDeviceDriver {
  readonly name = "ScaleDriver";
  protected readonly kind = "scale" as const;
  protected readonly displayName = "電子秤";
  protected override readonly livenessTimeoutMs = SCALE_LIVENESS_TIMEOUT_MS;
  protected override readonly livenessRecoveryMs = SCALE_LIVENESS_RECOVERY_MS;
  // hupcl=false：本秤把 DTR 落下邊緣當休眠且需重新上電才醒，開關埠不得動 DTR。
  protected override readonly hupcl = false;

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
    // vendorIds 為空 → 接受所有非掃碼槍序列埠（靠指紋把關）。
    if (this.vendorIds.length === 0) return true;
    return vid !== null && this.vendorIds.includes(vid);
  }

  protected override onOpen(h: SerialPortHandle): void {
    // 先中性顯示，待指紋命中再升級。
    h.pushStatus("connected", `${chipText(h.info)}（等待秤資料…）`, NEUTRAL_NAME);
    this.log.info(`[${h.uid}] 已開啟 ${h.info.path}｜${chipText(h.info) || "無 VID/PID"}（待資料指紋辨識）`);
  }

  protected override onLivenessLost(h: SerialPortHandle): void {
    this.lastEmit.delete(h.uid); // 清去重快取：恢復後同重量也重新送出
    h.pushStatus("error", "電子秤無資料（可能已關機或線路異常）");
  }

  protected handleLine(line: string, h: SerialPortHandle): void {
    if (!h.isIdentified()) {
      if (!hasScaleSignature(line)) return; // 未確認是秤前只認帶指紋的行
      h.markIdentified();
      h.pushStatus("connected", chipText(h.info)); // 升級為「電子秤」
      this.log.info(`[${h.uid}] 資料指紋命中 → 辨識為電子秤`);
      // 精選事件②：裝置初始化（電子秤）。
      this.log.notice(`電子秤已初始化：${h.info.path}`);
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
