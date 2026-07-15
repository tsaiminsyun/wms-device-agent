// 系統鍵盤模擬（nut.js，選用相依）：把條碼打進 OS 焦點輸入框（＋選用 Enter）。
// 載入失敗自動降級為 no-op；多筆掃碼排隊逐一打字，避免交錯。

import { nativeRequire } from "../runtime/nativeRequire.js";
import type { Logger } from "../logger.js";

// nut.js 的最小介面（不綁定選用相依的型別）。
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
  private macHintShown = false;
  private primed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: Logger,
    private readonly opts: { enabled: boolean; pressEnter: boolean },
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * 啟動時預熱（非同步、不阻塞）：預先載入 nut.js 原生模組並初始化打字提供者，
   * 讓第一筆掃碼不必現場等載入＋初始化（原本要數秒）。透過同一條佇列排入，
   */
  warmUp(): void {
    if (!this.opts.enabled || this.primed) return;
    this.queue = this.queue.then(() => this.prime()).catch(() => {});
  }

  private async prime(): Promise<void> {
    if (this.primed) return;
    const mod = await this.load();
    if (!mod) return;
    try {
      // 消除「第一筆掃碼」的首次打字延遲。
      await mod.keyboard.type("");
      this.primed = true;
      this.log.info("鍵盤模擬已預熱，第一筆掃碼可即時輸入。");
    } catch (err) {
      // 預熱失敗不致命：之後第一筆掃碼會照常觸發載入（只是少了預熱的即時性）。
      this.log.debug("鍵盤模擬預熱失敗（不影響後續）：", err);
    }
  }

  private async load(): Promise<NutModule | null> {
    if (this.mod !== undefined) return this.mod;
    if (!SUPPORTED_PLATFORMS.has(process.platform)) {
      this.warnOnce(`平台 ${process.platform} 不支援鍵盤模擬，已停用退路。`);
      this.mod = null;
      return null;
    }
    try {
      const m = nativeRequire("@nut-tree-fork/nut-js") as NutModule;
      // 驗證關鍵 API 形狀，防 fork 版本變動。
      if (!m?.keyboard || typeof m.keyboard.type !== "function" || typeof m.Key?.Enter !== "number") {
        throw new Error("nut.js 介面不符預期（keyboard.type / Key.Enter 缺失）");
      }
      m.keyboard.config.autoDelayMs = 0; // 逐字零延遲，盡快打完
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
    // macOS 需「輔助使用」權限；首次打字時提示一次。
    if (process.platform === "darwin" && !this.macHintShown) {
      this.macHintShown = true;
      this.log.warn(
        "macOS 鍵盤模擬需「輔助使用 (Accessibility)」權限：系統設定 → 隱私權與安全性 → 輔助使用，" +
          "把執行本程式的終端機／Node 打勾。開發環境若不需鍵盤退路，設環境變數 KEYBOARD_ENABLED=0 即可停用（本警告與 nut.js 警告皆會消失）。",
      );
    }
    await mod.keyboard.type(text);
    if (this.opts.pressEnter) {
      await mod.keyboard.pressKey(mod.Key.Enter);
      await mod.keyboard.releaseKey(mod.Key.Enter);
    }
    this.log.info(`（離線）以鍵盤模擬輸入：${text}`);
  }
}
