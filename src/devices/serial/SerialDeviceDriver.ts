// 序列裝置驅動共用底座：負責「埠的探索 / 熱插拔 / 開關 / 分行」，
// 把「哪些埠是我的」與「每一行怎麼處理」交給子類別（掃碼槍 / 電子秤）實作。
//
// 探索策略：定時輪詢 SerialPort.list()（跨平台最可靠），與目前已開的埠比對：
//   - 出現新的、且符合本驅動 selectPort() 的埠 → 開啟並掛上讀取；
//   - 原本開著但已從清單消失（拔除）→ 關閉並回報 removed。
// 只讀不寫，降低對其他序列裝置的干擾。

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

// 斷流自動重連的最小間隔：即使裝置持續無資料，也至多每此毫秒數重開一次，避免洗 log／狀態閃爍。
const REOPEN_MIN_INTERVAL_MS = 60_000;

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
  /** 最近一次收到序列資料的時間（epoch ms）；供 liveness 監看判斷是否斷流。 */
  lastDataAt: number;
  /** 目前是否已因斷流被標記為離線（避免重複 emit）。 */
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
  // 斷流自動重連的節流：path → 上次觸發重連的時間，避免對「僅是關機」的裝置狂關狂開洗 log。
  private readonly lastReopenAt = new Map<string, number>();
  private loop: PollLoop | null = null;
  private SerialPort: SerialPortCtor | null = null;
  private counter = 0;

  protected readonly log: Logger;

  constructor(
    protected readonly bus: DeviceBus,
    parentLog: Logger,
    private readonly registry: PortRegistry,
    protected readonly options: SerialDriverOptions,
  ) {
    this.log = parentLog.child(this.constructor.name);
  }

  // 子類別：判斷一個（尚未開啟的）埠是否屬於本驅動。
  protected abstract selectPort(info: SerialPortInfo, normalizedVendorId: string | null): boolean;

  // 子類別：處理一行資料。
  protected abstract handleLine(line: string, h: SerialPortHandle): void;

  // 子類別可覆寫：埠開啟瞬間的狀態（掃碼槍直接 connected；電子秤先中性、待指紋升級）。
  protected onOpen(h: SerialPortHandle): void {
    h.pushStatus("connected", chipText(h.info));
    this.log.info(`[${h.uid}] 已開啟 ${h.info.path}｜${chipText(h.info) || "無 VID/PID"}`);
  }

  // 斷流監看：持續串流的裝置（電子秤）超過此毫秒數沒收到資料 → 視為離線（可能關機／線路異常）。
  // null＝停用（如掃碼槍平時不主動送資料，不適用）。子類別覆寫以啟用。
  protected readonly livenessTimeoutMs: number | null = null;

  // 斷流自動重連：裝置持續無資料超過此毫秒數，主動關閉並重開序列埠（相當於「軟體版重插」），
  // 以救回卡死的序列控制代碼（例如舊實例殘留、驅動狀態異常）而不必手動拔插。null＝停用。
  // 節流至每 REOPEN_MIN_INTERVAL_MS 至多一次，避免對單純關機的裝置反覆開關。
  protected readonly livenessRecoveryMs: number | null = null;

  // 子類別可覆寫：偵測到斷流（裝置就緒後停止送資料）時的狀態回報，預設標為 error（前端顯示紅燈）。
  protected onLivenessLost(h: SerialPortHandle): void {
    h.pushStatus("error", "裝置無回應（可能已關機或線路異常）");
  }

  // 子類別可覆寫：資料恢復時的狀態回報，預設回到 connected。
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
    const paths = [...this.open.keys()];
    await Promise.allSettled(
      paths.map(
        (path) =>
          new Promise<void>((res) => {
            const e = this.open.get(path);
            if (!e) return res();
            e.closing = true;
            try {
              e.port.close(() => res());
            } catch {
              res();
            }
          }),
      ),
    );
    for (const path of paths) this.registry.release(path);
    this.open.clear();
    this.retry.reset();
    this.lastReopenAt.clear();
  }

  // 斷流監看：已開啟且啟用 liveness 的裝置，超過 livenessTimeoutMs 沒收到資料 → 標為離線（紅燈）。
  // 埠仍在（USB-serial 晶片供電）故不會觸發拔除偵測；靠此補足「秤關機但線還插著」的情境。
  // 若再啟用 livenessRecoveryMs，斷流更久則主動關閉並重開該埠（軟體版重插）救回卡死的控制代碼。
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
      // 斷流過久 → 軟體重插（關閉後由輪詢重開）。節流避免對單純關機的裝置反覆開關。
      if (this.livenessRecoveryMs != null && idleMs > this.livenessRecoveryMs) {
        const lastReopen = this.lastReopenAt.get(path) ?? 0;
        if (now - lastReopen >= REOPEN_MIN_INTERVAL_MS) {
          this.lastReopenAt.set(path, now);
          this.log.info(`[${entry.handle.uid}] 斷流逾 ${this.livenessRecoveryMs}ms → 自動重連（關閉後重開 ${path}）`);
          this.detach(path, entry, "斷流自動重連");
          this.retry.clear(path); // 讓下一輪輪詢立即重開，不受開啟失敗冷卻影響
        }
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
      for (const path of this.lastReopenAt.keys()) if (!seen.has(path)) this.lastReopenAt.delete(path);

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
      port = new this.SerialPort({ path: info.path, baudRate: this.options.baudRate, autoOpen: true });
    } catch (err) {
      this.log.error(`開啟 ${info.path} 失敗：`, err);
      this.registry.release(info.path);
      this.retry.schedule(info.path);
      handle.pushStatus("error", `開啟失敗：${(err as Error).message}`);
      return;
    }

    const entry: OpenEntry = { port, framer, handle, identified: false, closing: false, lastDataAt: Date.now(), stale: false };
    this.open.set(info.path, entry);

    port.on("open", () => {
      this.retry.clear(info.path);
      entry.lastDataAt = Date.now(); // 重置寬限期，避免剛開埠就被 liveness 誤判斷流
      this.onOpen(handle);
    });
    port.on("data", (chunk: Buffer) => {
      entry.lastDataAt = Date.now();
      if (entry.stale) {
        entry.stale = false;
        this.log.info(`[${uid}] 資料恢復 → 重新上線`);
        this.onLivenessRestored(handle);
      }
      const text = chunk.toString("latin1"); // 條碼／秤資料多為 ASCII/拉丁，避免多位元組誤切
      for (const line of framer.push(text)) this.handleLine(line, handle);
    });
    port.on("error", (err: Error) => {
      // 最常見：autoOpen 開埠失敗（"Cannot lock port"＝被其他程序／另一個 agent 實例佔用）。
      // 此時埠未真正開啟 → 釋放並設冷卻，讓之後輪詢重試（佔用方放開後即自動恢復），不卡在 error。
      if (!entry.port.isOpen) {
        this.log.warn(
          `[${uid}] 開啟 ${info.path} 失敗：${err.message}（${this.retry.cooldownMs / 1000}s 後重試；常見原因：埠被其他程序佔用）`,
        );
        this.retry.schedule(info.path);
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
      // 先移除我們掛的監聽器，避免關閉過程的殘留事件持有 entry/framer 閉包造成熱插拔洩漏。
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

// 常見 USB-serial 轉接晶片 VID → 名稱（桌秤多為 RS232 經晶片轉 USB）。
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
