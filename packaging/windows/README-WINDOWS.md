# wms-device-agent — Windows 部署說明

本程式以 **Inno Setup 安裝程式** 發佈，交付形式是 `wms-device-agent-setup-<版本>.zip`
（解壓後為單一支 `wms-device-agent-setup-<版本>.exe`）：不需要安裝 Node.js，執行安裝程式即完成部署、開機自動啟動與後續升級。

預設安裝位置：`C:\Program Files\wms-device-agent\`（log 與設定都放在這裡；因程式一律以系統管理員身分執行，可正常寫入）。

## 內容物（安裝後的資料夾）

| 檔案 | 說明 |
|---|---|
| `wms-device-agent.exe` | 主程式（內含 Node.js 執行環境與應用程式碼） |
| `node_modules/` | 裝置原生模組（serialport / node-hid / nut.js）與工作列圖示 helper（systray2），**必須與 exe 放同一層** |
| `config.json` | 設定檔（部署時修改，見下）；升級時**不會被覆蓋** |
| `run-agent.bat` / `run-hidden.vbs` | 隱藏背景啟動 helper（登入自動啟動用），**不用手動執行** |

> 安裝／解除安裝／升級／開機自動啟動都由 `setup.exe` 或「設定 → 應用程式」處理，使用者不需開啟此資料夾，
> 故資料夾裡**不再附**任何手動 `.bat` 或說明文件（說明改由本檔與專案 README 提供）。

## 快速開始

1. 解壓 `wms-device-agent-setup-<版本>.zip`，執行裡面的 `wms-device-agent-setup-<版本>.exe`
   （UAC 詢問按「是」），一路 Next → Install → Finish。
   安裝過程會**詢問是否在桌面建立捷徑**（勾選即建立；桌面捷徑與開始功能表捷徑行為相同）。
2. 安裝完成後程式**自動啟動**：右下角**系統匣**出現**橘色包裹圖示**（看不到就按「^」展開）。
3. 編輯 `config.json`（在安裝資料夾內）：把正式 WMS 網址加進 `security.allowedOrigins`，存檔後從系統匣「重啟服務」。
   > `config.json` 位於 `C:\Program Files\wms-device-agent\`。安裝程式已對它授予一般使用者「修改」權限，
   > 因此**可直接用記事本編輯／覆蓋，不需以系統管理員開啟**。
4. 瀏覽器開 `http://127.0.0.1:8788/health`，看到 `{"status":"ok",...}` 即成功。

