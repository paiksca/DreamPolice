/**
 * Consecutive-error tracker. Once `threshold` consecutive failures accumulate,
 * the breaker trips and calls the `onTrip` hook (typically creating a pause
 * file so the tailer stops processing until a human intervenes).
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private tripped = false;

  constructor(
    private readonly params: {
      enabled: boolean;
      threshold: number;
      onTrip: (info: { consecutiveErrors: number; threshold: number }) => Promise<void> | void;
    },
  ) {}

  isTripped(): boolean {
    return this.tripped;
  }

  get failureCount(): number {
    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    if (!this.params.enabled) return;
    this.consecutiveFailures = 0;
    // A successful call after a trip means upstream is healthy again. Reset
    // the tripped flag so the runtime status reflects recovery. The pause
    // file itself is untouched — the user decides when to resume.
    this.tripped = false;
  }

  async recordFailure(): Promise<void> {
    if (!this.params.enabled) return;
    this.consecutiveFailures += 1;
    if (!this.tripped && this.consecutiveFailures >= this.params.threshold) {
      this.tripped = true;
      await this.params.onTrip({
        consecutiveErrors: this.consecutiveFailures,
        threshold: this.params.threshold,
      });
    }
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.tripped = false;
  }
}
