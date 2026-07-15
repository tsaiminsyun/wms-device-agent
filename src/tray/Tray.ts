// 系統匣（工作列常駐）圖示：讓背景執行的代理有可見入口與結束方式。
// 以 systray2（選用原生相依）建立圖示與右鍵選單；選單提供「檢視 Log」與「結束程式」。
// 僅 Windows 啟用（部署目標）；其他平台略過。載入/建立失敗自動降級（不影響背景服務）。
//
// systray2 會另外啟動一個原生 helper（traybin/tray_windows_release.exe，隨 node_modules 出貨）
// 並以 stdio 溝通；本模組只做「建立選單 / 派送點擊 / 收攤」。
//
// 重要：systray2 的 init() 是非同步的——建構子回傳後 _process 仍為 null，
// 因此 onError/onClick/onExit（會存取 _process）必須等 ready() 完成後再掛，
// 否則會同步丟出 TypeError、導致點擊事件根本沒被註冊（圖示出現但選單無反應）。

import { nativeRequire } from "../runtime/nativeRequire.js";
import { showStatusWindow } from "../runtime/detach.js";
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

const ITEM_LOGS = "檢視 Log (View Logs)";
const ITEM_EXIT = "結束程式 (Exit)";

export interface TrayOptions {
  version: string;
  /** 使用者從選單選「結束」時呼叫（走既有的優雅關閉，並完全終止所有相關程序）。 */
  onExit: () => void;
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

    // 保留選單項目的物件參照：systray2 點擊事件回傳的 action.item 就是「同一個物件參照」
    // （internalIdMap 存的是原始物件），故以參照比對最穩，不受標題編碼往返影響。
    const logsItem: SysTrayItem = { title: ITEM_LOGS, tooltip: "還原狀態視窗（顯示即時 log）", enabled: true };
    const exitItem: SysTrayItem = { title: ITEM_EXIT, tooltip: "完全結束程式（含狀態視窗與背景程序）", enabled: true };

    let tray: SysTrayInstance;
    try {
      tray = new SysTray({
        menu: {
          icon: TRAY_ICON_ICO_BASE64,
          title: "",
          tooltip: `WMS Device Agent v${this.opts.version}`,
          items: [
            { title: `WMS Device Agent v${this.opts.version}`, tooltip: "背景執行中", enabled: false },
            logsItem,
            exitItem,
          ],
        },
        debug: false,
      });
    } catch (err) {
      this.log.warn("建立工作列圖示失敗（不影響背景服務）：", err);
      return;
    }
    this.tray = tray;

    // 等 helper 就緒後再掛事件（此時 _process 才存在），否則會丟錯而讓點擊事件沒被註冊。
    tray
      .ready()
      .then(async () => {
        tray.onError((err) => this.log.warn("工作列圖示錯誤：", err.message));
        await tray.onClick((action) => this.onMenuClick(action, logsItem, exitItem));
        this.log.info("工作列圖示已就緒（右鍵選單可檢視 Log 或結束程式）。");
      })
      .catch((err) => this.log.warn("工作列圖示初始化失敗（不影響背景服務）：", err));
  }

  private onMenuClick(action: SysTrayClickAction, logsItem: SysTrayItem, exitItem: SysTrayItem): void {
    // 以物件參照為主、__id 與標題為輔，三重比對，確保任何情況都能正確辨識點到哪一項。
    // __id 比對需兩邊皆有值，避免 undefined === undefined 誤判。
    const item = action.item;
    const idMatch = (a?: number, b?: number): boolean => a !== undefined && a === b;
    const isLogs = item === logsItem || idMatch(action.__id, logsItem.__id) || item?.title === ITEM_LOGS;
    const isExit = item === exitItem || idMatch(action.__id, exitItem.__id) || item?.title === ITEM_EXIT;
    if (isExit) {
      this.log.info("使用者從工作列選擇「結束程式」。");
      this.opts.onExit();
    } else if (isLogs) {
      this.log.info("使用者從工作列選擇「檢視 Log」。");
      this.openLogs();
    }
  }

  private openLogs(): void {
    // 不另開新視窗：把應用程式啟動時就開著的狀態視窗（顯示即時 log）還原並帶到前景；
    // 只有在找不到既有視窗時才會開一個新的（見 showStatusWindow）。
    void showStatusWindow(this.log);
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
