# wms-device-agent

WMS 本機**裝置代理**：在操作員的電腦（部署目標 Windows）上以背景服務執行，把**掃碼槍**、**電子秤**等 USB 設備的訊號，透過 **WebSocket** 即時轉送給 WMS 網頁端；並提供 **HTTP API** 供網頁查詢設備連線狀態。

當沒有任何 WMS 頁面在前景（操作員在 Excel / UPS / FedEx / Teams…）時，代理走**交警模式**退路：用系統鍵盤模擬（nut.js）把掃到的條碼「打字」進目前作業系統焦點所在的輸入框——所以掃碼槍在任何 app 都能用。

> 本專案把裝置存取從瀏覽器（WebHID / Web Serial）搬到本機常駐服務，讓 WMS 任一頁面都能透過單一 WS 連線收到全域設備訊號，不再受限於單一分頁的瀏覽器授權。

---

## 快速開始

前置：已安裝 [mise](https://mise.jdx.dev/)（管理 Node 版本）與 [pnpm](https://pnpm.io/)。

```bash
git clone <repo-url> && cd wms-device-agent
mise install     # 安裝 mise.toml 釘選的 Node 22（重要：沒裝會出現 node: not found）
pnpm install     # 安裝相依（原生模組 build 腳本已在 pnpm-workspace.yaml 核准）
pnpm dev         # 開發模式啟動（tsx watch，讀實體裝置）
```

啟動成功會看到：

```
INFO  [agent] 驅動已啟動：ScannerDriver(Zebra CDC)
INFO  [agent] 驅動已啟動：ScaleDriver
INFO  [agent] 驅動已啟動：HidScannerDriver(node-hid)
INFO  [agent] wms-device-agent v0.1.0 已啟動（平台 darwin）
INFO  [agent] HTTP 健康檢查：http://127.0.0.1:8788/health
```

驗證：`curl http://127.0.0.1:8788/health` 應回 `{"status":"ok", ...}`。

---

## 架構與運作原理

```
  實體設備（USB）              wms-device-agent（本機，127.0.0.1）
 ┌───────────────┐  serial   ┌───────────────────────────────────────────────┐
 │ 掃碼槍         │ ────────► │ ScannerDriver ─ scan ─► TrafficCop ┐            │
 │（CDC 模式）   │           │                                    ├─有認領► WsServer ─► WMS 前景頁面（WS JSON）
 │ 電子秤        │ ────────► │ ScaleDriver ┐                      └─無認領► nut.js 鍵盤 ─► OS 焦點（Excel/FedEx…）
 │（9600 8N1）   │           │             └ weight/device-status ─► WsServer ─► 所有訂閱頁面
 └───────────────┘           │ HTTP：GET /health、GET /devices（設備連線狀態）
                             └───────────────────────────────────────────────┘
```

（HID-POS 模式的掃碼槍走 `HidScannerDriver`（node-hid），輸出同樣的 `scan` 事件，路徑相同。）

**交警模式核心邏輯（掃碼）— 焦點認領（focus-claim）**：

掃碼槍不只用在 WMS 網頁，也會用在 **Excel、UPS、USPS、FedEx、Teams** 等任意 app。
代理無法分辨瀏覽器目前在哪個分頁（WMS 分頁與 FedEx 分頁同屬一個瀏覽器程序），
因此由**頁面自己**在前景/可見時「認領」掃碼：

```
掃到 barcode：
  IF 有 WMS 頁面持有有效焦點認領（前景且未逾時）
       → 透過 WS 只送給認領者（頁面去打既有 API）
  ELSE（操作員在 Excel / UPS / FedEx / Teams…，或沒開 WMS 頁面）
       → nut.js 模擬鍵盤把字串打進目前 OS 焦點輸入框（＋Enter）
```

- 切到其他 app → WMS 頁面失焦、釋放認領 → 掃碼自動退回鍵盤，所以「掃碼槍到處都能用」。
- `scan` 由 TrafficCop **擇一**決定走 WS 或走鍵盤，**不會雙觸發**（WsServer 不自動廣播 scan）。
- `weight` / `device-status` 不受認領影響，一律廣播給所有訂閱者。
- 認領帶 **TTL（6 秒）**：頁面可見時需定期續約（重送 `focus active:true`）；頁面當機停止續約 → 認領逾時失效 → 掃碼退回鍵盤，不會卡死。

---

## 需求與安裝

| 工具 | 用途 | 版本 |
|---|---|---|
| [mise](https://mise.jdx.dev/) | 管理 Node 版本（進入專案目錄自動切換） | 任意近期版 |
| Node.js | 執行環境 | **22**（釘選於 [mise.toml](mise.toml)，`mise install` 安裝） |
| [pnpm](https://pnpm.io/) | 套件管理器（lockfile：`pnpm-lock.yaml`） | 任意近期版 |

```bash
mise install     # 安裝釘選的 Node 版本（並讓 node 進到 PATH）
pnpm install     # 安裝相依
```

> **pnpm build 腳本核准**：pnpm 預設封鎖相依的安裝腳本。本 repo 已在 [pnpm-workspace.yaml](pnpm-workspace.yaml)
> 的 `allowBuilds` 核准 `esbuild`（tsx/vitest 需要）、`@serialport/bindings-cpp`（serialport 原生繫結）與
> `node-hid`（HID 掃碼槍），故 `pnpm install` 可直接成功，不會出現 `ERR_PNPM_IGNORED_BUILDS`。

**選用原生相依**（optionalDependencies）：`serialport`、`@nut-tree-fork/nut-js`、`node-hid`。
在無法編譯原生模組的環境仍能安裝成功並啟動，只是對應功能停用（啟動 log 會告警一次）：

| 相依 | 提供的功能 | 載入失敗時 |
|---|---|---|
| `serialport` | 序列掃碼槍（CDC）、電子秤 | 實體序列裝置停用 |
| `node-hid` | HID-POS 掃碼槍 | HID 掃碼槍停用 |
| `@nut-tree-fork/nut-js` | 鍵盤模擬退路 | 無認領時掃碼丟棄（不打字） |

---

## 執行

| 指令 | 說明 |
|---|---|
| `pnpm dev` | 開發模式（tsx watch，改檔自動重啟，讀實體裝置） |
| `pnpm build` | 以 tsc 編譯到 `dist/` |
| `pnpm start` | 執行編譯後的 `dist/index.js`（正式環境） |
| `pnpm test` | 單元測試（vitest，一次跑完） |
| `pnpm test:watch` | 單元測試（watch 模式） |
| `pnpm typecheck` | 型別檢查（`tsc --noEmit`） |

啟動後預設端點：

- HTTP 健康檢查：`http://127.0.0.1:8788/health`
- HTTP 設備狀態：`http://127.0.0.1:8788/devices`
- WebSocket：`ws://127.0.0.1:8788/ws`

停止：`Ctrl+C`（SIGINT）會優雅關閉（先停驅動、關 WS、再關 HTTP）。

---

## 設定

優先序：**程式內預設 → 執行目錄 `config.json` → 環境變數**（環境變數最高）。
設定由 [src/config.ts](src/config.ts) 的 zod schema 驗證，非法值會在啟動時直接報錯（fail fast）；
**schema 未定義的鍵會被靜默忽略**（拼錯鍵名不會報錯，改設定沒生效時先檢查鍵名）。

### 環境變數

範例見 [.env.example](.env.example)。注意：**程式不會自動讀 `.env` 檔**——請由系統環境變數提供，
或以 `node --env-file=.env dist/index.js` 啟動（Node 20+ 內建）。

| 環境變數 | 說明 | 預設 |
|---|---|---|
| `HOST` | 綁定位址（請保持本機） | `127.0.0.1` |
| `PORT` | HTTP/WS 共用埠 | `8788` |
| `WMS_ALLOWED_ORIGINS` | 允許的網頁 Origin（逗號分隔） | `http://localhost:5173,http://localhost:3000` |
| `ALLOW_NO_ORIGIN` | 是否允許無 Origin 的連線（curl/原生工具）；正式環境建議 `false` | `true` |
| `KEYBOARD_ENABLED` | 是否啟用鍵盤模擬退路（設 `0` 全關，純走 WS） | `1` |
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` | `info` |

### config.json

把 [config.example.json](config.example.json) 複製成 `config.json` 放在**執行目錄**即可覆寫預設值。全部欄位：

| 區段.欄位 | 說明 | 預設 |
|---|---|---|
| `server.host` / `server.port` / `server.wsPath` | 綁定位址／埠／WS 路徑 | `127.0.0.1` / `8788` / `/ws` |
| `security.allowedOrigins` | Origin 白名單（大小寫、尾斜線容錯） | localhost:5173、localhost:3000 |
| `security.allowNoOrigin` | 允許無 Origin 連線 | `true` |
| `scanner.enabled` | 序列（CDC）掃碼槍驅動開關 | `true` |
| `scanner.vendorIds` | 認埠的 USB VID（hex，`0x` 前綴或大寫皆可） | `["05e0"]`（Zebra/Symbol） |
| `scanner.baudRate` | 序列速率 | `9600` |
| `scanner.path` | 強制指定埠（如 `"COM5"`）；`null`＝依 VID 自動認 | `null` |
| `scanner.keyboardFallback` | 無認領時是否走鍵盤退路 | `true` |
| `hidScanner.enabled` | HID-POS 掃碼槍驅動開關 | `true` |
| `hidScanner.vendorIds` | 認裝置的 USB VID | `["05e0"]` |
| `hidScanner.usagePages` | 允許的 usage page（數字或 `"0x8c"` 字串）；**空陣列＝接受該廠牌任何非鍵盤/滑鼠 collection** | `[]` |
| `hidScanner.reportHeaderBytes` | 解析 input report 跳過的表頭位元組數（依機型校準，見下） | `4` |
| `scale.enabled` | 電子秤驅動開關 | `true` |
| `scale.vendorIds` | 認埠的 USB-serial 晶片 VID；空陣列＝接受所有非掃碼槍序列埠 | CH340/FTDI/CP210x/PL2303 |
| `scale.baudRate` / `scale.path` | 序列速率／強制指定埠 | `9600` / `null` |
| `serial.pollIntervalMs` | 裝置熱插拔輪詢間隔（序列與 HID 共用，最小 500） | `2000` |
| `keyboard.enabled` | 鍵盤模擬總開關 | `true` |
| `keyboard.pressEnter` | 打完條碼補一個 Enter | `true` |
| `logLevel` | log 等級 | `"info"` |

---

## HTTP API（設備連線狀態）

### `GET /health`
```json
{ "status": "ok", "name": "wms-device-agent", "version": "0.1.0",
  "platform": "win32", "protocolVersion": 1, "uptimeMs": 12345, "ts": 1782092474634 }
```

### `GET /devices` — 核心：檢查設備連線狀態
```json
{
  "ts": 1782092474641,
  "wsClients": 1,
  "wsClaimingClients": 1,
  "connectedCount": 2,
  "devices": [
    { "deviceId": "scanner-1", "deviceName": "掃碼槍", "kind": "scanner",
      "status": "connected", "detail": "Zebra/Symbol (05e0:1200)", "since": 1782092474457 },
    { "deviceId": "scale-1", "deviceName": "電子秤", "kind": "scale",
      "status": "connected", "detail": "CH340 (1a86:7523)", "since": 1782092474457 }
  ]
}
```
`status`：`connecting` | `connected` | `removed` | `error`。

> Origin 白名單：帶**不在白名單的 Origin** 之請求一律回 `403`；無 Origin 的本機工具由 `ALLOW_NO_ORIGIN` 控制。

---

## WebSocket 協定（v1）

連線位址 `ws://127.0.0.1:8788/ws`。每則訊息皆為 JSON，含固定信封：`{ v, type, ts, ... }`。

### 伺服器 → 用戶端

| type | 說明 | 主要欄位 |
|---|---|---|
| `welcome` | 連上後第一則 | `agent{name,version,platform,protocolVersion}`, `devices[]`（快照） |
| `scan` | 掃到條碼 | `deviceId`, `deviceName`, `barcode` |
| `weight` | 秤重讀數 | `deviceId`, `deviceName`, `kg`, `stable` |
| `device-status` | 設備連線狀態變化 | `deviceId`, `deviceName`, `kind`, `status`, `detail` |
| `pong` | 回應用戶端 ping | `echo`（回填 ping 的 `t`） |
| `ack` | 指令確認 | `ref` |
| `error` | 錯誤 | `code`, `message`, `ref`（回填來源指令的 ref） |

> `scan` 只會送給「持有有效焦點認領」的頁面（見下方 `focus`）；`weight` / `device-status` 送給所有訂閱者。

### 用戶端 → 伺服器

| type | 說明 |
|---|---|
| `{ "type":"focus", "active":true\|false }` | **焦點認領**：頁面在前景/可見時送 `true` 認領掃碼、失焦時送 `false` 釋放。需定期續約（見下） |
| `{ "type":"ping", "t":<number?> }` | 量延遲；伺服器回 `pong{echo:t}` |
| `{ "type":"subscribe", "topics":["scan","weight","device-status"] }` | 只訂閱部分 topic（預設全收） |

心跳：伺服器以 WebSocket ping/pong frame 偵測並清除死連線（瀏覽器會自動回應），用戶端**不需**自行送心跳。

### 前端整合範例（含焦點認領）

重點：頁面要在**可見/前景**時認領掃碼（並定期續約），失焦時釋放。這樣 WMS 頁面在前景時掃碼走 WS、
切到其他 app 時自動由 agent 改用鍵盤打進該 app。

```js
const ws = new WebSocket("ws://127.0.0.1:8788/ws");

// ---- 焦點認領（focus-claim）----
const CLAIM_RENEW_MS = 2000; // 須小於 agent 端 TTL(6s)
let renewTimer = null;

function claim() {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "focus", active: true }));      // 認領 + 續約
}
function release() {
  clearInterval(renewTimer); renewTimer = null;
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "focus", active: false }));
}
function startClaiming() {
  if (renewTimer) return;
  claim();
  renewTimer = setInterval(claim, CLAIM_RENEW_MS);
}

function syncFocus() {
  if (document.visibilityState === "visible" && document.hasFocus()) startClaiming();
  else release();
}
document.addEventListener("visibilitychange", syncFocus);
window.addEventListener("focus", syncFocus);
window.addEventListener("blur", release);
ws.addEventListener("open", syncFocus);

// ---- 接收訊號 ----
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  switch (msg.type) {
    case "welcome":      console.log("agent", msg.agent, "devices", msg.devices); break;
    case "scan":         handleBarcode(msg.barcode); break;   // 去打既有 API
    case "weight":       updateWeight(msg.kg, msg.stable); break;
    case "device-status":updateDeviceStatusBar(msg); break;
  }
};
```

> 多分頁協調：`weight` / `device-status` 會廣播給所有分頁；`scan` 只送給認領中的分頁。
> 若多個 WMS 分頁同時可見（雙螢幕），仍建議沿用前端既有的多分頁協調（如 Web Locks 選出唯一 leader 再認領）。

---

## 掃碼槍：三種模式與如何被 agent 讀到

掃碼槍（Zebra/Symbol，VID `05e0`）可設定不同 USB 主機模式，決定 agent 用哪條路讀它：

| 掃碼槍模式 | agent 讀取方式 | 能否經 WS / 交警模式 |
|---|---|---|
| **HID-POS / IBM Hand-Held**（usage page `0x8c`） | `HidScannerDriver`（node-hid） | ✅ 可以 |
| **CDC（虛擬 COM）** | `ScannerDriver`（serialport） | ✅ 可以 |
| **HID 鍵盤（keyboard wedge，出廠預設，usage page `0x1`）** | ❌ 讀不到（OS 保護鍵盤） | ❌ 只會像鍵盤直接打字，不經 agent |

> 兩個掃碼槍驅動（HID-POS 與 CDC）**可同時啟用、互不衝突**——掃碼槍一次只在一種模式，只會被對應的驅動接管。

### A. HID-POS 模式（走 node-hid，免虛擬 COM）

1. 用掃碼槍手冊掃 **`USB IBM Hand-Held`**（或 `HID-POS` / `IBM Table-Top`）設定條碼。
2. 切好後，`usagePage` 會變成 `0x8c`。
3. agent 依 `hidScanner.vendorIds`（預設 `["05e0"]`）自動接管，emit `scan`。
   `hidScanner.usagePages` 預設為空（接受任何非鍵盤/滑鼠 collection）；要嚴格限定可設 `["0x8c"]`。
4. **校準 `reportHeaderBytes`**：不同機型／node-hid 對 reportId 的處理可能不同。用 `LOG_LEVEL=debug` 執行，掃一次會印出原始 report：
   ```
   [scanner-hid-1] report len=.. hex=[.. .. ..] ascii="....4710088123456"
   ```
   數一下條碼字元前有幾個位元組，把 `hidScanner.reportHeaderBytes` 設成那個數字（預設 4）。

### B. CDC 模式（走 serialport / 虛擬 COM）

1. 掃 **`USB CDC Host`**（或 `Set USB Device Type → CDC COM Port Emulation`）。
2. 系統新增一個 COM 埠（Windows 裝置管理員可見，VID `05E0`）。
3. 終止符建議設 **CR 或 CRLF**（agent 以 CR/LF 切一條條碼）。
4. agent 依 `scanner.vendorIds`（預設 `["05e0"]`）自動認埠；或 `scanner.path` 強制指定（如 `"COM5"`）。

### 確認目前掃碼槍在哪種模式

啟動 agent 看 log：若掃碼槍還在鍵盤模式，`HidScannerDriver` 會印出提示
（`偵測到掃碼槍 05e0:xxxx 但未接管：目前是鍵盤模式…請將掃碼槍切為 HID-POS…`）。
連上則會印 `已連線 HID 掃碼槍｜...｜usagePage=0x8c`。

> **與純鍵盤模式的關係**：只要切到 HID-POS 或 CDC，掃碼槍就經 agent，由焦點認領決定走 WS 或鍵盤模擬（即使在 Excel/UPS/FedEx/Teams 也能用 nut.js 打進去）。若維持出廠的**鍵盤模式**，它就是一支普通鍵盤、不經 agent、也沒有 WS 整合。

---

## 電子秤協定

預設假設（A&D / CAS / Mettler 桌秤常見）：**9600 8N1**，每行如 `ST,GS,+ 7.16 kg`
（`ST`=穩定 / `US`=不穩 / `OL`=過載）。協定不同請改 `scale.baudRate` 與 [parseScaleLine](src/parsing/scaleProtocol.ts)。

辨識策略：先以常見 USB-serial 晶片 VID（CH340/FTDI/CP210x/PL2303）選埠，開啟後**先中性顯示**（「序列裝置（待辨識）」），待資料指紋（`ST/US/OL` 或 `數字+kg/g`）命中才升級為「電子秤」並開始送 `weight`，避免誤標非秤裝置。

---

## 安全性

- **只綁 `127.0.0.1`**：不對區網開放。
- **Origin 白名單**：WS upgrade 與 HTTP 皆檢查 `Origin`；不在白名單者一律拒絕（WS 403 後關閉、HTTP 403）。

> 若 WMS 以 **https** 提供，瀏覽器連 `ws://localhost` 在多數環境被視為 potentially-trustworthy 而允許；若遇阻擋，需改走 `wss`（自簽憑證）——本版未內建，視部署再加。

---

## 專案結構

```
src/
  index.ts                 進入點：載入設定、組裝驅動/伺服器、啟動、優雅關閉
  config.ts                設定載入＋zod 驗證（預設 → config.json → 環境變數）
  logger.ts                極簡分級 logger（無第三方相依）
  TrafficCop.ts            交警模式仲裁：scan 走 WS（有認領）或鍵盤退路（無認領）
  core/
    types.ts               內部領域型別（ScanEvent / WeightEvent / DeviceStatusEvent…）
    DeviceBus.ts           型別安全事件匯流排（驅動 emit → server/traffic-cop 訂閱）
    DeviceManager.ts       驅動生命週期 + 裝置狀態快照（供 /devices 與 WS welcome）
  parsing/                 純函式解析（皆有單元測試）
    LineFramer.ts          串流分行器（CR/LF/CRLF，暴長丟棄）
    scaleProtocol.ts       電子秤協定解析與資料指紋
    hidPosReport.ts        HID-POS input report 解析
  devices/
    hotplug.ts             熱插拔共用元件：PollLoop（輪詢）/ RetryCooldown（失敗重試冷卻）
    serial/
      serialLoader.ts      懶載入 serialport（選用相依，失敗降級）
      SerialDeviceDriver.ts 序列驅動底座：埠探索/熱插拔/開關/分行（子類實作認埠與行處理）
    hid/hidLoader.ts       懶載入 node-hid（選用相依，失敗降級）
    ScannerDriver.ts       Zebra CDC 掃碼槍（繼承 SerialDeviceDriver）
    HidScannerDriver.ts    HID-POS 掃碼槍（node-hid，獨立輪詢）
    ScaleDriver.ts         電子秤（繼承 SerialDeviceDriver，資料指紋辨識）
  keyboard/
    KeyboardEmulator.ts    nut.js 鍵盤模擬（懶載入、失敗降級、序列化排隊）
  server/
    protocol.ts            WS 線上協定 v1（訊息 builder + zod 驗證用戶端訊息）
    WsServer.ts            WebSocket 伺服器（Origin 白名單/心跳/訂閱/焦點認領/廣播）
    httpApi.ts             HTTP 狀態 API（/health、/devices、CORS）
    origin.ts              Origin 白名單檢查（WS/HTTP 共用）
test/                      vitest 單元測試（純函式解析、協定、TrafficCop、config）
```

**訊號流**：驅動（devices/）解析硬體訊號 → emit 到 `DeviceBus` → `TrafficCop`（scan）與 `WsServer`（weight/device-status）訂閱處理。驅動不認識伺服器、伺服器不碰硬體，中間只隔一個 bus。

---

## 常見維護工作

### 支援新廠牌掃碼槍 / 新晶片電子秤

把新裝置的 USB VID 加進 `config.json` 的 `scanner.vendorIds` / `hidScanner.vendorIds` / `scale.vendorIds` 即可（`0x` 前綴、大小寫皆容錯）。查 VID：Windows 裝置管理員 → 裝置 → 詳細資料 → 硬體識別碼（`VID_XXXX`）；或 `LOG_LEVEL=debug` 啟動看列舉結果。若晶片名稱想正確顯示在 `/devices` 的 `detail`，可在 [SerialDeviceDriver.ts](src/devices/serial/SerialDeviceDriver.ts) 的 `SERIAL_CHIPS` 加一筆。

### 電子秤協定不同（非 `ST,GS,+ 7.16 kg` 格式）

改 [src/parsing/scaleProtocol.ts](src/parsing/scaleProtocol.ts) 的 `parseScaleLine()`（解析）與 `hasScaleSignature()`（辨識指紋），並在 [test/scaleProtocol.test.ts](test/scaleProtocol.test.ts) 補上新格式的案例。純函式、不碰硬體，跑 `pnpm test` 即可驗證。

### 新增一種裝置（序列類）

1. 在 [src/core/types.ts](src/core/types.ts) 定義事件型別並加進 `DeviceBusEvents`。
2. 繼承 [SerialDeviceDriver](src/devices/serial/SerialDeviceDriver.ts)，實作 `selectPort()`（哪些埠是我的）與 `handleLine()`（一行資料怎麼處理）——熱插拔、開關埠、分行都由底座處理。
3. 在 [src/index.ts](src/index.ts) 依設定註冊到 `DeviceManager`；需要送給前端則在 [protocol.ts](src/server/protocol.ts) 加訊息型別、[WsServer.ts](src/server/WsServer.ts) 訂閱廣播。

### 更新相依 / Node 版本

```bash
pnpm outdated          # 看有哪些可更新
pnpm update            # 依 semver 範圍更新（改動 lockfile 要 commit）
pnpm typecheck && pnpm test   # 更新後必跑
```

Node 版本升級：改 [mise.toml](mise.toml) 的 `node = "22"` → `mise install` → 重新 `pnpm install`（原生模組要對新 ABI 重編）。

### 部署到 Windows（正式環境）

```bash
pnpm build             # 編譯到 dist/
pnpm start             # 或 node dist/index.js
```

- `config.json` 放在**執行目錄**（工作目錄），設定正式的 `security.allowedOrigins`，建議 `ALLOW_NO_ORIGIN=false`。
- 以服務常駐可用 [nssm](https://nssm.cc/) 或 node-windows 等包裝器；**停止方式要設定成送 Ctrl+C / SIGINT**，agent 才能優雅關閉（釋放序列埠）。Ctrl+Break（SIGBREAK）也有處理。
- 同一台機器**只能跑一個 agent 實例**：第二個實例會搶不到埠（HTTP 8788）與序列埠（`Cannot lock port`）。

### 改動前的驗證清單

```bash
pnpm typecheck && pnpm test   # 型別 + 單元測試
pnpm dev                      # 啟動看三個驅動與端點正常
curl http://127.0.0.1:8788/health
```

---

## 疑難排解

### 安裝 / 啟動

| 症狀 | 原因與解法 |
|---|---|
| `tsx: line 20: exec: node: not found` | mise 釘選的 Node 沒裝：跑 `mise install`。 |
| `pnpm install` 中途失敗（下載中斷） | 多為網路瞬斷，重跑 `pnpm install` 即可（已下載的會走快取）。 |
| `ERR_PNPM_IGNORED_BUILDS` | 新增了帶 build 腳本的原生相依：在 [pnpm-workspace.yaml](pnpm-workspace.yaml) `allowBuilds` 核准它。 |
| 原生模組編譯失敗（node-gyp 錯誤） | 缺編譯工具鏈（Windows：VS Build Tools；macOS：Xcode CLT）。三個原生相依皆為**選用**，裝不起來 agent 仍可啟動，只是對應功能停用。 |
| `EADDRINUSE`（埠被占用） | 8788 已被占用——多半是另一個 agent 實例。關掉它或改 `PORT`。 |
| 啟動即報「設定驗證失敗」 | `config.json` 有非法值（訊息會列出欄位）。對照上方設定表修正。 |

### 掃碼槍

| 症狀 | 原因與解法 |
|---|---|
| log 出現「偵測到掃碼槍 … 但未接管：目前是鍵盤模式」 | 掃碼槍還在出廠的 keyboard wedge 模式：掃設定條碼切到 HID-POS 或 CDC（見上方掃碼槍章節）。 |
| 完全沒偵測到掃碼槍 | VID 不在 `vendorIds`（用裝置管理員查 VID 加進去）；或 USB 線/埠問題。`LOG_LEVEL=debug` 看列舉結果。 |
| `開啟 … 失敗：Cannot lock port` | 埠被其他程序占用（另一個 agent、序列監看工具）。關掉佔用者，agent 會自動重試（5 秒冷卻）。 |
| 條碼開頭缺字或混入亂碼（HID-POS） | `reportHeaderBytes` 沒校準：`LOG_LEVEL=debug` 看原始 report，數表頭位元組數後調整設定。 |
| 掃碼沒進 WMS 頁面（跑去別的視窗打字） | 頁面沒有有效焦點認領：確認前端有送 `focus active:true` 並每 2 秒續約（TTL 6 秒）。 |
| 掃碼雙重輸入（頁面收到又被打字） | 不應發生（TrafficCop 擇一路由）。若見到，多半是掃碼槍還在**鍵盤模式**（不經 agent 直接打字）＋頁面同時收 WS——切掃碼槍模式即可。 |

### 電子秤

| 症狀 | 原因與解法 |
|---|---|
| `/devices` 一直顯示「序列裝置（待辨識）」 | 開了埠但沒收到帶指紋的資料：秤沒開機/沒在送資料、`baudRate` 不符、或協定格式不同（見電子秤協定章節）。 |
| 沒偵測到秤 | USB-serial 晶片 VID 不在 `scale.vendorIds`；可加 VID，或設 `scale.vendorIds: []` 接受所有非掃碼槍序列埠（靠指紋辨識把關）。 |
| 讀數跳動不停 | 正常：不穩定時 `stable:false` 持續更新；穩定判定交由前端使用 `stable` 欄位。 |

### 鍵盤退路 / WebSocket

| 症狀 | 原因與解法 |
|---|---|
| 無認領時掃碼沒打字 | 看啟動 log：nut.js 載入失敗會告警（原生模組未安裝/平台不支援）。macOS 另需在「系統設定 → 隱私權與安全性 → 輔助使用」授權終端機/node。也確認 `KEYBOARD_ENABLED` 與 `scanner.keyboardFallback` 未關。 |
| 瀏覽器 WS 連線被拒（403） | 頁面 Origin 不在白名單：把它加進 `security.allowedOrigins` 或 `WMS_ALLOWED_ORIGINS`。agent log 會印被拒的 Origin。 |
| `curl` / `wscat` 連不上 | `ALLOW_NO_ORIGIN=false` 時無 Origin 的工具會被拒；測試時可暫時設回 `true`。 |
| 頁面收不到 `scan` 但收得到 `weight` | 正常設計：`scan` 只送給持有效認領的頁面。要收 `scan` 就要送 `focus active:true` 並續約。 |

### 除錯技巧

- `LOG_LEVEL=debug pnpm dev`：印出裝置列舉、原始 HID report、每筆讀數與路由決策。
- `curl http://127.0.0.1:8788/devices`：目前所有裝置狀態、WS 連線數、認領數。
- 快速測 WS：`npx wscat -c ws://127.0.0.1:8788/ws`（需 `ALLOW_NO_ORIGIN=true`），連上會先收到 `welcome`。
