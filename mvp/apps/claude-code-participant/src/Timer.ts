import { setTimeout as delay } from 'node:timers/promises';

/** Time: the edge that lets a test run a 30 s wait at once. */
export abstract class ITimer {
  /** Milliseconds, for measuring how long something took. */
  public abstract now(): number;
  public abstract sleep(ms: number): Promise<void>;
}

export class RealTimer implements ITimer {
  public now(): number {
    return performance.now();
  }

  public sleep(ms: number): Promise<void> {
    return delay(ms);
  }
}
