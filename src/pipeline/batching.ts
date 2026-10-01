/** Splits work into model calls of bounded size (spec §8.2: fewer segments per call when a provider truncates or breaks JSON). */
export interface BatchLimits {
  maxSegments: number;
  maxChars: number;
}

/** Greedy and order-preserving. An item bigger than `maxChars` gets a batch of its own. */
export function makeBatches<T>(items: readonly T[], limits: BatchLimits, size: (item: T) => number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const n = size(item);
    if (current.length > 0 && (current.length >= limits.maxSegments || chars + n > limits.maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += n;
  }
  if (current.length) batches.push(current);
  return batches;
}
