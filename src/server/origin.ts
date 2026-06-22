// Origin 白名單檢查（WS upgrade 與 HTTP CORS 共用）。
// 瀏覽器送出的 Origin 依 RFC 6454 本就為小寫、無尾斜線；此處的正規化主要是「容錯設定」——
// 避免管理者在白名單把 Origin 寫成大寫或多了尾斜線（如 "http://localhost:5173/"）導致合法頁面被擋。

export interface OriginPolicy {
  allowedOrigins: string[];
  allowNoOrigin: boolean;
}

function normalize(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

export function isOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  if (origin === undefined || origin === "") return policy.allowNoOrigin;
  const norm = normalize(origin);
  return policy.allowedOrigins.some((o) => normalize(o) === norm);
}
