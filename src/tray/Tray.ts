// 系統匣圖示（僅 Windows）：可設定選單項目的通用底座；背景工作實例與 tray 元件共用。
// 以 systray2（選用原生相依）建立；它另起原生 helper（tray_windows_release.exe）以 stdio 溝通。
// 載入/建立失敗自動降級（不影響背景服務）。
// 重要：systray2 的 init() 非同步——建構子回傳後 _process 仍為 null，故 onError/onClick/onExit
// 必須等 ready() 完成後再掛，否則同步丟 TypeError、點擊事件沒被註冊（圖示出現但選單無反應）。

import { nativeRequire } from "../runtime/nativeRequire.js";
import { TRAY_ICON_ICO_BASE64 } from "./trayIcon.js";
import type { Logger } from "../logger.js";

// systray2 最小介面（不綁定選用相依型別）。
interface SysTrayItem {
  title: string;
  tooltip: string;
  enabled?: boolean;
  checked?: boolean;
  __id?: number;
}
interface SysTrayConf {
  menu: { icon: string; title: string; tooltip: string; items: SysTrayItem[] };
  debug?: boolean;
  copyDir?: boolean | string;
}
interface SysTrayClickAction {
  item?: SysTrayItem;
  __id?: number;
}
interface SysTrayInstance {
  ready(): Promise<void>;
  onClick(cb: (action: SysTrayClickAction) => void): Promise<unknown>;
  onError(cb: (err: Error) => void): void;
  onExit(cb: () => void): void;
  kill(exitNode?: boolean): Promise<void>;
}
type SysTrayCtor = new (conf: SysTrayConf) => SysTrayInstance;

export interface TrayMenuItem {
  title: string;
  tooltip: string;
  onClick: () => void;
}

export interface TrayOptions {
  version: string;
  items: TrayMenuItem[];
}

export class Tray {
  private tray: SysTrayInstance | null = null;

  constructor(
    private readonly log: Logger,
    private readonly opts: TrayOptions,
  ) {}

  start(): void {
    if (process.platform !== "win32") {
      this.log.debug("非 Windows，略過工作列圖示。");
      return;
    }
    let SysTray: SysTrayCtor;
    try {
      const mod = nativeRequire("systray2") as { default?: SysTrayCtor };
      SysTray = (mod.default ?? (mod as unknown as SysTrayCtor)) as SysTrayCtor;
      if (typeof SysTray !== "function") throw new Error("systray2 匯出非預期");
    } catch (err) {
      this.log.warn("無法載入 systray2（工作列圖示停用，不影響背景服務）：", err);
      return;
    }

    // 保留選單項目物件參照：systray2 回傳的 action.item 即同一參照，以參照比對最穩，不受標題編碼影響。
    const entries = this.opts.items.map((item) => ({
      sys: { title: item.title, tooltip: item.tooltip, enabled: true } as SysTrayItem,
      onClick: item.onClick,
    }));

    let tray: SysTrayInstance;
    try {
      tray = new SysTray({
        menu: {
          icon: TRAY_ICON_ICO_BASE64,
          title: "",
          tooltip: `WMS Device Agent v${this.opts.version}`,
          items: [
            { title: `WMS Device Agent v${this.opts.version}`, tooltip: "執行中", enabled: false },
            ...entries.map((e) => e.sys),
          ],
        },
        debug: false,
      });
    } catch (err) {
      this.log.warn("建立工作列圖示失敗（不影響背景服務）：", err);
      return;
    }
    this.tray = tray;

    // 等 ready() 後再掛事件（_process 才存在），否則丟錯而使點擊沒被註冊。
    tray
      .ready()
      .then(async () => {
        tray.onError((err) => this.log.warn("工作列圖示錯誤：", err.message));
        await tray.onClick((action) => this.onMenuClick(action, entries));
        this.log.info("工作列圖示已就緒。");
      })
      .catch((err) => this.log.warn("工作列圖示初始化失敗（不影響背景服務）：", err));
  }

  private onMenuClick(action: SysTrayClickAction, entries: { sys: SysTrayItem; onClick: () => void }[]): void {
    // 三重比對（參照為主、__id 與標題為輔）確保辨識點到哪一項；__id 需兩邊皆有值以免誤判。
    const item = action.item;
    const idMatch = (a?: number, b?: number): boolean => a !== undefined && a === b;
    for (const e of entries) {
      if (item === e.sys || idMatch(action.__id, e.sys.__id) || item?.title === e.sys.title) {
        this.log.info(`使用者從工作列選擇「${e.sys.title}」。`);
        try {
          e.onClick();
        } catch (err) {
          this.log.warn(`工作列選單動作失敗（${e.sys.title}）：`, err);
        }
        return;
      }
    }
  }

  /** 關閉時收攤 helper 程序（exitNode=false：由主程式自己決定退出時機）。
   *  回傳 Promise，讓主程式可在真正 process.exit 前先等圖示消失，避免殘留幽靈圖示。 */
  async stop(): Promise<void> {
    if (!this.tray) return;
    const t = this.tray;
    this.tray = null;
    try {
      await t.kill(false);
    } catch {
      /* helper 已死或無回應：忽略，主程式的關閉看門狗會保證退出 */
    }
  }
}
