import { describe, it, expect } from "vitest";
import { build, parseClientMessage, PROTOCOL_VERSION, ALL_TOPICS } from "../src/server/protocol";

describe("server message builders", () => {
  it("scan 訊息含完整信封欄位", () => {
    const m = build.scan({ deviceId: "scanner-1", deviceName: "掃碼槍", barcode: "4710", ts: 123 });
    expect(m).toEqual({
      v: PROTOCOL_VERSION,
      type: "scan",
      ts: 123,
      deviceId: "scanner-1",
      deviceName: "掃碼槍",
      barcode: "4710",
    });
  });

  it("weight 訊息保留 stable 與 kg", () => {
    const m = build.weight({ deviceId: "scale-1", deviceName: "電子秤", kg: 1.5, stable: false, ts: 9 });
    expect(m.type).toBe("weight");
    expect(m.kg).toBe(1.5);
    expect(m.stable).toBe(false);
  });

  it("error 訊息帶 code/message，預設 ref 為 null", () => {
    const m = build.error("bad-message", "x");
    expect(m.type).toBe("error");
    expect(m.code).toBe("bad-message");
    expect(m.ref).toBeNull();
  });

  it("error 可回填 ref（對應帶 ref 的指令）", () => {
    const m = build.error("not-implemented", "x", "job-1");
    expect(m.ref).toBe("job-1");
  });
});

describe("parseClientMessage", () => {
  it("合法 ping", () => {
    const r = parseClientMessage(JSON.stringify({ type: "ping", t: 5 }));
    expect(r.ok).toBe(true);
    expect(r.message?.type).toBe("ping");
  });

  it("subscribe 未給 topics 時預設全收", () => {
    const r = parseClientMessage(JSON.stringify({ type: "subscribe" }));
    expect(r.ok).toBe(true);
    if (r.message?.type === "subscribe") {
      expect(r.message.topics).toEqual([...ALL_TOPICS]);
    } else {
      throw new Error("應為 subscribe");
    }
  });

  it("壞 JSON 回 ok=false", () => {
    expect(parseClientMessage("{not json").ok).toBe(false);
  });

  it("未知 type 回 ok=false", () => {
    expect(parseClientMessage(JSON.stringify({ type: "explode" })).ok).toBe(false);
  });

  it("subscribe 帶非法 topic 回 ok=false", () => {
    expect(parseClientMessage(JSON.stringify({ type: "subscribe", topics: ["nope"] })).ok).toBe(false);
  });

  it("focus 認領訊息（active:boolean）", () => {
    const r = parseClientMessage(JSON.stringify({ type: "focus", active: true }));
    expect(r.ok).toBe(true);
    if (r.message?.type === "focus") expect(r.message.active).toBe(true);
    else throw new Error("應為 focus");
  });

  it("focus 缺 active 回 ok=false", () => {
    expect(parseClientMessage(JSON.stringify({ type: "focus" })).ok).toBe(false);
  });
});
