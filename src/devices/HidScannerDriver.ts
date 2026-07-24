// HID-POS / IBM 模式掃碼槍驅動（node-hid）：輪詢 devices() 熱插拔，解析 input report → emit scan。
// 鍵盤（keyboard wedge）模式受 OS 保護無法讀取；CDC 模式請用 ScannerDriver。

import { parseHidPosReport } from "../parsing/hidPosReport.js";
import { PollLoop, RetryCooldown, OPEN_RETRY_COOLDOWN_MS } from "./hotplug.js";
import { ScanEmitter } from "./scanDedup.js";
import { loadNodeHid, hex4, type HidDeviceInfo, type HidDeviceInstance, type HidModule } from "./hid/hidLoader.js";
import type { DeviceBus } from "../core/DeviceBus.js";
import type { DeviceDriver } from "../core/DeviceManager.js";
import type { DeviceStatus } from "../core/types.js";
import type { Logger } from "../logger.js";

export interface HidScannerOptions {
  vendorIds: readonly string[];
  /** 允許的 usage page（如 0x8c 條碼掃描器）；空陣列＝不以 usagePage 過濾（盡力而為）。 */
  usagePages: readonly number[];
  /** 解析 input report 時跳過的表頭位元組數（依機型可能需微調）。 */
  reportHeaderBytes: number;
  /** 連續重讀同一條碼的抑制窗（毫秒）；0=關閉。 */
  dedupWindowMs: number;
  pollIntervalMs: number;
}

interface OpenEntry {
  uid: string;
  device: HidDeviceInstance;
}

export class HidScannerDriver implements DeviceDriver {
  readonly name = "HidScannerDriver(node-hid)";
  private readonly kind = "scanner" as const;
  private readonly displayName = "掃碼槍(HID)";

  private readonly open = new Map<string, OpenEntry>(); // path → entry
  private readonly retry = new RetryCooldown(OPEN_RETRY_COOLDOWN_MS);
  private readonly scan: ScanEmitter;
  private readonly hinted = new Set<string>(); // 已印過「為何略過」提示的 path，避免洗 log
  private HID: HidModule | null = null;
  private loop: PollLoop | null = null;
  private counter = 0;
  private readonly log: Logger;

  constructor(
    private readonly bus: DeviceBus,
    parentLog: Logger,
    private readonly opts: HidScannerOptions,
  ) {
    this.log = parentLog.child("HidScannerDriver");
    this.scan = new ScanEmitter(bus, this.log, this.displayName, opts.dedupWindowMs);
  }

  async start(): Promise<void> {
    this.HID = await loadNodeHid((m, e) => this.log.warn(m, e));
    if (!this.HID) {
      this.log.warn("HID 掃碼槍驅動未啟用（node-hid 不可用）。");
      return;
    }
    this.loop = new PollLoop(this.opts.pollIntervalMs, () => this.poll());
    await this.loop.start();
  }

  async stop(): Promise<void> {
    this.loop?.stop();
    this.loop = null;
    for (const entry of this.open.values()) this.closeEntry(entry, "關閉");
    this.open.clear();
    this.retry.reset();
    this.hinted.clear();
  }

  // 判斷某 HID collection 該不該開；ours=本廠牌（決定是否印提示）。
  private evaluate(info: HidDeviceInfo): { open: boolean; ours: boolean; skipReason?: string } {
    if (!this.opts.vendorIds.includes(hex4(info.vendorId))) return { open: false, ours: false };

    // 鍵盤/滑鼠 collection：OS 保護、node 讀不到，一律排除。
    if (info.usagePage === 0x01 && (info.usage === 0x06 || info.usage === 0x02)) {
      const what = info.usage === 0x06 ? "鍵盤" : "滑鼠";
      return {
        open: false,
        ours: true,
        skipReason: `目前是${what}模式（usagePage=0x1, usage=0x${info.usage.toString(16)}），node 無法讀取。請將掃碼槍切為 HID-POS / IBM Hand-Held（usage page 0x8c）或 CDC 模式`,
      };
    }

    // usagePages 有設才過濾；空＝只用 vendorId。
    if (this.opts.usagePages.length > 0 && typeof info.usagePage === "number" && info.usagePage > 0) {
      if (!this.opts.usagePages.includes(info.usagePage)) {
        const allow = this.opts.usagePages.map((u) => "0x" + u.toString(16)).join(",");
        return { open: false, ours: true, skipReason: `usagePage=0x${info.usagePage.toString(16)} 不在允許清單 [${allow}]` };
      }
    }
    return { open: true, ours: true };
  }

