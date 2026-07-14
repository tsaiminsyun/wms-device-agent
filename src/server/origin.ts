// Origin 白名單檢查（WS 與 HTTP 共用）；正規化容錯白名單設定的大小寫與尾斜線。

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
