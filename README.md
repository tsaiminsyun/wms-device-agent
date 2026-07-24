# wms-device-agent

WMS 本機**裝置代理**：在操作員電腦（Windows）背景執行，把**掃碼槍**、**電子秤**等 USB 裝置的訊號透過 **WebSocket** 即時轉送給 WMS 網頁端，並提供 **HTTP API** 查詢連線狀態。

沒有 WMS 頁面在前景時（操作員在 Excel / FedEx / Teams…），代理走**交警模式**退路：用系統鍵盤模擬把條碼「打字」進目前 OS 焦點的輸入框——所以掃碼槍在任何 app 都能用。

---

## 快速開始（開發）

前置：[mise](https://mise.jdx.dev/)（管理 Node）與 [pnpm](https://pnpm.io/)。

```bash
git clone <repo-url> && cd wms-device-agent
mise install     # 安裝 mise.toml 釘選的 Node 22
pnpm install
pnpm dev         # 開發模式（tsx watch，讀實體裝置，顯示 debug log）
```

驗證：`curl http://127.0.0.1:8788/health` 回 `{"status":"ok", ...}`。

| 指令 | 說明 |
|---|---|
| `pnpm dev` | 開發模式（改檔自動重啟、debug log） |
| `pnpm test` / `pnpm typecheck` | 單元測試（vitest）／型別檢查 |
| `pnpm package:win` | 打包 Windows 安裝程式，產出含 `setup.exe` 的 zip（見下） |
| `pnpm release:win` | 版號 patch +1 後打包（`release:win:minor`＝minor +1） |

---

## 打包與發佈（給使用者的 setup.exe）

發佈方式只有一種：**打包出 `setup.exe`，給使用者雙擊安裝**。使用者端不需裝 Node、不需開啟安裝資料夾。

```bash
pnpm package:win     # 產出 wms-device-agent-setup-<版本>.zip（內含單一支 setup.exe）
```

成品是 **zip**（不是裸 exe），因為 email／雲端硬碟／防毒常直接攔截 `.exe` 附件。zip 解開就是一支
`wms-device-agent-setup-<版本>.exe`，使用者解壓後雙擊即可安裝。

`package:win` 在 macOS/Linux 跨平台組出 Windows 酬載，再用 Docker 影像 `amake/innosetup`（Wine + Inno Setup）編成 `setup.exe` 並壓成 zip——本機只需 Docker，不必裝 Wine/Inno。原理：Node SEA——app 與純 JS 相依 bundle 後注入官方 `node.exe`；原生模組（serialport/node-hid/nut.js）由 exe 旁的 `node_modules` 於執行期載入。

### 版號更新

版號的**單一來源**是 [package.json](package.json) 的 `version`。改它、重新 `pnpm package:win`，新版號就會自動帶進三處：exe 的 `/health`、安裝程式、以及成品檔名（`wms-device-agent-setup-<版本>.zip` 與其中的 `.exe`）；狀態視窗開頭也會顯示「wms-device-agent v<版本> 已啟動」。

版號格式 **MAJOR.MINOR.PATCH**（語意化版本）：

| 情況 | 改哪一位 | 例 |
|---|---|---|
| 修 bug、小調整 | PATCH | 1.0.0 → 1.0.**1** |
| 加功能（相容） | MINOR | 1.0.0 → 1.**1**.0 |
| 首個正式版／重大改版 | MAJOR | 0.1.0 → **1**.0.0 |

**操作**（`--no-git-tag-version` 表示只改檔、不建 git tag）：

```bash
# 方式 A：指定確切版號（首個正式版）
npm version 1.0.0 --no-git-tag-version
pnpm package:win

# 方式 B：自動遞增後直接打包
pnpm release:win          # PATCH +1（1.0.0 → 1.0.1）後打包
pnpm release:win:minor    # MINOR +1（1.0.0 → 1.1.0）後打包
```

也可直接手動編輯 [package.json](package.json) 的 `"version"` 再 `pnpm package:win`。打包後開 `http://127.0.0.1:8788/health` 或看狀態視窗即可確認版號已更新。

### 使用者如何更新

把新版 zip 給使用者，解壓後**雙擊 `setup.exe`**（UAC 按「是」→ Next → Install）即就地升級：**不必先解除安裝**、自動停舊版、**保留現場的 `config.json`**、換檔後重新啟動。

> 安裝內容、操作、開機自動啟動與詳細排錯見 **[README-WINDOWS.md](packaging/windows/README-WINDOWS.md)**。

---

## 設定

優先序：**程式內預設 → 執行目錄 `config.json` → 環境變數**（環境變數最高）。由 [src/config.ts](src/config.ts) 的 zod schema 驗證，非法值啟動即報錯。

複製 [config.example.json](config.example.json) 成 `config.json` 放**執行目錄**（安裝版在 `C:\Program Files\wms-device-agent\`，已授權一般使用者可直接編輯）即可覆寫。最常改的：

| 鍵 | 說明 | 預設 |
|---|---|---|
| `security.allowedOrigins` | WMS 網頁 Origin 白名單（正式部署必設） | localhost:5173、:3000 |
| `security.allowNoOrigin` | 允許無 Origin（curl 等）；正式建議 `false` | `true` |
| `scanner.vendorIds` / `hidScanner.vendorIds` | 掃碼槍 USB VID（hex） | `["05e0"]`（Zebra/Symbol） |
| `scale.vendorIds` | 電子秤 USB-serial 晶片 VID；空陣列＝接受所有非掃碼槍序列埠 | CH340/FTDI/CP210x/PL2303 |
| `logLevel` | `debug`/`info`/`warn`/`error` | `info` |

環境變數（見 [.env.example](.env.example)；程式不自動讀 `.env`）：`HOST`/`PORT`、`WMS_ALLOWED_ORIGINS`、`ALLOW_NO_ORIGIN`、`KEYBOARD_ENABLED`、`LOG_LEVEL`、`WMS_LOG_DIR`。

> **log**：安裝版寫在使用者「文件\wms-device-agent\logs\」，只記重要、好懂的事件（啟動、裝置連線／斷線／關機／開機、掃到的條碼、錯誤等）。

---

## HTTP API

`GET /health` → `{ "status":"ok", "name":"wms-device-agent", "version":"1.0.0", "platform":"win32", "protocolVersion":1, ... }`

`GET /devices` → 所有裝置狀態、WS 連線數、認領數：
```json
{ "ts": 0, "wsClients": 1, "connectedCount": 2,
  "devices": [
    { "deviceId": "scanner-1", "deviceName": "掃碼槍", "kind": "scanner", "status": "connected", "detail": "..." },
    { "deviceId": "scale-1",   "deviceName": "電子秤", "kind": "scale",   "status": "connected", "detail": "..." }
  ] }
```
`status`：`connecting` | `connected` | `offline`（無回應／關機） | `error` | `removed`。不在白名單的 Origin 一律 `403`。

---

## WebSocket 協定（v1）

連線 `ws://127.0.0.1:8788/ws`；每則訊息為 JSON，含信封 `{ v, type, ts, ... }`。

**伺服器 → 用戶端**

| type | 說明 | 主要欄位 |
|---|---|---|
| `welcome` | 連上第一則 | `agent{...}`, `devices[]`（快照） |
| `scan` | 掃到條碼（只送認領者） | `deviceId`, `deviceName`, `barcode` |
| `weight` | 秤重讀數 | `deviceId`, `kg`, `stable` |
| `device-status` | 裝置連線狀態變化 | `deviceId`, `kind`, `status`, `detail` |
| `pong` / `ack` / `error` | ping 回應／指令確認／錯誤 | `echo` / `ref` / `code,message,ref` |

**用戶端 → 伺服器**

| type | 說明 |
|---|---|
| `{ "type":"focus", "active":true\|false }` | **焦點認領**：前景時送 `true` 認領掃碼、失焦送 `false` 釋放，需定期續約（TTL 6 秒） |
| `{ "type":"ping", "t":<number?> }` | 量延遲；回 `pong{echo:t}` |
| `{ "type":"subscribe", "topics":[...] }` | 只訂閱部分 topic（預設全收） |

### 交警模式（焦點認領）

掃碼槍也會用在 Excel、FedEx 等 app，代理無法分辨瀏覽器目前在哪個分頁，因此由**頁面自己**在前景時「認領」掃碼：有 WMS 頁面持有有效認領 → 掃碼只經 WS 送給它；否則 → 用鍵盤模擬打進目前 OS 焦點（＋Enter）。`weight` / `device-status` 一律廣播；`scan` 擇一路由不雙送。

### 前端整合範例

頁面在**可見/前景**時認領掃碼（並續約），失焦時釋放：

```js
const ws = new WebSocket("ws://127.0.0.1:8788/ws");
const CLAIM_RENEW_MS = 2000; // 須小於 agent 端 TTL(6s)
let renewTimer = null;

function claim()  { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "focus", active: true })); }
function release(){ clearInterval(renewTimer); renewTimer = null;
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "focus", active: false })); }
function startClaiming() { if (renewTimer) return; claim(); renewTimer = setInterval(claim, CLAIM_RENEW_MS); }
function syncFocus() {
  if (document.visibilityState === "visible" && document.hasFocus()) startClaiming();
  else release();
}
document.addEventListener("visibilitychange", syncFocus);
window.addEventListener("focus", syncFocus);
window.addEventListener("blur", release);
ws.addEventListener("open", syncFocus);

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case "scan":          handleBarcode(msg.barcode); break;
    case "weight":        updateWeight(msg.kg, msg.stable); break;
    case "device-status": updateDeviceStatusBar(msg); break;
  }
};
```

> 多分頁：`weight` / `device-status` 廣播給所有分頁，`scan` 只送認領中的分頁。多個 WMS 分頁同時可見時，建議用前端既有的多分頁協調（如 Web Locks 選唯一 leader 再認領）。

---

## 掃碼槍模式

掃碼槍（Zebra/Symbol，VID `05e0`）的 USB 主機模式決定走哪條路：

- **HID-POS / IBM Hand-Held**（usage page `0x8c`）→ `HidScannerDriver`（node-hid），經 agent ✅
- **CDC（虛擬 COM）** → `ScannerDriver`（serialport），經 agent ✅
- **HID 鍵盤（出廠預設）** → OS 保護讀不到，直接當鍵盤打字 ❌

切到 HID-POS 或 CDC 後即經 agent，由焦點認領決定走 WS 或鍵盤模擬。HID-POS 若條碼開頭缺字/亂碼，用 `LOG_LEVEL=debug` 看原始 report、校準 `hidScanner.reportHeaderBytes`。

電子秤預設 **9600 8N1**，每行如 `ST,GS,+ 7.16 kg`；先以晶片 VID 選埠，待資料指紋（`ST/US/OL` 或 `數字+kg/g`）命中才辨識為電子秤。協定不同改 `scale.baudRate` 與 [scaleProtocol.ts](src/parsing/scaleProtocol.ts)。

---

## 安全性

- **只綁 `127.0.0.1`**，不對區網開放。
- **Origin 白名單**：WS upgrade 與 HTTP 皆檢查 `Origin`，不在白名單者拒絕（403）。
- WMS 以 https 提供時，瀏覽器連 `ws://localhost` 多數環境視為 potentially-trustworthy 而允許。

---

## 疑難排解

| 症狀 | 解法 |
|---|---|
| 掃碼槍完全沒偵測到 | VID 不在 `vendorIds`（`裝置管理員 → 詳細資料 → 硬體識別碼` 查 `VID_XXXX` 後加入）；或還在出廠**鍵盤模式**（掃設定條碼切到 HID-POS/CDC）。 |
| `Cannot lock port` | 埠被占用（另一實例／序列監看工具）。agent 會自動重試並在第一次開埠失敗即嘗試重啟 USB；仍不行依提示拔插 USB。 |
| 電子秤一直「序列裝置（待辨識）」 | 沒收到帶指紋的資料：秤沒開機／`baudRate` 不符／協定不同。 |
| 掃碼沒進 WMS 頁面 | 頁面沒有效認領：確認前端送 `focus active:true` 並每 2 秒續約。 |
| WS 連線被拒（403） | Origin 不在白名單：加進 `security.allowedOrigins`。 |
| 收得到 `weight` 但收不到 `scan` | 正常：`scan` 只送認領頁面。 |

更多除錯：`LOG_LEVEL=debug pnpm dev`（印裝置列舉、原始 report、路由決策）；`curl http://127.0.0.1:8788/devices`。Windows 部署細節見 [README-WINDOWS.md](packaging/windows/README-WINDOWS.md)。
