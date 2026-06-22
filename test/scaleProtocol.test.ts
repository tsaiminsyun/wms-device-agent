import { describe, it, expect } from "vitest";
import { parseScaleLine, hasScaleSignature } from "../src/parsing/scaleProtocol";

describe("parseScaleLine", () => {
  it("解析穩定讀數（kg）", () => {
    expect(parseScaleLine("ST,GS,+ 7.16 kg")).toEqual({ kg: 7.16, stable: true });
  });

  it("US 視為不穩定", () => {
    expect(parseScaleLine("US,GS,+ 7.16 kg")).toEqual({ kg: 7.16, stable: false });
  });

  it("保留負值（正負號與數字間有空白）", () => {
    expect(parseScaleLine("ST,GS,- 0.62 kg")).toEqual({ kg: -0.62, stable: true });
  });

  it("過載 OL 回 null（即使該行帶數字）", () => {
    expect(parseScaleLine("ST,GS, OL")).toBeNull();
    expect(parseScaleLine("ST,GS,+ 9.99 kg OL")).toBeNull();
  });

  it("公克單位換算為公斤", () => {
    expect(parseScaleLine("ST,GS,+ 500 g")).toEqual({ kg: 0.5, stable: true });
  });

  it("不把表頭 GS 的 G 誤判為公克", () => {
    // 無單位、僅 GS 表頭 → 視為 kg，不除以 1000
    expect(parseScaleLine("ST,GS,+ 2.5")).toEqual({ kg: 2.5, stable: true });
  });

  it("容忍全形句號", () => {
    expect(parseScaleLine("ST,GS,+ 0。0 kg")).toEqual({ kg: 0, stable: true });
  });

  it("空行 / 無數字回 null", () => {
    expect(parseScaleLine("")).toBeNull();
    expect(parseScaleLine("   ")).toBeNull();
    expect(parseScaleLine("ST,GS, kg")).toBeNull();
  });
});

describe("hasScaleSignature", () => {
  it("命中 ST/US/OL 旗標", () => {
    expect(hasScaleSignature("ST,GS,+ 1.0 kg")).toBe(true);
    expect(hasScaleSignature("US something")).toBe(true);
    expect(hasScaleSignature("OL")).toBe(true);
  });
  it("命中『數字+kg/g』", () => {
    expect(hasScaleSignature("12 kg")).toBe(true);
    expect(hasScaleSignature("500g")).toBe(true);
  });
  it("一般條碼字串不命中", () => {
    expect(hasScaleSignature("4710088123456")).toBe(false);
    expect(hasScaleSignature("ABC-123")).toBe(false);
  });
});
