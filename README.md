# wms-device-agent

WMS 本機**裝置代理**：在操作員的電腦（部署目標 Windows）上以背景服務執行，把**掃碼槍**、**電子秤**等序列設備的訊號，透過 **WebSocket** 即時轉送給 WMS 網頁端；並提供 **HTTP API** 供網頁查詢設備連線狀態。

當沒有任何網頁連著（離線）時，代理會啟動**交警模式**的退路：用系統鍵盤模擬（nut.js）把掃到的條碼「打字」進目前作業系統焦點所在的輸入框，行為與舊版瀏覽器 WebHID 直接打字一致。

> 本專案把裝置存取從瀏覽器（WebHID / Web Serial）搬到本機常駐服務，讓 WMS 任一頁面都能透過單一 WS 連線收到全域設備訊號，不再受限於單一分頁的瀏覽器授權。

---

## 架構

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

Node.js 由 **mise** 管理（已釘選於 [mise.toml](mise.toml)，Node 22 LTS）。

本專案以 **pnpm** 為套件管理器（lockfile：`pnpm-lock.yaml`）。請確保 `node`（由 mise 提供）在 PATH 上，
否則安裝時的原生 build 腳本會找不到 `node`。

```bash
mise install     # 安裝釘選的 Node 版本（並讓 node 進到 PATH）
pnpm install     # 安裝相依
```

> **pnpm build 腳本核准**：pnpm 預設封鎖相依的安裝腳本。本 repo 已在 [pnpm-workspace.yaml](pnpm-workspace.yaml)
> 的 `allowBuilds` 核准 `esbuild`（tsx/vitest 需要）與 `@serialport/bindings-cpp`（serialport 原生繫結），
> 故 `pnpm install` 可直接成功，不會出現 `ERR_PNPM_IGNORED_BUILDS`。

`serialport`、`@nut-tree-fork/nut-js`、`node-hid` 是**選用原生相依**（optionalDependencies）：
在無法編譯原生模組的環境仍能安裝成功並啟動（只是少了對應功能——實體序列裝置／鍵盤退路／HID 掃碼槍）。

---

## 執行

```bash
pnpm dev        # 開發（tsx watch，讀實體裝置）
pnpm build      # 編譯到 dist/
pnpm start      # 跑編譯後的 dist/index.js
pnpm test       # 單元測試（vitest）
pnpm typecheck  # 型別檢查
```

啟動後預設：

- HTTP 健康檢查：`http://127.0.0.1:8788/health`
- HTTP 設備狀態：`http://127.0.0.1:8788/devices`
- WebSocket：`ws://127.0.0.1:8788/ws`

---

## 設定

優先序：**程式內預設 → 執行目錄 `config.json` → 環境變數**（環境變數最高）。
範例見 [config.example.json](config.example.json) 與 [.env.example](.env.example)。

| 環境變數 | 說明 | 預設 |
|---|---|---|
| `HOST` | 綁定位址（請保持本機） | `127.0.0.1` |
| `PORT` | HTTP/WS 共用埠 | `8788` |
| `WMS_ALLOWED_ORIGINS` | 允許的網頁 Origin（逗號分隔） | `http://localhost:5173,http://localhost:3000` |
| `ALLOW_NO_ORIGIN` | 是否允許無 Origin 的連線（curl/原生工具） | `true` |
| `KEYBOARD_ENABLED` | 是否啟用鍵盤模擬退路（設 `0` 全關，純走 WS） | `1` |
| `LOG_LEVEL` | `debug`/`info`/`warn`/`error` | `info` |

`config.json` 可進一步調整裝置參數（掃碼槍/電子秤的 `vendorIds`、`baudRate`、強制 `path`，輪詢間隔，鍵盤退路開關等）。

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

掃碼槍（Zebra/Symbol，VID `05e0`）可設定不同 USB 主機模式，決定 agent 用哪條路讀它:

| 掃碼槍模式 | agent 讀取方式 | 能否經 WS / 交警模式 |
|---|---|---|
| **HID-POS / IBM Hand-Held**（usage page `0x8c`） | `HidScannerDriver`（node-hid） | ✅ 可以 |
| **CDC（虛擬 COM）** | `ScannerDriver`（serialport） | ✅ 可以 |
| **HID 鍵盤（keyboard wedge，出廠預設，usage page `0x1`）** | ❌ 讀不到（OS 保護鍵盤） | ❌ 只會像鍵盤直接打字，不經 agent |

