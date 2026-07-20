# wms-device-agent — Windows 部署說明

本資料夾是打包好的獨立版本：**不需要安裝 Node.js**，解壓即可執行。
解壓 zip 後會得到**單一資料夾**（`wms-device-agent-<版本>-win-x64`），所有檔案都在裡面（不會散落在桌面）。

## 內容物

| 檔案 | 說明 |
|---|---|
| `wms-device-agent.exe` | 主程式（內含 Node.js 執行環境與應用程式碼）；**啟動不開任何視窗**，只在系統匣顯示圖示 |
| `node_modules/` | 裝置原生模組（serialport / node-hid / nut.js）與工作列圖示 helper（systray2），**必須與 exe 放同一層** |
| `config.json` | 設定檔（部署時修改，見下） |
| `start-agent.bat` | 手動啟動（同雙擊 exe；無視窗，只有系統匣圖示） |
| `install-autostart.bat` | 註冊「登入時自動啟動」（無視窗，只有系統匣圖示）並立即啟動 |
| `uninstall-autostart.bat` | 移除自動啟動並停止程式 |
| `update-agent.bat` | 一鍵更新到新版（保留 `config.json`，見下方「更新版本」） |
| `run-agent.bat` / `run-hidden.vbs` | 內部（自動啟動）用，**不用手動執行** |
| `nssm.exe` / `run-tray-hidden.vbs` | 內部（Windows 服務管理器 NSSM／工作列元件）用，**不用手動執行** |
| `logs/` | 每日輪替 log 檔（`wms-agent-YYYY-MM-DD.log`，保留 14 天；服務與工作列元件各寫一份） |

## 快速開始

1. 把整個資料夾複製到固定位置（例 `C:\wms-device-agent\`）。**不要只複製 exe**——`node_modules` 與 `config.json` 必須跟著。
2. 編輯 `config.json`：把正式 WMS 網址加進 `security.allowedOrigins`。
3. 雙擊 `wms-device-agent.exe`（或 `start-agent.bat`）啟動——**不會開任何視窗**，
   只在右下角**系統匣**出現**橘色包裹圖示**（看不到就按「^」展開隱藏的圖示）。
   再次雙擊不會重複啟動（已在執行時直接靜默結束）。
4. 瀏覽器開 `http://127.0.0.1:8788/health`，看到 `{"status":"ok",...}` 即成功。
5. 要開機（登入）自動啟動：雙擊 `install-autostart.bat`。

> **系統匣選單**（在包裹圖示上按右鍵）：
> - 「**開啟 Log**」：開啟 `logs\` 資料夾（每日輪替 `wms-agent-YYYY-MM-DD.log`）。
> - 「**連線狀態**」：以瀏覽器開啟 `http://127.0.0.1:8788/devices`（掃碼槍／電子秤即時狀態）。
> - 「**重啟服務**」：優雅關閉（釋放序列埠）後自動重新啟動——裝置異常時的一鍵復原。
> - 「**結束**」：**完全結束**（含背景實例與工作列 helper）並釋放序列埠；
>   下次啟動自動重新偵測掃碼槍與電子秤，無需手動復原。結束時會清除本次的 `agent.log`。
>
> （進階：設環境變數 `WMS_NO_DETACH=1` 可停用「啟動器／背景實例分離」，回到單行程直跑。）

> **SmartScreen 提示**：exe 未簽章（由官方 node.exe 注入程式產生），首次執行 Windows 可能跳出
> 「Windows 已保護您的電腦」——點「其他資訊」→「仍要執行」。

## Windows 服務版（建議：用安裝程式部署）

`wms-device-agent-setup.exe`（Inno Setup 安裝程式）會自動完成整套部署：

1. 檔案安裝到 `C:\Program Files\WMS Device Agent\`（升級時**保留現有 `config.json`**）。
2. 以 **NSSM**（隨附 `nssm.exe`）註冊 **Windows 服務 `WMSDeviceAgent`**：**開機自動啟動**（不必等使用者登入）、
   代理異常結束時 **NSSM 自動重啟**（節流 5s），並加上 **SCM 復原設定**與一般使用者啟停授權（重啟服務免 UAC）。
3. 寫入 HKLM Run 機碼：**每位使用者登入時自動啟動工作列元件**（`wms-device-agent.exe --tray`，
   經 `wscript` 隱藏啟動，**完全沒有主控台視窗**）。

服務模式下**沒有任何視窗**，所有狀態與錯誤都寫進 `logs\wms-agent-YYYY-MM-DD.log`（每日輪替、保留 14 天）。

**工作列元件選單**（右下角包裹圖示按右鍵）：
- 「**開啟 Log**」：開啟 `logs\` 資料夾（每日輪替 log 檔）。
- 「**連線狀態**」：以瀏覽器開啟 `http://127.0.0.1:8788/devices`（掃碼槍／電子秤即時連線狀態）。
- 「**重啟服務**」：重新啟動 `WMSDeviceAgent` 服務（裝置異常時的一鍵復原；安裝時已授權，不跳 UAC）。
- 「**關閉圖示**」：只關閉圖示；服務仍在背景執行。