  private poll(): void {
    if (!this.HID) return;
    try {
      const list = this.HID.devices().filter((d) => typeof d.path === "string" && d.path.length > 0);
      const seen = new Set(list.map((d) => d.path as string));

      // 移除：已開啟但清單裡不見了。
      for (const [path, entry] of this.open) {
        if (!seen.has(path)) this.detach(path, entry, "拔除");
      }
      this.retry.prune(seen);
      for (const path of this.hinted) {
        if (!seen.has(path)) this.hinted.delete(path);
      }

      // 新增：符合條件、尚未開啟、不在冷卻中。
      for (const info of list) {
        const path = info.path as string;
        if (this.open.has(path)) continue;
        const { open, ours, skipReason } = this.evaluate(info);
        if (open) {
          if (this.retry.isCoolingDown(path)) continue;
          this.attach(path, info);
        } else if (ours && skipReason && !this.hinted.has(path)) {
          // 本廠牌但不能讀 → 印一次原因。
          this.hinted.add(path);
          this.log.warn(`偵測到掃碼槍 ${hex4(info.vendorId)}:${hex4(info.productId)}（${info.product || "?"}）但未接管：${skipReason}`);
        }
      }
    } catch (err) {
      this.log.warn("列舉 HID 裝置失敗：", err);
    }
  }

  private attach(path: string, info: HidDeviceInfo): void {
    if (!this.HID) return;
    const uid = `scanner-hid-${++this.counter}`;
    const productName = info.product || `型號 0x${hex4(info.productId)}`;
    this.pushStatus(uid, "connecting", `連線中… ${productName}`);

    let device: HidDeviceInstance;
    try {
      device = new this.HID.HID(path);
    } catch (err) {
      this.log.warn(
        `開啟 HID 掃碼槍失敗：${(err as Error).message}（${this.retry.cooldownMs / 1000}s 後重試；純鍵盤模式無法開啟，請設 HID-POS 模式）`,
      );
      this.retry.schedule(path);
      this.pushStatus(uid, "error", `開啟失敗：${(err as Error).message}`);
      return;
    }

    const entry: OpenEntry = { uid, device };
    this.open.set(path, entry);
    this.retry.clear(path);

    const idText = `${hex4(info.vendorId)}:${hex4(info.productId)}`;
    const up = typeof info.usagePage === "number" ? `0x${info.usagePage.toString(16)}` : "?";
    this.pushStatus(uid, "connected", `${productName} (${idText}) usagePage=${up}`);
    this.log.info(`[${uid}] 已連線 HID 掃碼槍｜${productName}｜${idText}｜usagePage=${up}`);
    // 使用者面：掃碼槍已連線（型號／ID 等技術細節只進完整技術檔，見上一行 info）。
    this.log.user("掃碼槍已連線");

    device.on("data", (data: Buffer) => this.onReport(entry, data));
    device.on("error", (err: Error) => {
      this.log.warn(`[${uid}] HID 錯誤：${err.message}`);
      this.detach(path, entry, `錯誤：${err.message}`);
      // 冷卻後由輪詢重試。
      this.retry.schedule(path);
    });
  }

  private onReport(entry: OpenEntry, data: Buffer): void {
    // data 事件由 node-hid 原生層觸發；此處若拋錯會變未捕捉例外，故整段包起來、單筆失敗不影響裝置續讀。
    try {
      // 原始 report 印在 debug log，供校準 reportHeaderBytes。
      const hex = [...data].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const ascii = [...data].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
      this.log.debug(`[${entry.uid}] report len=${data.length} hex=[${hex}] ascii="${ascii}"`);

      for (const barcode of parseHidPosReport(data, this.opts.reportHeaderBytes)) {
        this.scan.emit(entry.uid, barcode);
      }
    } catch (err) {
      this.log.warn(`[${entry.uid}] 解析 report 失敗（略過本筆）：`, err);
    }
  }

  private detach(path: string, entry: OpenEntry, reason: string): void {
    if (!this.open.has(path)) return;
    this.open.delete(path);
    this.scan.forget(entry.uid);
    this.closeEntry(entry, reason);
    // 使用者面：裝置移除／連線中斷 → 報「已斷線」。HID 只在實體拔除（"拔除"）或連線錯誤（"錯誤…"）時
    // 呼叫 detach，兩者皆為「已連上的裝置離線」（開啟失敗不會進到這裡），故都算斷線。
    if (reason === "拔除" || reason.startsWith("錯誤")) this.log.user("掃碼槍已斷線");
    this.pushStatus(entry.uid, "removed", "");
  }

  private closeEntry(entry: OpenEntry, reason: string): void {
    try {
      entry.device.removeAllListeners("data");
      entry.device.removeAllListeners("error");
      entry.device.close();
    } catch {
      /* ignore */
    }
    this.log.info(`[${entry.uid}] 移除（${reason}）`);
  }

  private pushStatus(uid: string, status: DeviceStatus, detail: string): void {
    this.bus.emit("device-status", {
      deviceId: uid,
      deviceName: this.displayName,
      kind: this.kind,
      status,
      detail,
      ts: Date.now(),
    });
  }
}
