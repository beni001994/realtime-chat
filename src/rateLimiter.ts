/**
 * Token bucket. The clock is injected so the logic is deterministic in tests.
 * `capacity` is the burst size; `refillPerSecond` is the sustained rate.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    if (capacity < 1 || refillPerSecond <= 0) {
      throw new RangeError("capacity must be >= 1 and refillPerSecond > 0");
    }
    this.tokens = capacity;
    this.last = now();
  }

  /** Try to consume one token. Returns false when the caller is over the limit. */
  tryConsume(): boolean {
    const t = this.now();
    const elapsedSec = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
