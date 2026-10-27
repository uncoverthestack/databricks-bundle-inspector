import { describe, expect, test } from "@jest/globals";
import { createCheckLimiter } from "../../../extension/checkLimiter.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createCheckLimiter", () => {
  test("12 bundles checked again together never run more than 2 checks at once, and all finish", async () => {
    const limiter = createCheckLimiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        await limiter.acquire();
        try {
          running++;
          peak = Math.max(peak, running);
          order.push(index);
          await tick();
        } finally {
          running--;
          limiter.release();
        }
      }),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([...Array(12).keys()]);
  });

  test("a released slot goes to the next check waiting", async () => {
    const limiter = createCheckLimiter(1);
    await limiter.acquire();
    let second = false;
    const waiting = limiter.acquire().then(() => (second = true));
    await tick();
    expect(second).toBe(false);
    limiter.release();
    await waiting;
    expect(second).toBe(true);
    limiter.release();
    // Free again: the next one starts at once.
    await limiter.acquire();
  });
});
