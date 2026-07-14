// 內部領域型別；對外 WS 協定另見 server/protocol.ts。

export type DeviceKind = "scanner" | "scale";

export type DeviceStatus = "connecting" | "connected" | "removed" | "error";

// 一次掃碼結果。
export interface ScanEvent {
  /** 裝置實例 id，例如 "scanner-1"（同一驅動可管理多個實體埠）。 */
  deviceId: string;
  /** 人類可讀的裝置名稱／類別，例如 "掃碼槍"。 */
  deviceName: string;
  /** 掃到的條碼字串（已去除前後空白與終止符）。 */
  barcode: string;
  /** 來源裝置種類。 */
  kind: "scanner";
  /** 產生時間（epoch ms）。 */
  ts: number;
}

// 一次秤重讀數。
export interface WeightEvent {
  deviceId: string;
  deviceName: string;
  /** 重量（公斤）；可能為 0 或負值（秤未歸零時），由消費端決定語意。 */
  kg: number;
  /** 讀數是否穩定（ST=穩定 / US=不穩）。 */
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

// DeviceBus 的事件對應表（事件名 → payload）。
export interface DeviceBusEvents {
  scan: ScanEvent;
  weight: WeightEvent;
  "device-status": DeviceStatusEvent;
}

// 提供給 /devices API 與 WS welcome 的單一裝置快照。
export interface DeviceSnapshot {
  deviceId: string;
  deviceName: string;
  kind: DeviceKind;
  status: DeviceStatus;
  detail: string;
  /** 此狀態自何時起（epoch ms）。 */
  since: number;
}
