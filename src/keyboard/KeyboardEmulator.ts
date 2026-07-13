// 系統鍵盤模擬（交警模式的「離線退路」）：以 nut.js 把字串「打字」進目前作業系統焦點所在的輸入框，
// 並（選用）補一個 Enter，讓既有頁面的 Enter handler 不必改就能觸發送出。
//
// nut.js 是選用原生相依：載入失敗（未安裝 / 平台不支援 / 缺少權限）時自動降級為 no-op 並告警一次，
// 確保代理在 macOS 開發或無原生模組的環境仍能啟動（只是少了鍵盤退路）。
//
// 注意：序列化送出——同時間多筆掃碼要排隊逐一打字，避免字元交錯。

import type { Logger } from "../logger.js";

// nut.js fork 的最小介面（避免 typecheck 綁定該選用相依是否安裝）。
interface NutKeyboard {
  type(input: string): Promise<unknown>;
  pressKey(key: number): Promise<unknown>;
  releaseKey(key: number): Promise<unknown>;
  config: { autoDelayMs: number };
}
interface NutModule {
  keyboard: NutKeyboard;
  Key: { Enter: number };
}

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);

export class KeyboardEmulator {
  private mod: NutModule | null | undefined; // undefined=未嘗試載入, null=載入失敗
  private warned = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: Logger,
    private readonly opts: { enabled: boolean; pressEnter: boolean },
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  private async load(): Promise<NutModule | null> {
    if (this.mod !== undefined) return this.mod;
    if (!SUPPORTED_PLATFORMS.has(process.platform)) {
      this.warnOnce(`平台 ${process.platform} 不支援鍵盤模擬，已停用退路。`);
      this.mod = null;
      return null;
    }
    try {
      const m = (await import("@nut-tree-fork/nut-js")) as unknown as NutModule;
      // 載入時驗證關鍵 API 形狀，避免 fork 版本變動造成靜默按錯鍵。
      if (!m?.keyboard || typeof m.keyboard.type !== "function" || typeof m.Key?.Enter !== "number") {
        throw new Error("nut.js 介面不符預期（keyboard.type / Key.Enter 缺失）");
      }
      // 不要逐字延遲，掃碼字串要盡快打完。
      m.keyboard.config.autoDelayMs = 0;
      this.mod = m;
      this.log.info("鍵盤模擬（nut.js）已就緒。");
    } catch (err) {
      this.warnOnce("無法載入 nut.js（原生模組未安裝或無權限），離線鍵盤退路停用。");
      this.log.debug("nut.js 載入錯誤：", err);
      this.mod = null;
    }
    return this.mod;
  }

  private warnOnce(msg: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log.warn(msg);
  }

  /** 把條碼排入佇列，依序打到目前焦點輸入框（確保多筆掃碼不交錯）。 */
  typeBarcode(text: string): void {
    if (!this.opts.enabled) return;
    this.queue = this.queue.then(() => this.doType(text)).catch((err) => {
      this.log.warn("鍵盤模擬送出失敗：", err);
    });
  }

  private async doType(text: string): Promise<void> {
    const mod = await this.load();
    if (!mod) return;
    await mod.keyboard.type(text);
    if (this.opts.pressEnter) {
      await mod.keyboard.pressKey(mod.Key.Enter);
      await mod.keyboard.releaseKey(mod.Key.Enter);
    }
    this.log.info(`（離線）以鍵盤模擬輸入：${text}`);
  }
}
