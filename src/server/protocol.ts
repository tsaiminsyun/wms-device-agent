// WMS 裝置代理的 WebSocket 線上協定（全新精簡版，v1）。
//
// 設計要點：
// - 每則訊息都是 JSON，含固定信封欄位：{ v:協定版本, type:訊息型別, ts:epoch ms, ...payload }。
// - 伺服器→用戶端 與 用戶端→伺服器 各有明確的 type 集合；以 type 作 discriminated union。
// - 心跳：底層用 WebSocket ping/pong frame 偵測死連線；應用層另提供 ping→pong 供前端量延遲。
// - 訂閱：用戶端可只訂閱部分 topic（scan/weight/device-status），預設全收。
//
// 前端對接：連上後第一則必為 welcome（含 agent 資訊與目前裝置快照）。之後即時收 scan/weight/device-status。

import { z } from "zod";
import type { DeviceSnapshot, DeviceStatus, DeviceKind } from "../core/types.js";

export const PROTOCOL_VERSION = 1;

export type Topic = "scan" | "weight" | "device-status";
export const ALL_TOPICS: readonly Topic[] = ["scan", "weight", "device-status"];

// ---- 伺服器 → 用戶端 ----

export interface AgentInfo {
  name: string;
  version: string;
  platform: string;
  protocolVersion: number;
}

interface Envelope<T extends string> {
  v: number;
  type: T;
  ts: number;
}

export interface WelcomeMessage extends Envelope<"welcome"> {
  agent: AgentInfo;
  devices: DeviceSnapshot[];
}
export interface ScanMessage extends Envelope<"scan"> {
  deviceId: string;
  deviceName: string;
  barcode: string;
}
export interface WeightMessage extends Envelope<"weight"> {
  deviceId: string;
  deviceName: string;
  kg: number;
  stable: boolean;
}
export interface DeviceStatusMessage extends Envelope<"device-status"> {
  deviceId: string;
  deviceName: string;
  kind: DeviceKind;
  status: DeviceStatus;
  detail: string;
}
export interface PongMessage extends Envelope<"pong"> {
  echo: number | null;
}
export interface AckMessage extends Envelope<"ack"> {
  ref: string | null;
}
export interface ErrorMessage extends Envelope<"error"> {
  code: string;
  message: string;
  /** 若該錯誤是回應某個帶 ref 的指令，回填其 ref 方便用戶端對應；否則為 null。 */
  ref: string | null;
}

export type ServerMessage =
  | WelcomeMessage
  | ScanMessage
  | WeightMessage
  | DeviceStatusMessage
  | PongMessage
  | AckMessage
  | ErrorMessage;

function now(): number {
  return Date.now();
}

export const build = {
  welcome(agent: AgentInfo, devices: DeviceSnapshot[]): WelcomeMessage {
    return { v: PROTOCOL_VERSION, type: "welcome", ts: now(), agent, devices };
  },
  scan(p: { deviceId: string; deviceName: string; barcode: string; ts: number }): ScanMessage {
    return { v: PROTOCOL_VERSION, type: "scan", ts: p.ts, deviceId: p.deviceId, deviceName: p.deviceName, barcode: p.barcode };
  },
  weight(p: { deviceId: string; deviceName: string; kg: number; stable: boolean; ts: number }): WeightMessage {
    return {
      v: PROTOCOL_VERSION,
      type: "weight",
      ts: p.ts,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      kg: p.kg,
      stable: p.stable,
    };
  },
  deviceStatus(p: {
    deviceId: string;
    deviceName: string;
    kind: DeviceKind;
    status: DeviceStatus;
    detail: string;
    ts: number;
  }): DeviceStatusMessage {
    return {
      v: PROTOCOL_VERSION,
      type: "device-status",
      ts: p.ts,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      kind: p.kind,
      status: p.status,
      detail: p.detail,
    };
  },
  pong(echo: number | null): PongMessage {
    return { v: PROTOCOL_VERSION, type: "pong", ts: now(), echo };
  },
  ack(ref: string | null): AckMessage {
    return { v: PROTOCOL_VERSION, type: "ack", ts: now(), ref };
  },
  error(code: string, message: string, ref: string | null = null): ErrorMessage {
    return { v: PROTOCOL_VERSION, type: "error", ts: now(), code, message, ref };
  },
};

export function serialize(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

// ---- 用戶端 → 伺服器（以 zod 驗證，未知/壞訊息回 error）----

const PingSchema = z.object({
  type: z.literal("ping"),
  t: z.number().optional(),
});
const SubscribeSchema = z.object({
  type: z.literal("subscribe"),
  topics: z.array(z.enum(["scan", "weight", "device-status"])).default([...ALL_TOPICS]),
});
// 焦點認領（交警模式核心）：WMS 頁面在前景/可見時送 active:true 主動認領掃碼，
// 失焦/隱藏時送 active:false 釋放。認領帶 TTL（見 WsServer），頁面需在可見時定期續約；
// 一旦頁面當機停止續約，認領逾時自動失效，掃碼即退回系統鍵盤模擬（打進其他 app）。
const FocusSchema = z.object({
  type: z.literal("focus"),
  active: z.boolean(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [PingSchema, SubscribeSchema, FocusSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export interface ParseResult {
  ok: boolean;
  message?: ClientMessage;
  error?: string;
}

export function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "JSON 解析失敗" };
  }
  const r = ClientMessageSchema.safeParse(json);
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => i.message).join("; ") || "未知訊息格式" };
  }
  return { ok: true, message: r.data };
}
