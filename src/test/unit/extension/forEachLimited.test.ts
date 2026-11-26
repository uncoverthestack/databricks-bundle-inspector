import { describe, expect, test } from "@jest/globals";
import { forEachLimited } from "../../../bundle/forEachLimited.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** Runs forEachLimited over `count` items and records how many ran at once. */
async function run(count: number, limit: number) {
  let running = 0;
  let most = 0;
  const done: number[] = [];
  await forEachLimited(
    Array.from({ length: count }, (_, i) => i),
    limit,
    async (item) => {
      running++;
      most = Math.max(most, running);
      await tick();
      done.push(item);
      running--;
    },
  );
  return { most, done };
}

describe("forEachLimited (#716)", () => {
  test("does every item, never more than the limit at once", async () => {
    const { most, done } = await run(50, 4);
    expect(most).toBe(4);
    expect([...done].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  test("with fewer items than the limit, runs them all at once", async () => {
    expect((await run(3, 16)).most).toBe(3);
  });

  test("starts items in their order", async () => {
    const started: number[] = [];
    await forEachLimited([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      await tick();
    });
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("an empty list does nothing", async () => {
    expect((await run(0, 16)).done).toEqual([]);
  });

  test.each([0, -3, Number.NaN, 0.5])("a limit of %p still does the work, one at a time", async (limit) => {
    const { most, done } = await run(5, limit);
    expect(most).toBe(1);
    expect(done).toHaveLength(5);
  });

  test("rejects with the first error, like Promise.all", async () => {
    await expect(
      forEachLimited([1, 2, 3], 2, async (item) => {
        await tick();
        if (item === 2) throw new Error("item 2 failed");
      }),
    ).rejects.toThrow("item 2 failed");
  });
});
