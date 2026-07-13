// HID 掃碼槍驅動（node-hid）：讀取 HID-POS / IBM 模式掃碼槍的 input report → emit scan。
// 與序列掃碼槍（ScannerDriver）輸出相同的 'scan' 事件，流進同一套 DeviceBus → 交警/focus-claim 管線。
//
// 前置：掃碼槍需設為 HID-POS / IBM Hand-held 模式（usage page 0x8C）。
//   - 純 HID 鍵盤（keyboard wedge）模式無法被讀取（OS 會保護鍵盤 collection，尤其 Windows）。
//   - CDC 模式請改用 ScannerDriver（serialport）。
//
// 偵測：定時輪詢 node-hid devices()，依 vendorId + usagePage 選裝置；新出現即開啟、消失即移除。
// 開啟失敗（例：被佔用 / 權限不足）→ 釋放並於冷卻後重試，不卡死。
// 每筆原始 report 以 hex/ascii 印在 debug log，接新機型時據此校準 reportHeaderBytes。

import { parseHidPosReport } from "../parsing/hidPosReport.js";
import { PollLoop, RetryCooldown, OPEN_RETRY_COOLDOWN_MS } from "./hotplug.js";
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

  // 判斷某個 HID collection 該不該開。ours=是否本廠牌（用於是否印提示）；skipReason=本廠牌但不開的原因。
  private evaluate(info: HidDeviceInfo): { open: boolean; ours: boolean; skipReason?: string } {
    if (!this.opts.vendorIds.includes(hex4(info.vendorId))) return { open: false, ours: false };

    // 鍵盤(0x1/0x6)、滑鼠(0x1/0x2)：OS 保護、node 讀不到（且送的是 scancode 非 HID-POS），一律排除。
    if (info.usagePage === 0x01 && (info.usage === 0x06 || info.usage === 0x02)) {
      const what = info.usage === 0x06 ? "鍵盤" : "滑鼠";
      return {
        open: false,
        ours: true,
        skipReason: `目前是${what}模式（usagePage=0x1, usage=0x${info.usage.toString(16)}），node 無法讀取。請將掃碼槍切為 HID-POS / IBM Hand-Held（usage page 0x8c）或 CDC 模式`,
      };
    }

    // usagePages 有設才過濾；空＝接受任何非鍵盤/滑鼠 collection（比照瀏覽器只用 vendorId 過濾）。
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
          // 偵測到本廠牌掃碼槍但不能讀 → 印一次原因與解法，方便從 log 直接看懂。
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

    device.on("data", (data: Buffer) => this.onReport(entry, data));
    device.on("error", (err: Error) => {
      this.log.warn(`[${uid}] HID 錯誤：${err.message}`);
      this.detach(path, entry, `錯誤：${err.message}`);
      // 讓輪詢稍後重試（例如暫時性錯誤）。
      this.retry.schedule(path);
    });
  }

  private onReport(entry: OpenEntry, data: Buffer): void {
    // 原始 report 印出（debug），接新機型時據此校準 reportHeaderBytes。
    const hex = [...data].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...data].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    this.log.debug(`[${entry.uid}] report len=${data.length} hex=[${hex}] ascii="${ascii}"`);

    for (const barcode of parseHidPosReport(data, this.opts.reportHeaderBytes)) {
      this.log.info(`[${entry.uid}] 掃碼：${barcode}（${barcode.length} 字）`);
      this.bus.emit("scan", {
        deviceId: entry.uid,
        deviceName: this.displayName,
        barcode,
        kind: "scanner",
        ts: Date.now(),
      });
    }
  }

  private detach(path: string, entry: OpenEntry, reason: string): void {
    if (!this.open.has(path)) return;
    this.open.delete(path);
    this.closeEntry(entry, reason);
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