> **按 X 不會關掉程式**：狀態視窗右上角的 X 只會關掉「視窗」——程式本體繼續在背景執行，
> 圖示縮到系統匣（看不到就按「^」展開隱藏的圖示）。
>
> **系統匣選單**（右鍵包裹圖示）有三項：
> 「**開啟 Log**」會**啟動一個狀態視窗**（即 `wms-device-agent.exe`）顯示即時 log；
> 背景實例仍在執行，所以它只會 tail 同一份當日日期檔，不會重複啟動背景服務。
> 「**重啟服務**」會啟動一個新的背景實例接手，並請舊實例優雅關閉、乾淨釋放序列埠後重連——
> 等同「關掉再開」的乾淨重連，電子秤／掃碼槍會自動重新偵測，無需手動復原。
> 「**結束**」會**完全結束**（關閉狀態視窗、背景實例與工作列 helper 等所有相關程序）並釋放序列埠。
>
> **log 檔**：放在使用者「**文件**」夾下的 **`文件\wms-device-agent\logs\`**，每天一個日期檔
> （`wms-agent-YYYY-MM-DD.log`），跨日自動換檔；舊檔**永久保留、不會自動清除**（要清請自行刪除檔案）。（放文件夾＝好找、免提權即可開啟。）
> 內容是**給一般使用者看的精選記錄**（＝狀態視窗內容），只記重要、好懂的事件——啟動中／已啟動（含版本號，如「wms-device-agent v1.0.0 已啟動」）、
> 掃碼槍已連線、電子秤已連線、掃碼：、改用鍵盤模擬、工作列選單操作、重啟服務中／已重啟；裝置拔除時
> **掃碼槍已斷線／電子秤已斷線**、電子秤關機或開機時 **電子秤已關機／電子秤已開機**、程式關閉時 **應用程式已關閉**；
> 出錯時也只簡單標示是 **電子秤發生錯誤／掃碼槍發生錯誤／應用程式發生錯誤**（不含錯誤碼、型號等技術細節）。
> 同一台電腦接多台電子秤時會以 **COM 埠**區分（如「**電子秤 (COM3)**」「**電子秤 (COM4)**」，與裝置管理員一致），例如「電子秤 (COM4) 已關機」。
>
> （進階：設環境變數 `WMS_NO_DETACH=1` 可停用「視窗／背景分離」，回到傳統單行程行為。）

> **SmartScreen 提示**：安裝程式與 exe 未簽章（exe 由官方 node.exe 注入程式產生），首次執行
> Windows 可能跳出「Windows 已保護您的電腦」——點「其他資訊」→「仍要執行」。

## 自動啟動的設計

安裝程式會建立**使用者登入時**的排程工作（Task Scheduler，隱藏視窗），而不是 Windows 服務。
這是刻意的：**鍵盤模擬退路與系統匣圖示需要在使用者桌面工作階段執行**，
Windows 服務（session 0）打不進使用者的視窗。

工作以**最高權限**執行（`/RL HIGHEST`），因此登入時會**靜默**以系統管理員啟動（不會每次跳 UAC）。
安裝程式本身以系統管理員執行，故能建立此工作、寫入 `C:\Program Files`。

**背景實例崩潰自動重生**：登入啟動的前台行程會留下當「監管者」，背景代理實例若**異常結束（崩潰）會自動重生**並寫進當日 log
（`背景實例異常結束（code X），2s 後自動重生…`）；短時間內連續崩潰過多才會放棄並記 log。正常關閉（結束／重啟接手）不會重生。

## 常用操作

| 動作 | 方式 |
|---|---|
| 啟動／看狀態 | 點開始功能表（或桌面）「**WMS Device Agent**」捷徑，或直接雙擊 `wms-device-agent.exe`：會跳一次 UAC 按「是」→ 開**狀態視窗**（顯示即時 log）並在背景啟動服務（系統匣圖示）。**已在執行**時再點＝只開狀態視窗看 log，不會重複啟動背景服務。 |
| 關閉狀態視窗 | 按視窗右上角 X（程式繼續在背景執行，系統匣圖示還在） |
| 重啟服務 | **系統匣圖示按右鍵 →「重啟服務」**（乾淨釋放並重連序列埠） |
| 完全結束 | **系統匣圖示按右鍵 →「結束」**（關閉所有相關程序並釋放序列埠）。不得已才用工作管理員結束 `wms-device-agent.exe` |
| 看 log | 開「**文件\wms-device-agent\logs\**」裡的當日 `wms-agent-YYYY-MM-DD.log`（＝狀態視窗內容的精選記錄，每天一個、永久保留不自動清除）。log 目錄可用 `config.json` 的 `logDir` 指定（留空＝寫在「文件\wms-device-agent\logs」） |
| 查裝置狀態 | 瀏覽器開 `http://127.0.0.1:8788/devices`（顯示各裝置連線狀態、WS 連線數、認領數） |
| 升級版本 | 直接執行新的 `setup.exe`（見下方「更新版本」） |
| 解除安裝 | 「設定 → 應用程式」找到「WMS Device Agent」按解除安裝（會自動停止、取消開機自動啟動，並**完整清除**所有相關檔案：`config.json`、安裝目錄，以及「文件\wms-device-agent\」下的 log） |

## 更新版本

1. 拿到新的 `wms-device-agent-setup-<新版本>.zip`，解壓出裡面的 `setup.exe`。
2. 直接**雙擊執行**（UAC 按「是」），一路 Next → Install → Finish。
   安裝程式會自動：停止舊版（含監管者）→ 換上新版 → **保留現有 `config.json`** → 重新啟動。
3. 開 `http://127.0.0.1:8788/health` 確認 `version` 已是新版本。

