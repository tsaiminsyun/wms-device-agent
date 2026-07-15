// 設定載入：預設值 → config.json → 環境變數（最高優先）；zod 驗證，失敗即拋錯。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { isSeaBuild } from "./runtime/nativeRequire.js";
import type { LogLevel } from "./logger.js";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

// vendorId 正規化：去 0x、轉小寫、補至 4 碼 hex。
const VendorIdSchema = z
  .string()
  .transform((s) => s.trim().replace(/^0x/i, "").toLowerCase())
  .pipe(z.string().regex(/^[0-9a-f]{1,4}$/, "vendorId 需為 1~4 碼 hex"))
  .transform((s) => s.padStart(4, "0"));

// usage page：接受十進位數字或 "0x" hex 字串 → 一律轉成數字。
const UsagePageSchema = z.union([z.number().int().nonnegative(), z.string()]).transform((v, ctx) => {
  if (typeof v === "number") return v;
  const m = v.trim().match(/^0x([0-9a-fA-F]+)$/);
  if (!m) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'usagePage 需為數字或 0x 前綴 hex 字串（如 140 或 "0x8c"）' });
    return z.NEVER;
  }
  return parseInt(m[1] as string, 16);
});

// 掃碼去重窗（毫秒）：窗內同一條碼只送第一筆；0=關閉。
const DedupWindowMsSchema = z.number().int().min(0).default(1500);

// 連線後要忽略的自動觸發掃碼筆數：有些掃碼槍一接上就自動送出一筆（型號/自我測試字串，
// 如 MOTEVTTC110），此時尚未有人操作，須忽略以免誤輸入。採「計數」而非時間窗——
// 打包到 Windows 後原生模組載入可能卡住事件迴圈數秒，時間窗會失準；計數式與開發環境一致。
// 預設 1（忽略連線後第一筆）；0=關閉。掃碼槍每次連線只自動送一筆，故一般設 1 即可。
const IgnoreFirstScansSchema = z.number().int().min(0).default(1);

// 每個子物件都加 .default({})：整段缺席時仍套用各欄位預設，而非報 Required。
export const ConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8788),
      wsPath: z.string().startsWith("/").default("/ws"),
    })
    .default({}),
  security: z
    .object({
      allowedOrigins: z.array(z.string()).default(["http://localhost:5173", "http://localhost:3000"]),
      allowNoOrigin: z.boolean().default(true),
    })
    .default({}),
  scanner: z
    .object({
      enabled: z.boolean().default(true),
      vendorIds: z.array(VendorIdSchema).default(["05e0"]),
      baudRate: z.number().int().positive().default(9600),
      path: z.string().nullable().default(null),
      keyboardFallback: z.boolean().default(true),
      dedupWindowMs: DedupWindowMsSchema,
      ignoreFirstScans: IgnoreFirstScansSchema,
    })
    .default({}),
  // HID 掃碼槍（HID-POS/IBM，node-hid）；usagePages 空陣列＝接受任何非鍵盤/滑鼠 collection。
  hidScanner: z
    .object({
      enabled: z.boolean().default(true),
      vendorIds: z.array(VendorIdSchema).default(["05e0"]),
      usagePages: z.array(UsagePageSchema).default([]),
      reportHeaderBytes: z.number().int().min(0).max(64).default(4),
      dedupWindowMs: DedupWindowMsSchema,
      ignoreFirstScans: IgnoreFirstScansSchema,
    })
    .default({}),
  scale: z
    .object({
      enabled: z.boolean().default(true),
      baudRate: z.number().int().positive().default(9600),
      vendorIds: z.array(VendorIdSchema).default(["1a86", "0403", "10c4", "067b"]),
      path: z.string().nullable().default(null),
    })
    .default({}),
  serial: z
    .object({
      pollIntervalMs: z.number().int().min(500).default(2000),
    })
    .default({}),
  keyboard: z
    .object({
      enabled: z.boolean().default(true),
      pressEnter: z.boolean().default(true),
    })
    .default({}),
  logLevel: LogLevelSchema.default("info"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

function readConfigFile(): unknown {
  // 依序找：工作目錄 → （SEA 打包時）exe 所在目錄。
  const candidates = [resolve(process.cwd(), "config.json")];
  if (isSeaBuild()) candidates.push(join(dirname(process.execPath), "config.json"));

  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      // 檔案不存在屬正常；JSON 壞掉才警告。
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[config] 讀取 ${path} 失敗，改用預設值：`, (err as Error).message);
        return {};
      }
    }
  }
  return {};
}

// 把環境變數覆寫進 partial config（只覆寫有設定的鍵）。
function envOverrides(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const server: Record<string, unknown> = {};
  const security: Record<string, unknown> = {};

  if (process.env.HOST) server.host = process.env.HOST;
  if (process.env.PORT) server.port = Number(process.env.PORT);
  if (Object.keys(server).length) out.server = server;

  if (process.env.WMS_ALLOWED_ORIGINS) {
    security.allowedOrigins = process.env.WMS_ALLOWED_ORIGINS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (process.env.ALLOW_NO_ORIGIN) security.allowNoOrigin = parseBool(process.env.ALLOW_NO_ORIGIN);
  if (Object.keys(security).length) out.security = security;

  if (process.env.KEYBOARD_ENABLED) out.keyboard = { enabled: parseBool(process.env.KEYBOARD_ENABLED) };

  if (process.env.LOG_LEVEL) out.logLevel = process.env.LOG_LEVEL;

  return out;
}

function parseBool(v: string): boolean {
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// 淺層深合併：物件遞迴合併，其餘（含陣列）直接覆寫。
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function loadConfig(): AppConfig {
  const fileCfg = readConfigFile();
  const merged = deepMerge(isPlainObject(fileCfg) ? fileCfg : {}, envOverrides());
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`設定驗證失敗：\n${issues}`);
  }
  return result.data;
}

export type { LogLevel };
