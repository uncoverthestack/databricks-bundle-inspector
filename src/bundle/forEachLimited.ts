/**
 * Runs `work` on every item, at most `limit` at a time, and resolves once all have finished.
 * Like `Promise.all`, it rejects with the first error.
 *
 * Used where every file of a bundle would otherwise be read at once, which holds them all in
 * memory together (#716).
 */
export async function forEachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  };
  // At least one worker, so a limit below 1 (or not a number) still does the work.
  const atOnce = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
  await Promise.all(Array.from({ length: Math.min(atOnce, Math.max(1, items.length)) }, worker));
}
