import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter", () => {
  it("allows a burst up to capacity then blocks", () => {
    const t = 0;
    const rl = new RateLimiter(3, 1, () => t);
    expect([rl.tryConsume(), rl.tryConsume(), rl.tryConsume(), rl.tryConsume()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("refills over time", () => {
    let t = 0;
    const rl = new RateLimiter(2, 2, () => t);
    rl.tryConsume();
    rl.tryConsume();
    expect(rl.tryConsume()).toBe(false);
    t += 500; // 1 token at 2/s
    expect(rl.tryConsume()).toBe(true);
    expect(rl.tryConsume()).toBe(false);
  });

  it("never exceeds capacity after a long idle period", () => {
    let t = 0;
    const rl = new RateLimiter(2, 10, () => t);
    t += 60_000;
    expect([rl.tryConsume(), rl.tryConsume(), rl.tryConsume()]).toEqual([true, true, false]);
  });

  it("rejects invalid configuration", () => {
    expect(() => new RateLimiter(0, 1)).toThrow(RangeError);
    expect(() => new RateLimiter(1, 0)).toThrow(RangeError);
  });
});