**鍵盤模擬的去向**：服務跑在 session 0，打不進使用者桌面——離線掃碼的鍵盤輸入改由**工作列元件**
在使用者桌面代打（服務經 WebSocket 把條碼委派給它，斷線自動重連）。因此**要用鍵盤模擬就必須讓
工作列元件在登入後執行**（安裝程式已設好）。掃碼槍拔插／斷線由服務自動重試偵測，不會造成服務結束。

**手動控制**：`sc stop WMSDeviceAgent`／`sc start WMSDeviceAgent`；
解除安裝（控制台移除程式）會自動停止並移除服務。
（進階：`wms-device-agent.exe --install-service`／`--uninstall-service` 可手動註冊/解除，需系統管理員。）

**編譯安裝程式**（開發機）：先 `pnpm package:win` 產生 `dist-win/wms-device-agent/`，
再於 Windows 用 [Inno Setup 6](https://jrsoftware.org/isinfo.php) 編譯：
`iscc /DMyAppVersion=<版本> packaging\windows\installer.iss` → `dist-win\wms-device-agent-setup.exe`。

## 自動啟動的設計（免安裝 zip 版）

`install-autostart.bat` 建立的是**使用者登入時**的排程工作（Task Scheduler，隱藏視窗），
而不是 Windows 服務：單行程模式下**鍵盤模擬退路需要在使用者桌面工作階段執行**，
Windows 服務（session 0）打不進使用者的視窗。需要「開機即啟動、不等登入」時，
請改用上方的**安裝程式（服務版）**——它以「服務＋工作列元件」拆開解決了鍵盤模擬的限制。

## 常用操作

| 動作 | 方式 |
|---|---|
| 手動啟動 | 雙擊 `wms-device-agent.exe`（無視窗；已在執行時不會重複啟動） |
| 停止 | **系統匣圖示按右鍵 →「結束」**（正常關閉方式）。不得已才用工作管理員結束 `wms-device-agent.exe` |
| 重啟（裝置異常） | 系統匣 →「**重啟服務**」（釋放序列埠後自動重新啟動） |
| 看 log | 系統匣 →「**開啟 Log**」：`logs\wms-agent-YYYY-MM-DD.log`（每日輪替、保留 14 天；**錯誤與警告一律寫入**）。預設精選模式只記四類重點：啟動、裝置初始化、條碼值、改走鍵盤模擬；要完整診斷 log 把 `config.json` 的 `logLevel` 改成 `"debug"` 後重啟 |
| 查裝置狀態 | 系統匣 →「**連線狀態**」（或瀏覽器開 `http://127.0.0.1:8788/devices`） |
| 升級版本 | 用 `update-agent.bat`（見下方「更新版本」），不要手動覆蓋 |

## 更新版本

1. 把新版 zip（`wms-device-agent-<版本>-win-x64.zip`）放到這台電腦的「**下載**」資料夾。
2. 雙擊安裝資料夾裡的 **`update-agent.bat`**（或直接把 zip **拖曳到它上面**）。
   腳本會自動：停止舊版 → 備份並保留現有 `config.json` → 解壓覆蓋 → 重新啟動。
3. 開 `http://127.0.0.1:8788/health` 確認 `version` 已是新版本。

> 不要手動「解壓全部覆蓋」——那會把現場改過的 `config.json` 蓋回預設值。
> 更新前的設定會另存一份 `config.json.bak` 以備回復。

## 疑難排解

| 症狀 | 解法 |
|---|---|
| 啟動後馬上結束 | 看 `agent.log`：多半是 `config.json` 格式錯誤（訊息會列出欄位）。8788 埠被占用時會自動「接管」舊實例：先請它優雅關閉（乾淨釋放 COM 埠），逾時才強制結束，無需手動處理。 |
| 重啟後埠一直被占用 | 新版啟動時會自動接手殘留的舊實例（優雅關閉優先，序列埠一併乾淨釋放）。若仍發生，代表占用者不是本程式——`agent.log` 會指出占用埠的 PID。 |
| log 出現「無法載入 serialport / node-hid / nut.js」 | `node_modules` 沒跟著 exe 一起搬，或被防毒隔離。整個資料夾重新解壓。 |
| 掃碼槍/電子秤沒反應 | 見專案 README 的「掃碼槍」「電子秤」「疑難排解」章節（模式設定、VID、`Cannot lock port`）。 |
| 重啟程式後電子秤連不上（log 出現 `SetCommState` 錯誤） | CH340 驅動卡死。程式會自動重啟該 USB 裝置（等同重插；**服務版**以 SYSTEM 執行可自動復原）。手動啟動（zip 版）無管理員權限時，依 log 提示重插 USB 即可恢復。 |
| 無認領時掃碼沒打字 | 確認程式是以登入使用者身分執行（不是服務/SYSTEM）；`config.json` 的 `keyboard.enabled` 為 `true`。 |
| 防火牆詢問 | 程式只綁 `127.0.0.1`（本機），不需對外開放；拒絕入站規則也能正常運作。 |

此包由 `pnpm package:win`（`packaging/windows/build-win.sh`）產生；重建與維護方式見專案 README。
