// 系統鍵盤模擬：把條碼送進 OS 焦點輸入框（＋選用 Enter）；多筆掃碼排隊逐一送出，避免交錯。
// Windows 主路徑＝整串「貼上」：clip.exe 設剪貼簿 → wscript 送 Ctrl+V（單一按鍵，一次貼入、不掉字、不逐字）＋Enter。
// 全用 Windows 內建工具（零相依、免 PowerShell、無 nut.js 閃屏）；失敗自動退 nut.js。
// 其他平台走 nut.js（paste=剪貼簿整串貼上；type=逐字）。載入失敗降級為 no-op。

import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { nativeRequire } from "../runtime/nativeRequire.js";
import type { Logger } from "../logger.js";

const pexecFile = promisify(execFile);

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
// 還原剪貼簿前的等待：讓目標視窗先完成貼上（部分程式的貼上是非同步）。
const RESTORE_CLIPBOARD_DELAY_MS = 150;
// 單筆貼上動作的逾時，避免 helper 卡住拖死佇列。
const PASTE_TIMEOUT_MS = 5000;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// wscript helper：對焦點視窗送 Ctrl+V（整串一次貼上）；引數 "1" 時，稍候再送 Enter（等貼上落地）。
// SendKeys 只送固定按鍵（^v／{ENTER}），不逐字送條碼，故不會掉字、不需跳脫條碼內容。
const PASTE_VBS = `Set sh = CreateObject("WScript.Shell")
sh.SendKeys "^v"
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "1" Then
    WScript.Sleep 80
    sh.SendKeys "{ENTER}"
  End If
End If
`;

export class KeyboardEmulator {
  private mod: NutModule | null | undefined; // undefined=未嘗試載入, null=載入失敗
  private warned = false;
  private macHintShown = false;
  private primed = false;
  private pasteFallbackWarned = false;
  private queue: Promise<void> = Promise.resolve();
  // Windows 貼上 helper 狀態：VBS 檔已寫入／已警告退回 nut.js。
  private readonly vbsPath = join(tmpdir(), "wms-agent-paste.vbs");
  private vbsReady = false;
  private winFallbackWarned = false;

  constructor(
    private readonly log: Logger,
    private readonly opts: { enabled: boolean; pressEnter: boolean; paste: boolean },
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** 非同步預熱：先載入 nut.js 並初始化提供者，讓第一筆掃碼免現場等（原本數秒）。走同一佇列，故不與掃碼交錯。 */
  warmUp(): void {
    if (!this.opts.enabled || this.primed) return;
    this.queue = this.queue.then(() => this.prime()).catch(() => {});
  }

  private async prime(): Promise<void> {
    if (this.primed) return;
    // Windows：只需寫好 VBS helper（不載入 nut.js，避免其初始化的閃屏）；寫入失敗才退回 nut.js 預熱。
    if (process.platform === "win32") {
      try {
        this.ensureVbs();
        this.primed = true;
        this.log.info("鍵盤模擬（貼上）已就緒，第一筆掃碼可即時輸入。");
        return;
      } catch (err) {
        this.log.debug("貼上 helper 建立失敗，改預熱 nut.js：", err);
      }
    }
    const mod = await this.load();
    if (!mod) return;
    try {
      // 打空字串：不輸出按鍵，但觸發 nut.js 打字提供者的一次性初始化。
      await mod.keyboard.type("");
      // paste 模式也預熱剪貼簿提供者（讀一次）。
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
      m.keyboard.config.autoDelayMs = 0; // 逐字模式零延遲，盡快打完
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
    // Windows 主路徑：整串貼上（clip.exe＋Ctrl+V，不用 nut.js）；失敗才退到下方 nut.js。
    if (process.platform === "win32" && (await this.pasteWin(text))) return;
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
      await mod.keyboard.type(text); // paste 未啟用或失敗時逐字輸入
    }
    if (this.opts.pressEnter) {
      await mod.keyboard.pressKey(mod.Key.Enter);
      await mod.keyboard.releaseKey(mod.Key.Enter);
    }
    this.log.info(`（離線）以${pasted ? "貼上" : "鍵盤模擬"}輸入：${text}`);
  }

  /** 寫入貼上 VBS helper（每個行程一次，覆寫確保內容正確）。 */
  private ensureVbs(): void {
    if (this.vbsReady) return;
    writeFileSync(this.vbsPath, PASTE_VBS, "utf8");
    this.vbsReady = true;
  }

  /** 用 clip.exe 把條碼寫進剪貼簿（Windows 內建；stdin 逐字元寫入、不加尾端換行）。 */
  private setClipboardWin(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("clip.exe", [], { windowsHide: true });
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`clip.exe 結束碼 ${code}`))));
      child.stdin.once("error", reject);
      // clip.exe 依 BOM 判斷編碼；沒有 BOM 時某些 Windows 版本會把輸入位元組當成 UTF-16LE，
      // 使純 ASCII 條碼每兩碼被併成一個 CJK 字（如 "z2" → "㉺"）。故明確送 UTF-16LE BOM + 內容，杜絕誤判。
      const payload = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
      child.stdin.end(payload);
    });
  }

  /** Windows 主路徑：設剪貼簿 → wscript 送 Ctrl+V 整串貼上（＋選用 Enter）。回傳是否成功（失敗退 nut.js）。 */
  private async pasteWin(text: string): Promise<boolean> {
    try {
      this.ensureVbs();
      await this.setClipboardWin(text);
      // wscript 為無主控台 host（不閃視窗）；//B 靜默不彈錯誤框。引數 "1"/"0"＝貼上後是否補 Enter。
      await pexecFile("wscript.exe", ["//B", "//Nologo", this.vbsPath, this.opts.pressEnter ? "1" : "0"], {
        windowsHide: true,
        timeout: PASTE_TIMEOUT_MS,
      });
      this.log.info(`（離線）以貼上輸入：${text}`);
      return true;
    } catch (err) {
      if (!this.winFallbackWarned) {
        this.winFallbackWarned = true;
        this.log.warn("貼上送出失敗，退回 nut.js 鍵盤模擬：", err);
      }
      return false;
    }
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
      // 等目標視窗貼完再還原剪貼簿，避免搶在貼上前覆蓋。
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
