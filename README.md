# wms-device-agent

WMS 本機**裝置代理**：在操作員電腦（部署目標 Windows）上背景執行，把**掃碼槍**、**電子秤**等 USB 設備的訊號透過 **WebSocket** 即時轉送給 WMS 網頁端，並提供 **HTTP API** 查詢設備連線狀態。

沒有任何 WMS 頁面在前景時（操作員在 Excel / FedEx / Teams…），代理走**交警模式**退路：用系統鍵盤模擬（nut.js）把條碼「打字」進目前 OS 焦點的輸入框——所以掃碼槍在任何 app 都能用。

> 把裝置存取從瀏覽器（WebHID / Web Serial）搬到本機常駐服務，讓 WMS 任一頁面透過單一 WS 連線收到全域設備訊號，不再受限於單一分頁的瀏覽器授權。

---

## 快速開始

前置：已安裝 [mise](https://mise.jdx.dev/)（管理 Node 版本）與 [pnpm](https://pnpm.io/)。

```bash
git clone <repo-url> && cd wms-device-agent
mise install     # 安裝 mise.toml 釘選的 Node 22
pnpm install     # 安裝相依
pnpm dev         # 開發模式（tsx watch，讀實體裝置）
```

啟動成功會看到（預設 log 只留重點事件）：

```
2026/07/16 09:00:00 [agent] wms-device-agent v0.1.0 已啟動
2026/07/16 09:00:02 [agent:ScannerDriver] 掃碼槍（CDC）已初始化：COM5
2026/07/16 09:00:02 [agent:ScaleDriver] 電子秤已初始化：COM3
```

驗證：`curl http://127.0.0.1:8788/health` 應回 `{"status":"ok", ...}`。

---

## 架構

```
  實體設備（USB）              wms-device-agent（本機，127.0.0.1）
 ┌───────────────┐  serial   ┌─────────────────────────────────────────────────┐
 │ 掃碼槍(CDC)   │ ────────► │ ScannerDriver ─ scan ─► TrafficCop ┐              │
 │ 電子秤(9600)  │ ────────► │ ScaleDriver ┐                      ├─有認領► WsServer ─► WMS 前景頁面
 └───────────────┘           │             └ weight/status ───────┴─無認領► nut.js 鍵盤 ─► OS 焦點
                             │ HTTP：GET /health、GET /devices                  │
                             └─────────────────────────────────────────────────┘
```

HID-POS 模式的掃碼槍走 `HidScannerDriver`（node-hid），輸出同樣的 `scan` 事件，路徑相同。

**訊號流**：驅動（`devices/`）解析硬體 → emit 到 `DeviceBus` → `TrafficCop`（scan）與 `WsServer`（weight/status）訂閱。驅動不認識伺服器、伺服器不碰硬體，中間只隔一個 bus。

### 交警模式（焦點認領）

掃碼槍也會用在 Excel、FedEx、Teams 等 app，而代理無法分辨瀏覽器目前在哪個分頁，因此由**頁面自己**在前景時「認領」掃碼：

```
掃到 barcode：
  有 WMS 頁面持有有效焦點認領 → 透過 WS 只送給認領者
  否則                        → nut.js 打進目前 OS 焦點輸入框（＋Enter）
```

- 切到其他 app → 頁面失焦、釋放認領 → 掃碼自動退回鍵盤。
- `scan` 由 TrafficCop **擇一**路由（WS 或鍵盤），不會雙觸發；`weight` / `device-status` 一律廣播。
- 認領帶 **TTL 6 秒**：頁面需定期續約，當機停止續約即逾時失效、掃碼退回鍵盤。

---

## 需求與安裝

| 工具 | 用途 | 版本 |
|---|---|---|
| [mise](https://mise.jdx.dev/) | 管理 Node 版本 | 任意近期版 |
| Node.js | 執行環境 | **22**（釘選於 [mise.toml](mise.toml)） |
| [pnpm](https://pnpm.io/) | 套件管理器 | 任意近期版 |

pnpm 預設封鎖相依的安裝腳本；本 repo 已在 [pnpm-workspace.yaml](pnpm-workspace.yaml) 的 `allowBuilds` 核准 `esbuild`、`@serialport/bindings-cpp`、`node-hid`，故 `pnpm install` 可直接成功。

**選用原生相依**（optionalDependencies）：無法編譯時仍能安裝並啟動，只是對應功能停用（啟動 log 告警一次）：

| 相依 | 功能 | 載入失敗 |
|---|---|---|
| `serialport` | 序列掃碼槍（CDC）、電子秤 | 實體序列裝置停用 |
| `node-hid` | HID-POS 掃碼槍 | HID 掃碼槍停用 |
| `@nut-tree-fork/nut-js` | 鍵盤模擬退路 | 無認領時掃碼丟棄 |

---

## 執行

| 指令 | 說明 |
|---|---|
| `pnpm dev` | 開發模式（tsx watch，改檔自動重啟） |
| `pnpm build` | tsc 編譯到 `dist/` |
| `pnpm start` | 執行 `dist/index.js` |
| `pnpm test` / `pnpm test:watch` | 單元測試（vitest） |
| `pnpm typecheck` | 型別檢查 |
| `pnpm package:win` | 打包 Windows 單機版 exe |

預設端點：`http://127.0.0.1:8788/health`、`/devices`、`ws://127.0.0.1:8788/ws`。
停止：`Ctrl+C` 會優雅關閉（先停驅動、關 WS、再關 HTTP）。

---

## 設定

優先序：**程式內預設 → 執行目錄 `config.json` → 環境變數**（環境變數最高）。由 [src/config.ts](src/config.ts) 的 zod schema 驗證，非法值啟動即報錯；schema 未定義的鍵會被靜默忽略（改設定沒生效先檢查鍵名）。

### 環境變數

範例見 [.env.example](.env.example)。程式**不會自動讀 `.env`**——用系統環境變數，或 `node --env-file=.env dist/index.js`。

| 環境變數 | 說明 | 預設 |
|---|---|---|
| `HOST` / `PORT` | 綁定位址（保持本機）／HTTP+WS 共用埠 | `127.0.0.1` / `8788` |
| `WMS_ALLOWED_ORIGINS` | 允許的網頁 Origin（逗號分隔） | `http://localhost:5173,http://localhost:3000` |
| `ALLOW_NO_ORIGIN` | 允許無 Origin 連線（curl 等）；正式建議 `false` | `true` |
| `KEYBOARD_ENABLED` | 鍵盤模擬退路（`0` 全關） | `1` |
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` | `info` |

### config.json

複製 [config.example.json](config.example.json) 成 `config.json` 放在**執行目錄**即可覆寫。

| 區段.欄位 | 說明 | 預設 |
|---|---|---|
| `server.host` / `.port` / `.wsPath` | 綁定位址／埠／WS 路徑 | `127.0.0.1` / `8788` / `/ws` |
| `security.allowedOrigins` | Origin 白名單（大小寫、尾斜線容錯） | localhost:5173、:3000 |
| `security.allowNoOrigin` | 允許無 Origin 連線 | `true` |
| `scanner.enabled` / `.baudRate` / `.path` | CDC 掃碼槍開關／速率／強制埠 | `true` / `9600` / `null` |
| `scanner.vendorIds` | 認埠的 USB VID（hex） | `["05e0"]`（Zebra/Symbol） |
| `scanner.keyboardFallback` | 無認領時走鍵盤退路 | `true` |
| `hidScanner.enabled` / `.vendorIds` | HID-POS 掃碼槍開關／VID | `true` / `["05e0"]` |
| `hidScanner.usagePages` | 允許的 usage page；**空陣列＝接受該廠牌任何非鍵盤/滑鼠 collection** | `[]` |
| `hidScanner.reportHeaderBytes` | 解析 report 跳過的表頭位元組數（依機型校準，見下） | `4` |
| `scale.enabled` / `.baudRate` / `.path` | 電子秤開關／速率／強制埠 | `true` / `9600` / `null` |
| `scale.vendorIds` | 認埠的 USB-serial 晶片 VID；空陣列＝接受所有非掃碼槍序列埠 | CH340/FTDI/CP210x/PL2303 |
| `serial.pollIntervalMs` | 熱插拔輪詢間隔（序列與 HID 共用，最小 500） | `2000` |
| `keyboard.enabled` / `.pressEnter` | 鍵盤模擬總開關／打完補 Enter | `true` / `true` |
| `logLevel` | log 等級 | `"info"` |

> **Log 等級**：預設（`info`）只輸出重點事件——啟動、裝置初始化、掃到的條碼值、鍵盤模擬退路。需要完整診斷（含錯誤/警告與原始 report）時設 `logLevel: "debug"`。

---

## HTTP API

### `GET /health`
```json
{ "status": "ok", "name": "wms-device-agent", "version": "0.1.0",
  "platform": "win32", "protocolVersion": 1, "uptimeMs": 12345, "ts": 1782092474634 }
```

### `GET /devices`
```json
{
  "ts": 1782092474641, "wsClients": 1, "wsClaimingClients": 1, "connectedCount": 2,
  "devices": [
    { "deviceId": "scanner-1", "deviceName": "掃碼槍", "kind": "scanner",
      "status": "connected", "detail": "Zebra/Symbol (05e0:1200)", "since": 1782092474457 },
    { "deviceId": "scale-1", "deviceName": "電子秤", "kind": "scale",
      "status": "connected", "detail": "CH340 (1a86:7523)", "since": 1782092474457 }
  ]
}
```
`status`：`connecting` | `connected` | `removed` | `error`。不在白名單的 Origin 一律回 `403`；無 Origin 的本機工具由 `ALLOW_NO_ORIGIN` 控制。

---

## WebSocket 協定（v1）

連線 `ws://127.0.0.1:8788/ws`；每則訊息為 JSON，含信封 `{ v, type, ts, ... }`。

**伺服器 → 用戶端**

| type | 說明 | 主要欄位 |
|---|---|---|
| `welcome` | 連上第一則 | `agent{...}`, `devices[]`（快照） |
| `scan` | 掃到條碼（只送認領者） | `deviceId`, `deviceName`, `barcode` |
| `weight` | 秤重讀數 | `deviceId`, `kg`, `stable` |
| `device-status` | 設備連線狀態變化 | `deviceId`, `kind`, `status`, `detail` |
| `pong` / `ack` / `error` | ping 回應／指令確認／錯誤 | `echo` / `ref` / `code,message,ref` |

**用戶端 → 伺服器**

| type | 說明 |
|---|---|
| `{ "type":"focus", "active":true\|false }` | **焦點認領**：前景時送 `true` 認領掃碼、失焦送 `false` 釋放，需定期續約 |
| `{ "type":"ping", "t":<number?> }` | 量延遲；回 `pong{echo:t}` |
| `{ "type":"subscribe", "topics":[...] }` | 只訂閱部分 topic（預設全收） |

心跳由伺服器以 WS ping/pong frame 偵測死連線，用戶端**不需**自送。

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

> 多分頁：`weight` / `device-status` 廣播給所有分頁，`scan` 只送認領中的分頁。多個 WMS 分頁同時可見時，建議沿用前端既有的多分頁協調（如 Web Locks 選唯一 leader 再認領）。

---

## 掃碼槍：三種模式

掃碼槍（Zebra/Symbol，VID `05e0`）的 USB 主機模式決定 agent 走哪條路：

| 模式 | agent 讀取 | 能否經 WS / 交警模式 |
|---|---|---|
| **HID-POS / IBM Hand-Held**（usage page `0x8c`） | `HidScannerDriver`（node-hid） | ✅ |
| **CDC（虛擬 COM）** | `ScannerDriver`（serialport） | ✅ |
| **HID 鍵盤（出廠預設，usage page `0x1`）** | ❌ 讀不到（OS 保護鍵盤） | ❌ 直接當鍵盤打字 |

兩個掃碼槍驅動可同時啟用互不衝突（掃碼槍一次只在一種模式）。切到 HID-POS 或 CDC 後即經 agent，由焦點認領決定走 WS 或鍵盤模擬；維持出廠鍵盤模式則不經 agent。

- **HID-POS**：掃手冊的 `USB IBM Hand-Held`（或 HID-POS）條碼；`usagePage` 變 `0x8c`，agent 依 `hidScanner.vendorIds` 接管。
- **CDC**：掃 `USB CDC Host`；系統新增 COM 埠（VID `05E0`），終止符建議 CR/CRLF，agent 依 `scanner.vendorIds` 認埠（或 `scanner.path` 強制）。
- **校準 `reportHeaderBytes`（HID-POS）**：`LOG_LEVEL=debug` 執行，掃一次會印原始 report；數條碼字元前的位元組數，設成該值（預設 4）。

---

## 電子秤協定

預設假設（A&D / CAS / Mettler 桌秤常見）：**9600 8N1**，每行如 `ST,GS,+ 7.16 kg`（`ST`=穩定 / `US`=不穩 / `OL`=過載）。協定不同改 `scale.baudRate` 與 [parseScaleLine](src/parsing/scaleProtocol.ts)。

辨識：先以晶片 VID 選埠，開埠後**先中性顯示**（「序列裝置（待辨識）」），待資料指紋（`ST/US/OL` 或 `數字+kg/g`）命中才升級為「電子秤」並送 `weight`，避免誤標非秤裝置。

---

## 安全性

- **只綁 `127.0.0.1`**，不對區網開放。
- **Origin 白名單**：WS upgrade 與 HTTP 皆檢查 `Origin`，不在白名單者拒絕（WS 403 後關閉、HTTP 403）。

> WMS 以 https 提供時，瀏覽器連 `ws://localhost` 多數環境視為 potentially-trustworthy 而允許；若被擋需改 `wss`（本版未內建）。

---

## 專案結構

```
src/
  index.ts                進入點：載入設定、組裝驅動/伺服器、啟動、優雅關閉
  config.ts               設定載入＋zod 驗證
  logger.ts               極簡分級 logger（預設精選事件，debug 顯示全部）
  TrafficCop.ts           交警模式仲裁：scan 走 WS 或鍵盤退路
  core/                   types / DeviceBus（事件匯流排）/ DeviceManager（驅動生命週期+狀態快照）
  parsing/                純函式解析：LineFramer / scaleProtocol / hidPosReport（皆有測試）
  devices/
    hotplug.ts            熱插拔共用：PollLoop / RetryCooldown
    serial/               serialLoader（懶載入）、SerialDeviceDriver（序列驅動底座）
    hid/hidLoader.ts      懶載入 node-hid
    ScannerDriver.ts      Zebra CDC 掃碼槍（繼承 SerialDeviceDriver）
    HidScannerDriver.ts   HID-POS 掃碼槍（node-hid，獨立輪詢）
    ScaleDriver.ts        電子秤（繼承 SerialDeviceDriver，指紋辨識）
  keyboard/KeyboardEmulator.ts  nut.js 鍵盤模擬（懶載入、序列化排隊）
  runtime/                nativeRequire（原生相依載入）、detach（Windows 前台/背景分流）、freePort
  server/                 protocol（WS v1）、WsServer、httpApi、origin
test/                     vitest 單元測試
packaging/windows/        SEA 打包腳本、原生相依清單、自動啟動腳本、README-WINDOWS.md
```

---

## 常見維護

**新廠牌掃碼槍 / 新晶片電子秤**：把 USB VID 加進 `config.json` 的 `scanner.vendorIds` / `hidScanner.vendorIds` / `scale.vendorIds`。查 VID：裝置管理員 → 詳細資料 → 硬體識別碼（`VID_XXXX`）；晶片名稱要顯示在 `/devices.detail` 可在 [SerialDeviceDriver.ts](src/devices/serial/SerialDeviceDriver.ts) 的 `SERIAL_CHIPS` 加一筆。

**電子秤協定不同**：改 [src/parsing/scaleProtocol.ts](src/parsing/scaleProtocol.ts) 的 `parseScaleLine()` 與 `hasScaleSignature()`，並在 [test/scaleProtocol.test.ts](test/scaleProtocol.test.ts) 補案例。

**新增序列裝置**：於 [types.ts](src/core/types.ts) 定義事件 → 繼承 [SerialDeviceDriver](src/devices/serial/SerialDeviceDriver.ts) 實作 `selectPort()` 與 `handleLine()` → 於 [index.ts](src/index.ts) 註冊；需送前端則在 [protocol.ts](src/server/protocol.ts) / [WsServer.ts](src/server/WsServer.ts) 加訊息與廣播。

**更新相依 / Node**：`pnpm update` 後必跑 `pnpm typecheck && pnpm test`；Node 升級改 [mise.toml](mise.toml) → `mise install` → 重新 `pnpm install`（原生模組要對新 ABI 重編）。

### 部署到 Windows

**單機版 exe（免裝 Node，建議）**

```bash
pnpm package:win   # 產出 dist-win/ 與 wms-device-agent-<版本>-win-x64.zip
```

解壓到目標機即可執行。內含 `wms-device-agent.exe`、Windows 原生模組（`node_modules/`，須與 exe 同層）、`config.json`、啟動腳本；安裝/自動啟動/排錯見包內 [README-WINDOWS.md](packaging/windows/README-WINDOWS.md)。

原理：Node SEA——app 與純 JS 相依（ws/zod）bundle 後注入官方 `node.exe`；原生模組無法嵌入，由 exe 旁的 `node_modules` 於執行期載入（[nativeRequire.ts](src/runtime/nativeRequire.ts)）。打包腳本自動下載對應版本的 Windows `node.exe`，可在 macOS / Linux / CI 完成。

**更新**：開發機 bump [package.json](package.json) 的 `version` → `pnpm package:win`；目標機把新 zip 拖到 `update-agent.bat`（自動停舊版、保留 `config.json`、覆蓋、重啟）→ 開 `/health` 確認版本。

**已有 Node 的機器**：`pnpm build && pnpm start`。

注意：
- `config.json` 放執行目錄（單機版另找 exe 目錄），設定正式 `security.allowedOrigins`，建議 `ALLOW_NO_ORIGIN=false`。
- **自動啟動用「登入時排程工作」而非 Windows 服務**：鍵盤模擬退路須在使用者桌面工作階段執行，服務（session 0）打不進使用者視窗。單機版附 `install-autostart.bat`。
- 同機**只能跑一個實例**：第二個會搶不到埠（`EADDRINUSE` / `Cannot lock port`）。

---

## 疑難排解

### 安裝 / 啟動

| 症狀 | 解法 |
|---|---|
| `exec: node: not found` | Node 沒裝：`mise install`。 |
| `ERR_PNPM_IGNORED_BUILDS` | 新增帶 build 腳本的原生相依：於 [pnpm-workspace.yaml](pnpm-workspace.yaml) `allowBuilds` 核准。 |
| 原生模組編譯失敗 | 缺工具鏈（Windows：VS Build Tools；macOS：Xcode CLT）。三個原生相依皆選用，裝不起來仍可啟動。 |
| `EADDRINUSE` | 8788 被占用——多半是另一個實例。關掉或改 `PORT`。 |
| 啟動即報「設定驗證失敗」 | `config.json` 有非法值（訊息列出欄位），對照設定表修正。 |

### 掃碼槍

| 症狀 | 解法 |
|---|---|
| log 出現「…但未接管：目前是鍵盤模式」 | 掃碼槍還在出廠鍵盤模式：掃設定條碼切到 HID-POS 或 CDC。 |
| 完全沒偵測到 | VID 不在 `vendorIds`（查後加入）；或 USB 線/埠問題。`LOG_LEVEL=debug` 看列舉。 |
| `Cannot lock port` | 埠被占用（另一實例/序列監看工具）。關掉佔用者，agent 自動重試（5 秒冷卻）；若重啟後仍占用，依提示拔插 USB。 |
| 條碼開頭缺字/亂碼（HID-POS） | `reportHeaderBytes` 沒校準：debug 看原始 report 數表頭。 |
| 掃碼沒進 WMS 頁面 | 頁面沒有效認領：確認前端送 `focus active:true` 並每 2 秒續約。 |
| 掃碼雙重輸入 | 多半是掃碼槍還在**鍵盤模式**（直接打字）＋頁面同時收 WS——切模式即可。 |

### 電子秤

| 症狀 | 解法 |
|---|---|
| 一直顯示「序列裝置（待辨識）」 | 沒收到帶指紋的資料：秤沒開機/沒送資料、`baudRate` 不符、或協定格式不同。 |
| 沒偵測到 | 晶片 VID 不在 `scale.vendorIds`；可加 VID 或設 `[]` 接受所有非掃碼槍序列埠。 |
| 讀數跳動 | 正常：不穩時 `stable:false` 持續更新，穩定判定交前端用 `stable` 欄位。 |

### 鍵盤退路 / WebSocket

| 症狀 | 解法 |
|---|---|
| 無認領時掃碼沒打字 | nut.js 載入失敗會告警；macOS 需在「隱私權 → 輔助使用」授權；確認 `KEYBOARD_ENABLED` 與 `scanner.keyboardFallback` 未關。 |
| WS 連線被拒（403） | Origin 不在白名單：加進 `security.allowedOrigins`。agent log 印被拒的 Origin。 |
| `curl` / `wscat` 連不上 | `ALLOW_NO_ORIGIN=false` 時無 Origin 工具被拒；測試暫設 `true`。 |
| 收得到 `weight` 但收不到 `scan` | 正常：`scan` 只送認領頁面，需送 `focus active:true` 並續約。 |

### 除錯技巧

- `LOG_LEVEL=debug pnpm dev`：印裝置列舉、原始 HID report、每筆讀數與路由決策。
- `curl http://127.0.0.1:8788/devices`：所有裝置狀態、WS 連線數、認領數。
- 測 WS：`npx wscat -c ws://127.0.0.1:8788/ws`（需 `ALLOW_NO_ORIGIN=true`）。
