import { setTimeout as delay } from 'node:timers/promises';

/** Time: the edge that lets a test run a wait at once. */
export abstract class ITimer {
  /** Milliseconds, for measuring how long something took. */
  public abstract now(): number;
  /** The wall-clock time, as the `ts` every published message carries. */
  public abstract timestamp(): string;
  public abstract sleep(ms: number): Promise<void>;
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

  public sleep(ms: number): Promise<void> {
    return delay(ms);
  }

  public every(ms: number, tick: () => void): () => void {
    const interval = setInterval(tick, ms);
    interval.unref();
    return () => clearInterval(interval);
  }
}
