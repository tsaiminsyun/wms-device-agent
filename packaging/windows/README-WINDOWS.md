# wms-device-agent — Windows 部署說明

本資料夾是打包好的獨立版本：**不需要安裝 Node.js**，解壓即可執行。
解壓 zip 後會得到**單一資料夾**（`wms-device-agent-<版本>-win-x64`），所有檔案都在裡面（不會散落在桌面）。

## 內容物

| 檔案 | 說明 |
|---|---|
| `wms-device-agent.exe` | 主程式（內含 Node.js 執行環境與應用程式碼） |
| `node_modules/` | 裝置原生模組（serialport / node-hid / nut.js）與工作列圖示 helper（systray2），**必須與 exe 放同一層** |
| `config.json` | 設定檔（部署時修改，見下） |
| `start-agent.bat` | 手動啟動：開啟**狀態視窗**（顯示即時 log）＋系統匣圖示 |
| `install-autostart.bat` | 註冊「登入時自動啟動」（無視窗，只有系統匣圖示）並立即啟動 |
| `uninstall-autostart.bat` | 移除自動啟動並停止程式 |
| `update-agent.bat` | 一鍵更新到新版（保留 `config.json`，見下方「更新版本」） |
| `run-agent.bat` / `run-hidden.vbs` | 內部（自動啟動）用，**不用手動執行** |

## 快速開始

1. 把整個資料夾複製到固定位置（例 `C:\wms-device-agent\`）。**不要只複製 exe**——`node_modules` 與 `config.json` 必須跟著。
2. 編輯 `config.json`：把正式 WMS 網址加進 `security.allowedOrigins`。
3. 雙擊 `wms-device-agent.exe`（或 `start-agent.bat`）啟動——會開一個**狀態視窗**顯示即時 log，
   同時在右下角**系統匣**出現**橘色包裹圖示**。
4. 瀏覽器開 `http://127.0.0.1:8788/health`，看到 `{"status":"ok",...}` 即成功。
5. 要開機（登入）自動啟動：雙擊 `install-autostart.bat`（開機自動啟動時不開視窗，只有系統匣圖示）。

> **按 X 不會關掉程式**：狀態視窗右上角的 X 只會關掉「視窗」——程式本體繼續在背景執行，
> 圖示縮到系統匣（看不到就按「^」展開隱藏的圖示）。
>
> **系統匣選單**：在包裹圖示上按右鍵——
> 「**檢視 Log (View Logs)**」會**啟動一個狀態視窗**（即 `wms-device-agent.exe`）顯示即時 log；
> 背景實例仍在執行，所以它只會 tail 同一份 `agent.log`，不會重複啟動背景服務。
> 「**結束程式 (Exit)**」會**完全結束**（關閉狀態視窗、背景實例與工作列 helper 等所有相關程序）並釋放序列埠，
> 下次啟動即自動重新偵測掃碼槍與電子秤，無需任何手動復原。
> 結束時會**清除本次的 log 檔**（`agent.log` 等）；若某個檔仍被占用而當下刪不掉，下次啟動前也會再清一次，
> 因此每次重新啟動都是乾淨的 log。
>
> （進階：設環境變數 `WMS_NO_DETACH=1` 可停用「視窗／背景分離」，回到傳統單行程行為。）

> **SmartScreen 提示**：exe 未簽章（由官方 node.exe 注入程式產生），首次執行 Windows 可能跳出
> 「Windows 已保護您的電腦」——點「其他資訊」→「仍要執行」。

## 自動啟動的設計

`install-autostart.bat` 建立的是**使用者登入時**的排程工作（Task Scheduler，隱藏視窗），
而不是 Windows 服務。這是刻意的：**鍵盤模擬退路需要在使用者桌面工作階段執行**，
Windows 服務（session 0）打不進使用者的視窗。若不需要鍵盤退路、只走 WS，
才可考慮用 [nssm](https://nssm.cc/) 包成服務。

## 常用操作

| 動作 | 方式 |
|---|---|
| 手動啟動／看狀態 | 雙擊 `wms-device-agent.exe`（已在執行時只會再開一個狀態視窗，不會重複啟動） |
| 關閉狀態視窗 | 按視窗右上角 X（程式繼續在背景執行，系統匣圖示還在） |
| 停止 | **系統匣圖示按右鍵 →「結束程式 (Exit)」**（正常關閉方式）。不得已才用工作管理員結束 `wms-device-agent.exe` |
| 看 log | 開 `agent.log`。預設只記錄四類重點：啟動、裝置初始化（電子秤／掃碼槍 CDC／HID）、掃到的條碼值、改走鍵盤模擬。**需要完整診斷 log（含錯誤與警告）時**把 `config.json` 的 `logLevel` 改成 `"debug"` 後重啟 |
| 查裝置狀態 | 瀏覽器開 `http://127.0.0.1:8788/devices` |
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
| 啟動後馬上結束 | 看 `agent.log`：多半是 `config.json` 格式錯誤（訊息會列出欄位）。8788 埠被占用時會自動重試並「接管」殘留的舊實例（強制結束仍占用埠的另一個 `wms-device-agent.exe`），無需手動處理。 |
| 重啟後埠一直被占用 | 新版已在啟動時自動結束殘留的舊實例並接手（連同其卡住的序列埠一併釋放）。若仍發生，代表占用者不是本程式——`agent.log` 會指出占用埠的 PID。 |
| log 出現「無法載入 serialport / node-hid / nut.js」 | `node_modules` 沒跟著 exe 一起搬，或被防毒隔離。整個資料夾重新解壓。 |
| 掃碼槍/電子秤沒反應 | 見專案 README 的「掃碼槍」「電子秤」「疑難排解」章節（模式設定、VID、`Cannot lock port`）。 |
| 無認領時掃碼沒打字 | 確認程式是以登入使用者身分執行（不是服務/SYSTEM）；`config.json` 的 `keyboard.enabled` 為 `true`。 |
| 防火牆詢問 | 程式只綁 `127.0.0.1`（本機），不需對外開放；拒絕入站規則也能正常運作。 |

此包由 `pnpm package:win`（`packaging/windows/build-win.sh`）產生；重建與維護方式見專案 README。
