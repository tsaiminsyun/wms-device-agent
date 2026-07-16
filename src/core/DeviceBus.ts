// 型別安全事件匯流排：驅動 emit，server / traffic-cop 訂閱。

import { EventEmitter } from "node:events";
import type { DeviceBusEvents } from "./types.js";

export class DeviceBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // 放寬上限避免誤報洩漏警告。
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
