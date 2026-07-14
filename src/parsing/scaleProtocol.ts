// 電子秤協定解析（每行如 `ST,GS,+ 7.16 kg`；ST=穩定 / US=不穩 / OL=過載）。

export interface ScaleReading {
  /** 重量（公斤）。 */
  kg: number;
  /** 是否穩定（ST=穩定、US=不穩；無明確 US 視為穩定）。 */
  stable: boolean;
}

// 秤讀數指紋（ST/US/OL 或 數字＋kg/g）：辨識哪個序列裝置是秤。
export function hasScaleSignature(line: string): boolean {
  return /\b(?:ST|US|OL)\b/i.test(line) || /\d\s*(?:kg|g)\b/i.test(line);
}

/** 解析一行秤輸出 → { kg, stable }；非重量行（無數字／OL 過載）回 null。 */
export function parseScaleLine(line: string): ScaleReading | null {
  const raw = line.trim();
  if (!raw) return null;
  const norm = raw.replace(/。/g, "."); // 韌體偶爾輸出全形句號 `0。0kg`
  if (!/\d/.test(norm)) return null;

  const upper = norm.toUpperCase();
  if (/\bOL\b/.test(upper)) return null; // 過載
  const stable = !/\bUS\b/.test(upper); // ST=穩定、US=不穩；無明確 US 視為穩定

  // 取最後一個數字 token；正負號與數字間可能有空白，取值前去除。
  const matches = norm.match(/[+-]?\s*\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) return null;
  const last = matches[matches.length - 1] as string;
  const value = Number(last.replace(/\s+/g, ""));
  if (!Number.isFinite(value)) return null;

  // 單位 g（非 kg）才 ÷1000，無單位預設 kg；負向前瞻避免 GS 表頭的 G 被誤判成公克。
  const kg = !/kg/i.test(norm) && /g(?![a-z])/i.test(norm) ? value / 1000 : value;
  return { kg, stable };
}
