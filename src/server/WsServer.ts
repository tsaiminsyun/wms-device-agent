// WebSocket 伺服器：Origin 白名單、心跳、訂閱、焦點認領（TTL 內續約才有效）。
// weight/device-status 廣播給訂閱者；scan 僅由 TrafficCop 經 broadcastScan() 送給認領者（不雙送）。

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  ALL_TOPICS,
  build,
  parseClientMessage,
  serialize,
  type AgentInfo,
  type ServerMessage,
  type Topic,
} from "./protocol.js";
import { isOriginAllowed, type OriginPolicy } from "./origin.js";
import type { DeviceBus } from "../core/DeviceBus.js";
import type { DeviceManager } from "../core/DeviceManager.js";
import type { DeviceBusEvents, ScanEvent } from "../core/types.js";
import type { Logger } from "../logger.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
// 焦點認領存活時間：需在此時間內續約，否則失效。
const CLAIM_TTL_MS = 6_000;
// 同時連線上限（防呆）。
const MAX_CONNECTIONS = 50;

interface ClientState {
  id: number;
  isAlive: boolean;
  topics: Set<Topic>;
  origin: string;
  /** 是否認領掃碼（前景/可見的 WMS 頁面）。 */
  focusActive: boolean;
  /** 認領逾時時間（epoch ms）。 */
  focusExpiresAt: number;
}

export type WsSecurity = OriginPolicy;

