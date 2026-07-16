// 序列驅動底座：輪詢 SerialPort.list() 做埠探索/熱插拔/開關/分行（只讀不寫）；
// 子類別實作 selectPort()（哪些埠是我的）與 handleLine()（一行怎麼處理）。

import { LineFramer } from "../../parsing/LineFramer.js";
import { OPEN_RETRY_COOLDOWN_MS, PollLoop, RetryCooldown } from "../hotplug.js";
import type { DeviceBus } from "../../core/DeviceBus.js";
import type { DeviceDriver } from "../../core/DeviceManager.js";
import type { DeviceKind, DeviceStatus } from "../../core/types.js";
import type { Logger } from "../../logger.js";
import {
  loadSerialPort,
  normalizeHexId,
  type SerialPortCtor,
  type SerialPortInfo,
  type SerialPortInstance,
} from "./serialLoader.js";

// 斷流自動重連的最小間隔（節流）。
const REOPEN_MIN_INTERVAL_MS = 60_000;

// 連續開埠失敗達此次數 → 提示重插 USB（埠在清單卻開不起，多為控制代碼未釋放／CH340 卡死，軟體救不回）。
const WARN_REPLUG_AFTER_FAILURES = 3;

// 等待原生 close() 回呼的上限；Windows 上裝置已拔或有未完成 I/O 時回呼可能永不觸發，逾時即放手（OS 於行程結束釋放）。
const CLOSE_TIMEOUT_MS = 800;

// 跨驅動共享：避免兩個驅動同時搶開同一個實體埠。
export class PortRegistry {
  private readonly claimed = new Set<string>();
  claim(path: string): boolean {
    if (this.claimed.has(path)) return false;
    this.claimed.add(path);
    return true;
  }
  release(path: string): void {
    this.claimed.delete(path);
  }
  isClaimed(path: string): boolean {
    return this.claimed.has(path);
  }
}

// 子類別與底座互動的唯一把手（一個實體埠對應一個 handle）。
export interface SerialPortHandle {
  readonly uid: string;
  readonly info: SerialPortInfo;
  isIdentified(): boolean;
  markIdentified(): void;
  pushStatus(status: DeviceStatus, detail: string, nameOverride?: string): void;
}

interface OpenEntry {
  port: SerialPortInstance;
  framer: LineFramer;
  handle: SerialPortHandle;
  identified: boolean;
  closing: boolean;
  /** 最近收到資料的時間（斷流監看用）。 */
  lastDataAt: number;
  /** 已因斷流標記為離線。 */
  stale: boolean;
}

export interface SerialDriverOptions {
  baudRate: number;
  /** 明確指定的埠路徑（設定檔 path）；非 null 時只接這個埠。 */
  forcedPath: string | null;
  pollIntervalMs: number;
}

export abstract class SerialDeviceDriver implements DeviceDriver {
  abstract readonly name: string;
  protected abstract readonly kind: DeviceKind;
  protected abstract readonly displayName: string;

  private readonly open = new Map<string, OpenEntry>(); // path → entry
  private readonly retry = new RetryCooldown(OPEN_RETRY_COOLDOWN_MS);
  private readonly reopenThrottle = new RetryCooldown(REOPEN_MIN_INTERVAL_MS); // 斷流自動重連節流
  private loop: PollLoop | null = null;
  private SerialPort: SerialPortCtor | null = null;
  private counter = 0;
  // 連續開埠失敗計數（path → 次數）與已提示重插的 path（避免洗訊息）。
  private readonly openFailures = new Map<string, number>();
  private readonly replugWarned = new Set<string>();

  protected readonly log: Logger;

  constructor(
    protected readonly bus: DeviceBus,
    parentLog: Logger,
    private readonly registry: PortRegistry,
    protected readonly options: SerialDriverOptions,
  ) {
    this.log = parentLog.child(this.constructor.name);
  }

  // 子類別：判斷埠是否屬於本驅動。
  protected abstract selectPort(info: SerialPortInfo, normalizedVendorId: string | null): boolean;

