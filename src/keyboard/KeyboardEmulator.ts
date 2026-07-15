// 系統鍵盤模擬（nut.js，選用相依）：把條碼送進 OS 焦點輸入框（＋選用 Enter）。
// 兩種送出方式：
//   - paste（預設）：把條碼放上剪貼簿 → 送 Ctrl+V（macOS 為 Cmd+V）→ 還原剪貼簿。
//     整串一次貼上（類似複製貼上），不逐字輸入——快、不掉字、對 IME 友善。
//   - type：以 nut.js 逐字輸入（相容性最高，作為 paste 不可用時的退路）。
// 載入失敗自動降級為 no-op；多筆掃碼排隊逐一送出，避免交錯。

import { nativeRequire } from "../runtime/nativeRequire.js";
import type { Logger } from "../logger.js";

// nut.js 的最小介面（不綁定選用相依的型別）。
interface NutKeyboard {
  type(input: string): Promise<unknown>;
  pressKey(...keys: number[]): Promise<unknown>;
  releaseKey(...keys: number[]): Promise<unknown>;
  config: { autoDelayMs: number };
}
interface NutClipboard {
  getContent(): Promise<string>;
  setContent(text: string): Promise<unknown>;
}
interface NutModule {
  keyboard: NutKeyboard;
  clipboard: NutClipboard;
  Key: { Enter: number; V: number; LeftControl: number; LeftSuper: number };
}

const SUPPORTED_PLATFORMS = new Set(["win32", "darwin", "linux"]);
// 貼上後、還原剪貼簿前的等待：讓目標視窗先完成貼上（部分程式的貼上處理是非同步）。
const RESTORE_CLIPBOARD_DELAY_MS = 150;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class KeyboardEmulator {
  private mod: NutModule | null | undefined; // undefined=未嘗試載入, null=載入失敗
  private warned = false;
  private macHintShown = false;
  private primed = false;
  private pasteFallbackWarned = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly log: Logger,
    private readonly opts: { enabled: boolean; pressEnter: boolean; paste: boolean },
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /**
   * 啟動時預熱（非同步、不阻塞）：預先載入 nut.js 原生模組並初始化提供者，
   * 讓第一筆掃碼不必現場等載入＋初始化（原本要數秒）。透過同一條佇列排入，
   * 因此即使預熱途中就有掃碼進來也不會交錯，且掃碼會緊接在預熱之後執行。
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
      // 打空字串：不輸出任何按鍵，但會觸發 nut.js 原生打字提供者的一次性初始化。
      await mod.keyboard.type("");
      // paste 模式也預熱剪貼簿提供者（讀取一次），避免第一筆貼上時才初始化。
      if (this.opts.paste) await mod.clipboard.getContent().catch(() => "");
      this.primed = true;
      this.log.info("鍵盤模擬已預熱，第一筆掃碼可即時輸入。");
    } catch (err) {
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
      m.keyboard.config.autoDelayMs = 0; // 逐字模式時零延遲，盡快打完
      this.mod = m;
      this.log.info(`鍵盤模擬（nut.js）已就緒，送出方式：${this.opts.paste ? "貼上(paste)" : "逐字(type)"}。`);
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

  /** 把條碼排入佇列，依序送到目前焦點輸入框（確保多筆掃碼不交錯）。 */
  typeBarcode(text: string): void {
    if (!this.opts.enabled) return;
    this.queue = this.queue.then(() => this.doSend(text)).catch((err) => {
      this.log.warn("鍵盤模擬送出失敗：", err);
    });
  }

  private async doSend(text: string): Promise<void> {
    const mod = await this.load();
    if (!mod) return;
    // macOS 需「輔助使用」權限；首次送出時提示一次。
    if (process.platform === "darwin" && !this.macHintShown) {
      this.macHintShown = true;
      this.log.warn(
        "macOS 鍵盤模擬需「輔助使用 (Accessibility)」權限：系統設定 → 隱私權與安全性 → 輔助使用，" +
          "把執行本程式的終端機／Node 打勾。開發環境若不需鍵盤退路，設環境變數 KEYBOARD_ENABLED=0 即可停用（本警告與 nut.js 警告皆會消失）。",
      );
    }

    let pasted = false;
    if (this.opts.paste && this.pasteSupported(mod)) {
      pasted = await this.pasteText(mod, text);
    }
    if (!pasted) {
      // 逐字輸入（paste 未啟用或失敗時的退路）。
      await mod.keyboard.type(text);
    }
    if (this.opts.pressEnter) {
      await mod.keyboard.pressKey(mod.Key.Enter);
      await mod.keyboard.releaseKey(mod.Key.Enter);
    }
    this.log.info(`（離線）以${pasted ? "貼上" : "鍵盤模擬"}輸入：${text}`);
  }

  private pasteSupported(mod: NutModule): boolean {
    return (
      !!mod.clipboard &&
      typeof mod.clipboard.setContent === "function" &&
      typeof mod.keyboard.pressKey === "function" &&
      typeof mod.Key?.V === "number"
    );
  }

  /** 以「設剪貼簿 → 送貼上快捷鍵 → 還原剪貼簿」貼上整串。回傳是否成功（失敗交由呼叫端退回逐字）。 */
  private async pasteText(mod: NutModule, text: string): Promise<boolean> {
    const modifier = process.platform === "darwin" ? mod.Key.LeftSuper : mod.Key.LeftControl;
    let prev: string | null = null;
    try {
      try {
        prev = await mod.clipboard.getContent();
      } catch {
        prev = null; // 讀不到（可能是非文字內容）→ 之後不還原
      }
      await mod.clipboard.setContent(text);
      await mod.keyboard.pressKey(modifier, mod.Key.V);
      await mod.keyboard.releaseKey(modifier, mod.Key.V);
      // 還原使用者原本的剪貼簿內容（等目標視窗貼完再還原，避免搶在貼上前覆蓋）。
      if (prev !== null) {
        void delay(RESTORE_CLIPBOARD_DELAY_MS).then(async () => {
          try {
            await mod.clipboard.setContent(prev as string);
          } catch (err) {
            this.log.debug("還原剪貼簿失敗（不影響輸入）：", err);
          }
        });
      }
      return true;
    } catch (err) {
      if (!this.pasteFallbackWarned) {
        this.pasteFallbackWarned = true;
        this.log.warn("貼上方式失敗，改用逐字輸入（本次與後續）：", err);
      }
      return false;
    }
  }
}
