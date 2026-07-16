// HTTP 狀態 API（與 WS 共用埠）：GET /health、/devices、/。
// Origin 不在白名單一律 403；CORS 標頭只回給白名單 Origin。

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { isOriginAllowed, type OriginPolicy } from "./origin.js";
import type { DeviceManager } from "../core/DeviceManager.js";
import type { Logger } from "../logger.js";
import type { AgentInfo } from "./protocol.js";

export interface HttpApiDeps {
  log: Logger;
  agentInfo: AgentInfo;
  deviceManager: DeviceManager;
  activeClientCount(): number;
  /** 持有有效焦點認領（前景 WMS 頁面）的用戶端數。 */
  claimingClientCount(): number;
  security: OriginPolicy;
  /** 啟動時間（epoch ms），算 uptime 用。 */
  startedAt: number;
}

export function createApiServer(deps: HttpApiDeps): HttpServer {
  return createServer((req, res) => {
    try {
      handle(req, res, deps);
    } catch (err) {
      deps.log.error("HTTP 處理未預期錯誤：", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    }
  });
}

function handle(req: IncomingMessage, res: ServerResponse, deps: HttpApiDeps): void {
  const origin = req.headers.origin;
  const allowed = isOriginAllowed(origin, deps.security);
  applyCors(res, origin, allowed);

  const method = req.method ?? "GET";
  const pathname = (req.url ?? "/").split("?")[0];

  // 不在白名單一律擋下，所有路由一致。
  if (!allowed) {
    if (method === "OPTIONS") return void res.writeHead(403).end();
    return sendJson(res, 403, { error: "origin-not-allowed" });
  }

  if (method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (method === "GET") {
    switch (pathname) {
      case "/health":
        return sendJson(res, 200, {
          status: "ok",
          name: deps.agentInfo.name,
          version: deps.agentInfo.version,
          platform: deps.agentInfo.platform,
          protocolVersion: deps.agentInfo.protocolVersion,
          uptimeMs: Date.now() - deps.startedAt,
          ts: Date.now(),
        });
      case "/devices":
        return sendJson(res, 200, {
          ts: Date.now(),
          wsClients: deps.activeClientCount(),
          wsClaimingClients: deps.claimingClientCount(),
          connectedCount: deps.deviceManager.connectedCount(),
          devices: deps.deviceManager.snapshot(),
        });
      case "/":
        return sendJson(res, 200, {
          name: deps.agentInfo.name,
          version: deps.agentInfo.version,
          endpoints: {
            health: "GET /health",
            devices: "GET /devices",
            websocket: "WS (見 /health 的 protocolVersion)",
          },
        });
    }
  }

  sendJson(res, 404, { error: "not-found", path: pathname });
}

function applyCors(res: ServerResponse, origin: string | undefined, allowed: boolean): void {
  res.setHeader("Vary", "Origin");
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}
