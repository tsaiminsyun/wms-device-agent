// 熱插拔輪詢共用元件：序列（serialport）與 HID（node-hid）驅動都以
// 「定時列舉裝置 → 與已開啟清單比對」偵測插拔，這裡集中輪詢節奏與開啟失敗的重試冷卻。

/** 開埠／開裝置失敗後的重試冷卻時間，避免每次輪詢都狂試與洗 log。 */
export const OPEN_RETRY_COOLDOWN_MS = 5_000;

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

/** 開啟失敗裝置的重試冷卻表（key 為裝置路徑）；冷卻期間輪詢略過該裝置。 */
export class RetryCooldown {
  private readonly until = new Map<string, number>();

  constructor(readonly cooldownMs: number) {}

  schedule(key: string): void {
    this.until.set(key, Date.now() + this.cooldownMs);
  }

  clear(key: string): void {
    this.until.delete(key);
  }

  isCoolingDown(key: string): boolean {
    return (this.until.get(key) ?? 0) > Date.now();
  }

  /** 清掉已從裝置清單消失的 key，重插後即可立刻重試。 */
  prune(seen: ReadonlySet<string>): void {
    for (const key of this.until.keys()) {
      if (!seen.has(key)) this.until.delete(key);
    }
  }

  reset(): void {
    this.until.clear();
  }
}