  // 子類別：處理一行資料。
  protected abstract handleLine(line: string, h: SerialPortHandle): void;

  // 子類別可覆寫：埠開啟瞬間的狀態回報。
  protected onOpen(h: SerialPortHandle): void {
    h.pushStatus("connected", chipText(h.info));
    this.log.info(`[${h.uid}] 已開啟 ${h.info.path}｜${chipText(h.info) || "無 VID/PID"}`);
  }

  // 斷流監看：逾此毫秒無資料視為離線；null=停用（子類別覆寫啟用）。
  protected readonly livenessTimeoutMs: number | null = null;

  // hupcl=false：開關埠不產生 DTR 高→低邊緣。部分電子秤把 DTR 落下當休眠且需重新上電才醒，其子類別應覆寫為 false。
  protected readonly hupcl: boolean = true;

  // 斷流逾此毫秒則關閉重開埠（軟體重插）救回卡死的控制代碼；null=停用。
  protected readonly livenessRecoveryMs: number | null = null;

  // 子類別可覆寫：斷流時的狀態回報。
  protected onLivenessLost(h: SerialPortHandle): void {
    h.pushStatus("error", "裝置無回應（可能已關機或線路異常）");
  }

  // 子類別可覆寫：資料恢復時的狀態回報。
  protected onLivenessRestored(h: SerialPortHandle): void {
    h.pushStatus("connected", chipText(h.info));
  }

  async start(): Promise<void> {
    this.SerialPort = await loadSerialPort((m, e) => this.log.warn(m, e));
    if (!this.SerialPort) {
      this.log.warn(`${this.displayName} 驅動未啟用（serialport 不可用）。`);
      return;
    }
    this.loop = new PollLoop(this.options.pollIntervalMs, () => this.poll());
    await this.loop.start();
  }

  async stop(): Promise<void> {
    this.loop?.stop();
    this.loop = null;
    const entries = [...this.open.entries()];
    // 先清空登記，避免關閉過程中殘留回呼再觸發 detach／重開。
    this.open.clear();
    // 平行關閉並釋放（含逾時保護），確保下次啟動能立即重開該 COM 埠。
    await Promise.allSettled(entries.map(([path, e]) => this.closePort(path, e)));
    this.retry.reset();
    this.reopenThrottle.reset();
    this.openFailures.clear();
    this.replugWarned.clear();
  }

