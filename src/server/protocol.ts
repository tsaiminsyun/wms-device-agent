// WS 線上協定 v1：每則訊息為 JSON 信封 { v, type, ts, ...payload }。
// 伺服器→用戶端以 build 建構；用戶端→伺服器以 zod 驗證。

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
  /** 回應帶 ref 的指令時回填，否則 null。 */
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
// 焦點認領：active:true 需定期續約（見 WsServer TTL），失焦送 false。
const FocusSchema = z.object({
  type: z.literal("focus"),
  active: z.boolean(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [PingSchema, SubscribeSchema, FocusSchema]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ParseResult = { ok: true; message: ClientMessage } | { ok: false; error: string };

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