> 兩個掃碼槍驅動（HID-POS 與 CDC）**可同時啟用、互不衝突**——掃碼槍一次只在一種模式，只會被對應的驅動接管。

### A. HID-POS 模式（走 node-hid，免虛擬 COM）

1. 用掃碼槍手冊掃 **`USB IBM Hand-Held`**（或 `HID-POS` / `IBM Table-Top`）設定條碼。
2. 切好後，`usagePage` 會變成 `0x8c`（可用內建列舉確認，見下）。
3. agent 依 `hidScanner.vendorIds`（預設 `["05e0"]`）+ `hidScanner.usagePages`（預設 `["0x8c"]`）自動接管，emit `scan`。
4. **校準 `reportHeaderBytes`**：不同機型／node-hid 對 reportId 的處理可能不同。用 `LOG_LEVEL=debug` 執行，掃一次會印出原始 report:
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

啟動 agent（`LOG_LEVEL=debug`）看 `HidScannerDriver` 是否連上；或用 node-hid 列舉看 `usagePage`：
`0x8c` = HID-POS（可讀）、`0x1` = 鍵盤模式（讀不到，要改模式）。

> **與純鍵盤模式的關係**：只要切到 HID-POS 或 CDC，掃碼槍就經 agent，由焦點認領決定走 WS 或鍵盤模擬（即使在 Excel/UPS/FedEx/Teams 也能用 nut.js 打進去）。若維持出廠的**鍵盤模式**，它就是一支普通鍵盤、不經 agent、也沒有 WS 整合。

---

## 電子秤協定

預設假設（A&D / CAS / Mettler 桌秤常見）：**9600 8N1**，每行如 `ST,GS,+ 7.16 kg`
（`ST`=穩定 / `US`=不穩 / `OL`=過載）。協定不同請改 `scale.baudRate` 與 [parseScaleLine](src/parsing/scaleProtocol.ts)。

辨識策略：先以常見 USB-serial 晶片 VID（CH340/FTDI/CP210x/PL2303）選埠，開啟後**先中性顯示**，待資料指紋（`ST/US/OL` 或 `數字+kg/g`）命中才升級為「電子秤」並開始送 `weight`，避免誤標非秤裝置。

---

## 安全性

- **只綁 `127.0.0.1`**：不對區網開放。
- **Origin 白名單**：WS upgrade 與 HTTP 皆檢查 `Origin`；不在白名單者一律拒絕（WS 403 後關閉、HTTP 403）。

> 若 WMS 以 **https** 提供，瀏覽器連 `ws://localhost` 在多數環境被視為 potentially-trustworthy 而允許；若遇阻擋，需改走 `wss`（自簽憑證）——本版未內建，視部署再加。

---

## 專案結構

```
src/
  index.ts                 進入點：載入設定、組裝、啟動、優雅關閉
  config.ts                設定載入＋zod 驗證（預設→config.json→env）
  logger.ts                極簡分級 logger
  TrafficCop.ts            交警模式仲裁（WS 廣播 vs 鍵盤退路）
  core/                    types / DeviceBus（型別安全事件匯流排）/ DeviceManager（狀態快照與生命週期）
  parsing/                 LineFramer（分行）/ scaleProtocol（秤協定）/ hidPosReport（HID-POS report 解析，皆純函式）
  devices/
    serial/                serialLoader（懶載入 serialport）/ SerialDeviceDriver（輪詢/熱插拔底座）
    hid/hidLoader.ts       懶載入 node-hid
    ScannerDriver.ts       Zebra CDC 掃碼槍（serialport）
    HidScannerDriver.ts    HID-POS 掃碼槍（node-hid，usage page 0x8c）
    ScaleDriver.ts         電子秤（資料指紋辨識）
  keyboard/KeyboardEmulator.ts   nut.js 鍵盤模擬（平台保護、序列化排隊）
  server/
    protocol.ts            WS 線上協定 v1（builder + zod 驗證）
    WsServer.ts            WebSocket 伺服器（白名單/心跳/訂閱/廣播）
    httpApi.ts             HTTP 狀態 API（/health、/devices）
    origin.ts              Origin 白名單檢查（WS/HTTP 共用）
test/                      vitest 單元測試
```
