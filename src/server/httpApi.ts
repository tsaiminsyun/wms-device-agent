// HTTP 狀態 API（與 WebSocket 共用同一個 http.Server / 同一個埠）。
// 主要給 [FE][API]「檢查設備連線狀態」使用：
//   GET /health        → 代理是否存活、版本、平台、執行時間
//   GET /devices       → 目前各裝置連線狀態快照 + WS 用戶端數 / 認領數（核心：設備連線狀態）
//   GET /              → 基本資訊與可用端點
//
// CORS：只對白名單 Origin 回應跨來源標頭；其餘瀏覽器請求會被瀏覽器自身擋下。
// Origin 白名單：present-but-disallowed（或無 Origin 且 allowNoOrigin=false）一律回 403。

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { isOriginAllowed, type OriginPolicy } from "./origin.js";
import type { DeviceManager } from "../core/DeviceManager.js";
import type { Logger } from "../logger.js";
import type { AgentInfo } from "./protocol.js";

export interface HttpApiDeps {
  log: Logger;
  agentInfo: AgentInfo;
  deviceManager: DeviceManager;
  /** 提供目前 WS 用戶端數。 */
  activeClientCount(): number;
  /** 目前持有有效焦點認領（前景 WMS 頁面）的用戶端數。 */
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

  // Origin 白名單：不在白名單（或無 Origin 且 allowNoOrigin=false）一律擋下，所有路由一致處理。
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