  /** 關閉單一序列埠並釋放所有相關資源；含逾時保護，避免原生 close() 卡住拖住整個關閉流程。 */
  private closePort(path: string, e: OpenEntry): Promise<void> {
    e.closing = true;
    // 先移除所有監聽器，避免關閉期間殘留閉包與重入。
    try {
      e.port.removeAllListeners("data");
      e.port.removeAllListeners("open");
      e.port.removeAllListeners("error");
      e.port.removeAllListeners("close");
    } catch {
      /* ignore */
    }
    e.framer.reset();
    this.registry.release(path);
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      // 逾時保護：close() 回呼未如期觸發也放手，讓關閉流程繼續。
      const timer = setTimeout(() => {
        this.log.warn(`[${e.handle.uid}] 關閉 ${path} 逾時，放棄等待（控制代碼將於行程結束時由 OS 釋放）。`);
        finish();
      }, CLOSE_TIMEOUT_MS);
      timer.unref?.();
      // 不分 isOpen 一律 close()：開啟中會擲錯（由 catch 收尾）或排入關閉佇列，都保證原生控制代碼被釋放，無殘留占用。
      try {
        e.port.close((err) => {
          if (err) this.log.debug(`[${e.handle.uid}] 關閉 ${path} 回報：`, err);
          finish();
        });
      } catch (err) {
        this.log.debug(`[${e.handle.uid}] 關閉 ${path} 例外：`, err);
        finish();
      }
    });
  }

  // 斷流監看與自動重連（補足「裝置關機但埠還在」的情境）。
  private checkLiveness(): void {
    if (this.livenessTimeoutMs == null) return;
    const now = Date.now();
    for (const [path, entry] of this.open) {
      if (entry.closing) continue;
      const idleMs = now - entry.lastDataAt;
      if (!entry.stale && idleMs > this.livenessTimeoutMs) {
        entry.stale = true;
        this.log.warn(`[${entry.handle.uid}] 逾 ${this.livenessTimeoutMs}ms 無資料 → 標記離線`);
        this.onLivenessLost(entry.handle);
      }
      // 斷流過久 → 關閉後由輪詢重開（軟體重插）。
      if (this.livenessRecoveryMs != null && idleMs > this.livenessRecoveryMs && !this.reopenThrottle.isCoolingDown(path)) {
        this.reopenThrottle.schedule(path);
        this.log.info(`[${entry.handle.uid}] 斷流逾 ${this.livenessRecoveryMs}ms → 自動重連（關閉後重開 ${path}）`);
        this.detach(path, entry, "斷流自動重連");
        this.retry.clear(path); // 下一輪輪詢立即重開，不受開啟失敗冷卻影響
      }
    }
  }

  private async poll(): Promise<void> {
    if (!this.SerialPort) return;
    this.checkLiveness();
    try {
      const ports = await this.SerialPort.list();
      const seen = new Set(ports.map((p) => p.path));

      // 偵測拔除：已開啟但清單裡不見了。
      for (const [path, entry] of this.open) {
        if (!seen.has(path)) this.detach(path, entry, "拔除");
      }
      this.retry.prune(seen);
      this.reopenThrottle.prune(seen);
      // 拔除後清掉失敗計數與提示狀態，重插後重新計。
      for (const p of [...this.openFailures.keys()]) if (!seen.has(p)) this.openFailures.delete(p);
      for (const p of [...this.replugWarned]) if (!seen.has(p)) this.replugWarned.delete(p);

      // 偵測新增：符合條件、尚未開啟、未被其他驅動占用、且不在重試冷卻中。
      for (const info of ports) {
        if (this.open.has(info.path)) continue;
        if (this.registry.isClaimed(info.path)) continue;
        if (this.retry.isCoolingDown(info.path)) continue;
        const vid = normalizeHexId(info.vendorId);
        const matched = this.options.forcedPath ? info.path === this.options.forcedPath : this.selectPort(info, vid);
        if (matched) this.attach(info);
      }
    } catch (err) {
      this.log.warn("列舉序列埠失敗：", err);
    }
  }

  private attach(info: SerialPortInfo): void {
    if (!this.SerialPort) return;
    if (!this.registry.claim(info.path)) return; // 競態：剛被別的驅動搶走
    const uid = `${this.kind}-${++this.counter}`;
    const framer = new LineFramer();

    const handle: SerialPortHandle = {
      uid,
      info,
      isIdentified: () => this.open.get(info.path)?.identified ?? false,
      markIdentified: () => {
        const e = this.open.get(info.path);
        if (e) e.identified = true;
      },
      pushStatus: (status, detail, nameOverride) => this.pushStatus(uid, status, detail, nameOverride),
    };

    handle.pushStatus("connecting", `連線中… ${info.path}`);

    let port: SerialPortInstance;
    try {
      port = new this.SerialPort({ path: info.path, baudRate: this.options.baudRate, autoOpen: true, hupcl: this.hupcl });
    } catch (err) {
      this.log.error(`開啟 ${info.path} 失敗：`, err);
      this.registry.release(info.path);
      this.retry.schedule(info.path);
      handle.pushStatus("error", `開啟失敗：${(err as Error).message}`);
      this.noteOpenFailure(info.path);
      return;
    }

    const entry: OpenEntry = { port, framer, handle, identified: false, closing: false, lastDataAt: Date.now(), stale: false };
    this.open.set(info.path, entry);

    port.on("open", () => {
      this.retry.clear(info.path);
      this.openFailures.delete(info.path); // 成功開啟 → 清失敗計數與重插提示
      this.replugWarned.delete(info.path);
      entry.lastDataAt = Date.now(); // 重置寬限期，避免剛開埠就被 liveness 誤判
      this.onOpen(handle);
    });
    port.on("data", (chunk: Buffer) => {
      entry.lastDataAt = Date.now();
      if (entry.stale) {
        entry.stale = false;
        this.log.info(`[${uid}] 資料恢復 → 重新上線`);
        this.onLivenessRestored(handle);
      }
      const text = chunk.toString("latin1"); // 條碼／秤資料多為 ASCII，用 latin1 避免多位元組誤切
      for (const line of framer.push(text)) this.handleLine(line, handle);
    });
    port.on("error", (err: Error) => {
      // autoOpen 失敗（如 "Cannot lock port"＝被占用）：埠未開 → 釋放並冷卻後重試。
      if (!entry.port.isOpen) {
        this.log.warn(
          `[${uid}] 開啟 ${info.path} 失敗：${err.message}（${this.retry.cooldownMs / 1000}s 後重試；常見原因：埠被其他程序佔用）`,
        );
        this.retry.schedule(info.path);
        this.noteOpenFailure(info.path);
        this.detach(info.path, entry, "開啟失敗");
        return;
      }
      this.log.warn(`[${uid}] 序列錯誤：`, err.message);
      handle.pushStatus("error", err.message);
    });
    port.on("close", () => {
      if (!entry.closing) this.detach(info.path, entry, "連線關閉");
    });
  }

  private detach(path: string, entry: OpenEntry, reason: string): void {
    if (!this.open.has(path)) return;
    entry.closing = true;
    this.open.delete(path);
    this.registry.release(path);
    entry.framer.reset();
    try {
      // 先移除監聽器再關閉，避免殘留閉包洩漏。
      entry.port.removeAllListeners("data");
      entry.port.removeAllListeners("open");
      entry.port.removeAllListeners("error");
      entry.port.removeAllListeners("close");
      if (entry.port.isOpen) entry.port.close();
    } catch {
      /* ignore */
    }
    this.log.info(`[${entry.handle.uid}] 移除（${reason}）：${path}`);
    this.pushStatus(entry.handle.uid, "removed", "");
  }

  // 累計開埠失敗；連續達門檻時提示重插 USB（只提示一次，成功開啟或重插後重置）。用 notice 確保精簡 log 也看得到。
  private noteOpenFailure(path: string): void {
    const count = (this.openFailures.get(path) ?? 0) + 1;
    this.openFailures.set(path, count);
    if (count >= WARN_REPLUG_AFTER_FAILURES && !this.replugWarned.has(path)) {
      this.replugWarned.add(path);
      this.log.notice(
        `${this.displayName}無法連線（${path}）：連續 ${count} 次連線失敗。` +
          `請將該 USB 裝置拔除後重新插上，即可自動恢復連線。`,
      );
    }
  }

  protected pushStatus(uid: string, status: DeviceStatus, detail: string, nameOverride?: string): void {
    this.bus.emit("device-status", {
      deviceId: uid,
      deviceName: nameOverride ?? this.displayName,
      kind: this.kind,
      status,
      detail,
      ts: Date.now(),
    });
  }
}

// 常見 USB-serial 晶片 VID → 名稱。
const SERIAL_CHIPS: Record<string, string> = {
  "1a86": "CH340",
  "0403": "FTDI",
  "10c4": "CP210x",
  "067b": "PL2303",
  "05e0": "Zebra/Symbol",
};

export function chipText(info: SerialPortInfo): string {
  const vid = normalizeHexId(info.vendorId);
  if (!vid) return info.manufacturer ?? "";
  const pid = normalizeHexId(info.productId) ?? "0000";
  const chip = SERIAL_CHIPS[vid];
  const id = `${vid}:${pid}`;
  return chip ? `${chip} (${id})` : `(${id})`;
}
