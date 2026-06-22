// 型別安全的事件匯流排：所有裝置驅動把訊號 emit 到這裡，server / traffic-cop 在此訂閱。
// 以 Node EventEmitter 為底，外覆強型別介面（避免事件名打錯、payload 型別不符）。

import { EventEmitter } from "node:events";
import type { DeviceBusEvents } from "./types.js";

export class DeviceBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 裝置可能很多，放寬監聽上限避免 Node 的記憶體洩漏警告誤報。
    this.emitter.setMaxListeners(50);
  }

  on<K extends keyof DeviceBusEvents>(event: K, listener: (payload: DeviceBusEvents[K]) => void): this {
    this.emitter.on(event, listener as (payload: unknown) => void);
    return this;
  }

  off<K extends keyof DeviceBusEvents>(event: K, listener: (payload: DeviceBusEvents[K]) => void): this {
    this.emitter.off(event, listener as (payload: unknown) => void);
    return this;
  }

  emit<K extends keyof DeviceBusEvents>(event: K, payload: DeviceBusEvents[K]): void {
    this.emitter.emit(event, payload);
  }
}
