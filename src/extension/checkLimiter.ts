/**
 * Lets at most `max` checks run the CLI at once, however many bundles changed together
 * (a CLI change, a branch switch). The others wait their turn, in the order they asked.
 */
export function createCheckLimiter(max: number): { acquire(): Promise<void>; release(): void } {
  let running = 0;
  const waiting: (() => void)[] = [];
  return {
    async acquire() {
      if (running < max) {
        running++;
        return;
      }
      // The slot is handed over by release, so the count stays as it is.
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else running--;
    },
  };
}