export class WsServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<WebSocket, ClientState>();
  private heartbeat: NodeJS.Timeout | null = null;
  private counter = 0;
  private readonly boundUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  // 保存 bus 監聽器供 stop() 解除。
  private busListeners: Partial<{ [K in keyof DeviceBusEvents]: (e: DeviceBusEvents[K]) => void }> = {};

  constructor(
    private readonly bus: DeviceBus,
    private readonly log: Logger,
    private readonly agentInfo: AgentInfo,
    private readonly deviceManager: DeviceManager,
    private readonly security: WsSecurity,
    private readonly wsPath: string,
  ) {
    // 訊息極小：限 64KB、關閉壓縮。
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    this.boundUpgrade = (req, socket, head) => this.handleUpgrade(req, socket, head);
  }

  /** 掛到共用 http server 的 upgrade 事件（自行做路徑與 Origin 檢查）。 */
  attach(httpServer: HttpServer): void {
    httpServer.on("upgrade", this.boundUpgrade);
  }

  /** 解除掛在 http server 的 upgrade handler（關閉/重啟用）。 */
  detach(httpServer: HttpServer): void {
    httpServer.off("upgrade", this.boundUpgrade);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = req.url ?? "";
    const pathname = url.split("?")[0];
    if (pathname !== this.wsPath) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, this.security)) {
      this.log.warn(`拒絕 WS 連線（Origin 不在白名單）：${origin ?? "(無 Origin)"}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (this.clients.size >= MAX_CONNECTIONS) {
      this.log.warn(`拒絕 WS 連線（已達連線上限 ${MAX_CONNECTIONS}）`);
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws, origin ?? "");
    });
  }

  private onConnection(ws: WebSocket, origin: string): void {
    const state: ClientState = {
      id: ++this.counter,
      isAlive: true,
      topics: new Set(ALL_TOPICS),
      origin,
      focusActive: false,
      focusExpiresAt: 0,
    };
    this.clients.set(ws, state);
    this.log.info(`WS 用戶端 #${state.id} 連線（Origin: ${origin || "(無)"}）；目前連線數 ${this.clients.size}`);

    this.sendTo(ws, build.welcome(this.agentInfo, this.deviceManager.snapshot()));

    ws.on("pong", () => {
      const s = this.clients.get(ws);
      if (s) s.isAlive = true;
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.log.debug(`用戶端 #${state.id} 送來二進位訊框，已忽略（協定僅接受 JSON 文字）`);
        return;
      }
      this.onMessage(ws, data.toString());
    });

    ws.on("close", () => {
      this.clients.delete(ws);
      this.log.info(`WS 用戶端 #${state.id} 離線；目前連線數 ${this.clients.size}`);
    });

    ws.on("error", (err) => {
      this.log.warn(`WS 用戶端 #${state.id} 錯誤：`, err.message);
    });
  }

  private onMessage(ws: WebSocket, raw: string): void {
    const result = parseClientMessage(raw);
    if (!result.ok) {
      this.sendTo(ws, build.error("bad-message", result.error));
      return;
    }
    const msg = result.message;
    const state = this.clients.get(ws);
    switch (msg.type) {
      case "ping":
        this.sendTo(ws, build.pong(msg.t ?? null));
        break;
      case "subscribe":
        if (state) {
          state.topics = new Set(msg.topics as Topic[]);
          this.log.debug(`用戶端 #${state.id} 訂閱：${[...state.topics].join(",") || "(空)"}`);
        }
        this.sendTo(ws, build.ack(null));
        break;
      case "focus":
        if (state) {
          state.focusActive = msg.active;
          state.focusExpiresAt = msg.active ? Date.now() + CLAIM_TTL_MS : 0;
          this.log.debug(`用戶端 #${state.id} 焦點認領：${msg.active ? "claim" : "release"}`);
        }
        // 不回 ack：續約頻繁，避免雜訊。
        break;
    }
  }

  /** 訂閱 DeviceBus 的 weight/device-status，開始心跳。 */
  start(): void {
    this.busListeners.weight = (e) => this.broadcast("weight", build.weight(e));
    this.busListeners["device-status"] = (e) => this.broadcast("device-status", build.deviceStatus(e));
    this.bus.on("weight", this.busListeners.weight);
    this.bus.on("device-status", this.busListeners["device-status"]);

    this.heartbeat = setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private runHeartbeat(): void {
    for (const [ws, state] of this.clients) {
      if (!state.isAlive) {
        this.log.debug(`心跳逾時，終止用戶端 #${state.id}`);
        try {
          ws.terminate();
        } catch (err) {
          this.log.debug(`terminate 失敗（#${state.id}）：`, err);
        }
        this.clients.delete(ws);
        continue;
      }
      state.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        this.log.debug(`ping 失敗（#${state.id}）：`, err);
      }
    }
  }

  // ---- 焦點認領查詢與 scan 路由（給 TrafficCop / HTTP 用）----

  /** 該用戶端是否持有「有效（未逾時）」的焦點認領。 */
  private isValidClaim(ws: WebSocket, s: ClientState, now: number): boolean {
    return ws.readyState === WebSocket.OPEN && s.focusActive && now < s.focusExpiresAt;
  }

  /** 目前是否有任一用戶端持有有效的焦點認領。 */
  hasActiveClaim(): boolean {
    return this.claimingCount() > 0;
  }

  /** 目前持有有效認領的用戶端數（給 /devices 顯示）。 */
  claimingCount(): number {
    const now = Date.now();
    let n = 0;
    for (const [ws, s] of this.clients) {
      if (this.isValidClaim(ws, s, now)) n++;
    }
    return n;
  }

  /** 把一筆掃碼送給「持有有效認領、且訂閱 scan」的用戶端。回傳實際送達數。 */
  broadcastScan(e: ScanEvent): number {
    const now = Date.now();
    const payload = serialize(build.scan(e));
    let sent = 0;
    for (const [ws, s] of this.clients) {
      if (!this.isValidClaim(ws, s, now) || !s.topics.has("scan")) continue;
      if (this.rawSend(ws, payload, s.id)) sent++;
    }
    return sent;
  }

  private broadcast(topic: Topic, msg: ServerMessage): void {
    const payload = serialize(msg);
    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!state.topics.has(topic)) continue;
      this.rawSend(ws, payload, state.id);
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    this.rawSend(ws, serialize(msg), this.clients.get(ws)?.id ?? -1);
  }

  // ws.send 可能同步/非同步出錯，皆記 debug、不中斷流程。
  private rawSend(ws: WebSocket, payload: string, clientId: number): boolean {
    try {
      ws.send(payload, (err) => {
        if (err) this.log.debug(`送出失敗（#${clientId}）：`, err.message);
      });
      return true;
    } catch (err) {
      this.log.debug(`送出例外（#${clientId}）：`, err);
      return false;
    }
  }

  /** 目前 active（OPEN）的用戶端數。 */
  activeClientCount(): number {
    let n = 0;
    for (const ws of this.clients.keys()) if (ws.readyState === WebSocket.OPEN) n++;
    return n;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.busListeners.weight) this.bus.off("weight", this.busListeners.weight);
    if (this.busListeners["device-status"]) this.bus.off("device-status", this.busListeners["device-status"]);
    this.busListeners = {};
    for (const ws of this.clients.keys()) {
      try {
        ws.close(1001, "agent shutting down");
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    await new Promise<void>((res) => this.wss.close(() => res()));
  }
}
