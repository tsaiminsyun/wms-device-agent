// 內部領域型別；對外 WS 協定另見 server/protocol.ts。

export type DeviceKind = "scanner" | "scale";

export type DeviceStatus = "connecting" | "connected" | "removed" | "error";

// 一次掃碼結果。
export interface ScanEvent {
  /** 裝置實例 id，如 "scanner-1"（一驅動可管多埠）。 */
  deviceId: string;
  /** 人類可讀名稱，如 "掃碼槍"。 */
  deviceName: string;
  /** 已去除前後空白與終止符。 */
  barcode: string;
  kind: "scanner";
  /** epoch ms。 */
  ts: number;
}

// 一次秤重讀數。
export interface WeightEvent {
  deviceId: string;
  deviceName: string;
  /** 公斤；可能為 0 或負（秤未歸零），語意由消費端決定。 */
  kg: number;
  /** ST=穩定 / US=不穩。 */
  stable: boolean;
  kind: "scale";
  ts: number;
}

// 裝置連線狀態變化。
export interface DeviceStatusEvent {
  deviceId: string;
  deviceName: string;
  kind: DeviceKind;
  status: DeviceStatus;
  /** 補充說明（晶片型號、錯誤訊息、productName 等）。 */
  detail: string;
  ts: number;
}

// DeviceBus 事件名 → payload。
export interface DeviceBusEvents {
  scan: ScanEvent;
  weight: WeightEvent;
  "device-status": DeviceStatusEvent;
}

// 單一裝置快照（供 /devices 與 WS welcome）。
export interface DeviceSnapshot {
  deviceId: string;
  deviceName: string;
  kind: DeviceKind;
  status: DeviceStatus;
  detail: string;
  /** 此狀態自何時起（epoch ms）。 */
  since: number;
}
