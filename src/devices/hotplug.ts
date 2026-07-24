// 熱插拔輪詢共用元件：輪詢節奏（PollLoop）與失敗重試冷卻（RetryCooldown）。

/** 開埠／開裝置失敗後的重試冷卻時間，避免每次輪詢都狂試與洗 log。 */
export const OPEN_RETRY_COOLDOWN_MS = 5_000;

/** 首次開埠失敗的快速重試冷卻（前次關閉的殘留常在 1 秒內回收，快重試即可接上）。 */
export const OPEN_RETRY_FIRST_MS = 1_000;

/** 以固定間隔執行 tick 的輪詢迴圈；前一次 tick 未完成前不重入。 */
export class PollLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: () => void | Promise<void>,
  ) {}

  /** 先執行並等完第一次 tick，再開始定時輪詢。 */
  async start(): Promise<void> {
    await this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } finally {
      this.running = false;
    }
  }
}

/** 開啟失敗裝置的重試冷卻表（key=裝置路徑）；冷卻期間輪詢略過。firstCooldownMs 可設較短的首次冷卻，連續失敗才退長冷卻。 */
export class RetryCooldown {
  private readonly until = new Map<string, number>();
  private readonly failures = new Map<string, number>();

  constructor(
    readonly cooldownMs: number,
    private readonly firstCooldownMs = cooldownMs,
  ) {}

  /** 排入冷卻；回傳本次採用的冷卻毫秒數（log 顯示用）。 */
  schedule(key: string): number {
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    const wait = n === 1 ? this.firstCooldownMs : this.cooldownMs;
    this.until.set(key, Date.now() + wait);
    return wait;
  }

  clear(key: string): void {
    this.until.delete(key);
    this.failures.delete(key);
  }

  isCoolingDown(key: string): boolean {
    return (this.until.get(key) ?? 0) > Date.now();
  }

  /** 清掉已從裝置清單消失的 key，重插後即可立刻重試。 */
  prune(seen: ReadonlySet<string>): void {
    for (const key of this.until.keys()) {
      if (!seen.has(key)) {
        this.until.delete(key);
        this.failures.delete(key);
      }
    }
  }

  reset(): void {
    this.until.clear();
    this.failures.clear();
  }
}