> 不需要先解除安裝舊版；相同安裝程式偵測到既有版本會直接就地升級。
> 現場改過的 `config.json` 會被保留（安裝程式對它用 `onlyifdoesntexist`）。

## 疑難排解

| 症狀 | 解法 |
|---|---|
| 啟動後馬上結束 | log 出現「應用程式發生錯誤」多半是 `config.json` 格式錯誤——請檢查該檔 JSON 是否正確。8788 埠被占用時會自動重試並「接管」殘留的舊實例（強制結束仍占用埠的另一個 `wms-device-agent.exe`），無需手動處理。 |
| 重啟後埠一直被占用 | 新版已在啟動時自動結束殘留的舊實例並接手（連同其卡住的序列埠一併釋放）。若仍發生，代表占用者不是本程式——請用工作管理員查是哪個程序占用。 |
| log 出現「無法載入 serialport / node-hid / nut.js」 | `node_modules` 沒跟著 exe 一起搬，或被防毒隔離。重新執行安裝程式修復。 |
| 掃碼槍/電子秤沒反應 | 見專案 README 的「掃碼槍」「電子秤」「疑難排解」章節（模式設定、VID、`Cannot lock port`）。 |
| 無認領時掃碼沒打字 | 確認程式是以登入使用者身分執行（不是服務/SYSTEM）；`config.json` 的 `keyboard.enabled` 為 `true`。 |
| 防火牆詢問 | 程式只綁 `127.0.0.1`（本機），不需對外開放；拒絕入站規則也能正常運作。 |

## 重建與打包

`pnpm package:win`（`packaging/windows/build-win.sh`）在 macOS/Linux 上跨平台產生一個
**安裝程式建置包（kit）zip**：`wms-device-agent-installer-<版本>.zip`，內含

```
wms-device-agent-installer/
  wms-device-agent.iss          ← 已內建版本號、payload 就在隔壁
  payload/                      ← 安裝時實際安裝的檔案（exe / node_modules / config / 腳本 / 文件）
```

原生模組以 prebuilt 跨平台取得、不需編譯。要得到最終 `setup.exe` 有三種方式：

**A) macOS/Linux 本機一鍵直出（用 Docker，最方便）**

```
pnpm package:win
```

會先產 kit，再用 Docker 影像 `amake/innosetup`（內含 Wine + Inno Setup）編譯，
**只**把單一成品放到專案根目錄：`wms-device-agent-setup-<版本>.zip`（內含一支 `setup.exe`）。
本機只需 Docker，**不必安裝 Wine 或 Inno Setup**。（壓成 zip 是因為 email／雲端硬碟／防毒常直接攔截裸 `.exe` 附件。）
（只要可攜 kit、不要編譯：`pnpm package:win:kit`（產 `wms-device-agent-installer-<版本>.zip`）；單獨編譯已存在的 kit：`bash packaging/windows/compile-installer.sh`。）

**B) 在 Windows 上編譯**（無 Docker 時）

```
1) 開發機跑 pnpm package:win:kit  →  產出可攜的 wms-device-agent-installer-<版本>.zip
2) 拿到 Windows 解壓縮，進入 wms-device-agent-installer\ 執行：ISCC wms-device-agent.iss（零參數）
3) 產出 wms-device-agent-installer\Output\wms-device-agent-setup-<版本>.exe
```

**C) CI 自動化**：推 `v*` tag 或手動觸發 `.github/workflows/build-windows-installer.yml`，
單一 Linux job 跑 `pnpm package:win`（含 Docker 編譯），把 `setup.exe` 上傳為 artifact。

不論哪種方式，最終 `setup.exe` 都是**獨立安裝程式**：使用者解壓後雙擊即可安裝，不需 Node、
不需 Inno Setup、不需其他工具。方式 A 已自動壓成 zip 交付（避開 email／防毒對裸 `.exe` 的攔截）。
（`.iss` 內的中文說明檔名以 ASCII 來源 + `DestName` 還原，並以 UTF-8 BOM 儲存，Inno 於 Wine 下才能正確打包。）
