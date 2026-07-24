import { describe, it, expect, vi, afterEach } from "vitest";
import { installCrashGuards } from "../src/runtime/proc";

// 攔截 process.on 註冊（不真的掛上，避免污染測試行程），驗證防護有掛且被觸發時記 log、不再往外拋。
describe("installCrashGuards", () => {
  const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), notice: vi.fn(), user: vi.fn(), child() { return this; } } as never);
  let spy: ReturnType<typeof vi.spyOn>;
  afterEach(() => spy?.mockRestore());

  it("掛上 uncaughtException 與 unhandledRejection，且觸發時記 log 不重拋", () => {
    const handlers: Record<string, (err: unknown) => void> = {};
    spy = vi.spyOn(process, "on").mockImplementation(((ev: string, cb: (err: unknown) => void) => {
      handlers[ev] = cb;
      return process;
    }) as never);

    const log = mkLog() as unknown as { error: ReturnType<typeof vi.fn> };
    installCrashGuards(log as never);

    expect(typeof handlers.uncaughtException).toBe("function");
    expect(typeof handlers.unhandledRejection).toBe("function");

    // 觸發不得往外拋（否則就等於崩潰），且要記 error log。
    expect(() => handlers.uncaughtException!(new Error("拔插瞬間原生層錯誤"))).not.toThrow();
    expect(() => handlers.unhandledRejection!(new Error("未處理 rejection"))).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});
