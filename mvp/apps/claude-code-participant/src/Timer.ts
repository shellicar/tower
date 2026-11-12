import { setTimeout as delay } from 'node:timers/promises';

/** Time: the edge that lets a test run a wait at once. */
export abstract class ITimer {
  /** Milliseconds, for measuring how long something took. */
  public abstract now(): number;
  /** The wall-clock time, as the `ts` every published message carries. */
  public abstract timestamp(): string;
  /** Resolves after `ms`, or as soon as `wake` aborts; a sleep that is woken leaves no timer behind. */
  public abstract sleep(ms: number, wake?: AbortSignal): Promise<void>;
  /**
   * Calls `tick` every `ms`, without keeping the process alive for it.
   * Returns what stops it.
   */
  public abstract every(ms: number, tick: () => void): () => void;
}

export class RealTimer implements ITimer {
  public now(): number {
    return performance.now();
  }

  public timestamp(): string {
    return new Date().toISOString();
  }

  public async sleep(ms: number, wake?: AbortSignal): Promise<void> {
    try {
      await delay(ms, undefined, wake === undefined ? {} : { signal: wake });
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') {
        throw err;
      }
    }
  }

  public every(ms: number, tick: () => void): () => void {
    const interval = setInterval(tick, ms);
    interval.unref();
    return () => clearInterval(interval);
  }
}
