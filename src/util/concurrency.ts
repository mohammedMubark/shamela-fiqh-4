/**
 * Bounded worker pool. Used by the full-export sweep so memory stays flat no
 * matter how many books are selected: we never materialise the task results,
 * each task streams its own output and returns only a small summary.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const bounded = Math.max(1, Math.min(16, Math.floor(limit) || 1));
  const results = new Array<R>(items.length);
  let next = 0;

  async function run(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(bounded, items.length) }, run));
  return results;
}

/**
 * Re-exported so existing importers keep working; the implementation lives in
 * src/config.ts with every other environment read.
 */
export { envInt } from "../config.js";
