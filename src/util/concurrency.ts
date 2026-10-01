/** Minimal concurrency helpers (no dependency). */

export class Semaphore {
  private waiters: Array<() => void> = [];
  private active = 0;

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('Semaphore max must be an integer >= 1');
  }

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Map with at most `limit` tasks in flight; results keep input order; rejects on the first error (others finish). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const sem = new Semaphore(Math.max(1, limit));
  return Promise.all(items.map((item, i) => sem.run(() => fn(item, i))));
}

/** Like `mapLimit` but never rejects: every item yields a PromiseSettledResult. */
export async function mapLimitSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const sem = new Semaphore(Math.max(1, limit));
  return Promise.allSettled(items.map((item, i) => sem.run(() => fn(item, i))));
}
