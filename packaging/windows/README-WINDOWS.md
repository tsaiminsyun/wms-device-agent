# wms-device-agent — Windows 部署說明

本資料夾是打包好的獨立版本：**不需要安裝 Node.js**，解壓即可執行。

## 內容物

| 檔案 | 說明 |
|---|---|
| `wms-device-agent.exe` | 主程式（內含 Node.js 執行環境與應用程式碼） |
| `node_modules/` | 裝置原生模組（serialport / node-hid / nut.js），**必須與 exe 放同一層** |
| `config.json` | 設定檔（部署時修改，見下） |
| `start-agent.bat` | 手動啟動（輸出寫入 `agent.log`） |
| `install-autostart.bat` | 註冊「登入時自動啟動」並立即啟動 |
| `uninstall-autostart.bat` | 移除自動啟動並停止程式 |
| `update-agent.bat` | 一鍵更新到新版（保留 `config.json`，見下方「更新版本」） |
| `run-hidden.vbs` | 供排程工作以隱藏視窗啟動（不用手動執行） |

## 快速開始

1. 把整個資料夾複製到固定位置（例 `C:\wms-device-agent\`）。**不要只複製 exe**——`node_modules` 與 `config.json` 必須跟著。
2. 編輯 `config.json`：把正式 WMS 網址加進 `security.allowedOrigins`。
3. 雙擊 `start-agent.bat` 啟動（或直接雙擊 exe；用 bat 會留下 `agent.log` 方便排錯）。
4. 瀏覽器開 `http://127.0.0.1:8788/health`，看到 `{"status":"ok",...}` 即成功。
5. 要開機（登入）自動啟動：雙擊 `install-autostart.bat`。

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
| 手動啟動 | 雙擊 `start-agent.bat` |
| 停止 | 工作管理員結束 `wms-device-agent.exe`，或 `taskkill /IM wms-device-agent.exe /F` |
| 看 log | 開 `agent.log`（需要更多細節時把 `config.json` 的 `logLevel` 改成 `"debug"` 後重啟） |
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
| 啟動後馬上結束 | 看 `agent.log`：多半是 `config.json` 格式錯誤（訊息會列出欄位）或 8788 埠被占用。 |
| log 出現「無法載入 serialport / node-hid / nut.js」 | `node_modules` 沒跟著 exe 一起搬，或被防毒隔離。整個資料夾重新解壓。 |
| 掃碼槍/電子秤沒反應 | 見專案 README 的「掃碼槍」「電子秤」「疑難排解」章節（模式設定、VID、`Cannot lock port`）。 |
| 無認領時掃碼沒打字 | 確認程式是以登入使用者身分執行（不是服務/SYSTEM）；`config.json` 的 `keyboard.enabled` 為 `true`。 |
| 防火牆詢問 | 程式只綁 `127.0.0.1`（本機），不需對外開放；拒絕入站規則也能正常運作。 |

此包由 `pnpm package:win`（`packaging/windows/build-win.sh`）產生；重建與維護方式見專案 README。
