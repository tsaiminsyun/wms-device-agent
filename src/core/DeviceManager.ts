// 驅動生命週期管理＋裝置狀態快照（供 /devices 與 WS welcome）。

import type { DeviceBus } from "./DeviceBus.js";
import type { DeviceSnapshot, DeviceStatusEvent } from "./types.js";
import type { Logger } from "../logger.js";

// 裝置驅動共同介面；一個 Driver 可管理 0..N 個實體裝置。
export interface DeviceDriver {
  /** log 用。 */
  readonly name: string;
  start(): Promise<void>;
  /** 停止並釋放資源（序列埠、計時器等）。 */
  stop(): Promise<void>;
}

export class DeviceManager {
  private readonly drivers: DeviceDriver[] = [];
  private readonly snapshots = new Map<string, DeviceSnapshot>();
  // 已對此裝置發過使用者面錯誤訊息（連上或移除才清除），避免每次重試輪詢重複洗版。
  private readonly errorNotified = new Set<string>();
  private started = false;
  private readonly statusListener: (e: DeviceStatusEvent) => void;

  constructor(
    private readonly bus: DeviceBus,
    private readonly log: Logger,
  ) {
    this.statusListener = (e) => this.onStatus(e);
    this.bus.on("device-status", this.statusListener);
  }

  register(driver: DeviceDriver): void {
    this.drivers.push(driver);
  }

  private onStatus(e: DeviceStatusEvent): void {
    if (e.status === "removed") {
      this.snapshots.delete(e.deviceId);
      this.errorNotified.delete(e.deviceId);
    } else {
      this.snapshots.set(e.deviceId, {
        deviceId: e.deviceId,
        deviceName: e.deviceName,
        kind: e.kind,
        status: e.status,
        detail: e.detail,
        since: e.ts,
      });
      if (e.status === "error") {
        // 使用者面：只指出是「電子秤」還是「掃碼槍」出問題，不含錯誤碼／型號／技術細節；
        // 每個失敗週期只提示一次（連上後才會再次提示），完整細節仍記在技術檔（見 debug 那行）。
        if (!this.errorNotified.has(e.deviceId)) {
          this.errorNotified.add(e.deviceId);
          const label = e.label ?? (e.kind === "scale" ? "電子秤" : "掃碼槍");
          this.log.user(`${label}發生錯誤`);
        }
      } else if (e.status === "connected") {
        this.errorNotified.delete(e.deviceId); // 恢復連線 → 下次再出錯可再提示（「已連線」由驅動印出）
      }
    }
    this.log.debug(`狀態更新 ${e.deviceId} → ${e.status}（${e.deviceName}）${e.detail ? ` | ${e.detail}` : ""}`);
  }

  /** 已知裝置的狀態快照（不含已移除者）。 */
  snapshot(): DeviceSnapshot[] {
    return [...this.snapshots.values()].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /** connected 狀態的裝置數。 */
  connectedCount(): number {
    let n = 0;
    for (const s of this.snapshots.values()) if (s.status === "connected") n++;
    return n;
  }

  async startAll(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const d of this.drivers) {
      try {
        await d.start();
        this.log.info(`驅動已啟動：${d.name}`);
      } catch (err) {
        this.log.error(`驅動啟動失敗：${d.name}`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await Promise.allSettled(this.drivers.map((d) => d.stop()));
    this.snapshots.clear();
    this.bus.off("device-status", this.statusListener);
  }
}
