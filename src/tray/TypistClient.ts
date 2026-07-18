// 工作列元件的 WS 用戶端：連上本機服務、註冊為鍵盤輸出端（typist），
// 收到 kbd 訊息就把條碼交給鍵盤模擬（在使用者桌面代打；服務本身在 session 0 打不到）。
// 連不上／斷線即定時重連，服務重啟後自動恢復。

import { WebSocket } from "ws";
import type { Logger } from "../logger.js";

const RECONNECT_DELAY_MS = 5_000;

export class TypistClient {
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private wasConnected = false;

  constructor(
    private readonly log: Logger,
    private readonly url: string,
    private readonly onBarcode: (barcode: string) => void,
  ) {}

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.log.debug("建立 WS 連線失敗，稍後重試：", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.wasConnected = true;
      this.log.info(`已連上服務（${this.url}），註冊鍵盤輸出端。`);
      // 註冊 typist；退訂廣播主題（本端只需要 kbd 委派，不需要 weight/device-status）。
      ws.send(JSON.stringify({ type: "typist", active: true }));
      ws.send(JSON.stringify({ type: "subscribe", topics: [] }));
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString()) as { type?: string; barcode?: unknown };
        if (msg.type === "kbd" && typeof msg.barcode === "string") this.onBarcode(msg.barcode);
      } catch {
        /* 非 JSON：忽略 */
      }
    });

    ws.on("close", () => {
      if (this.wasConnected) {
        this.wasConnected = false;
        this.log.info("與服務的連線中斷，將自動重連。");
      }
      this.scheduleReconnect();
    });

    // 連線被拒（服務未啟動）等：只記 debug，close 事件會接著觸發重連。
    ws.on("error", (err) => this.log.debug("WS 連線錯誤：", err.message));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
