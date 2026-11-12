import type { Socket } from 'node:net';

/** The participant's own process, as shutdown drives it: its clock, its end and its stderr. */
export abstract class IHost {
  /**
   * Calls `expired` after `ms`, without keeping the process alive for it.
   * Returns what cancels it.
   */
  public abstract deadline(ms: number, expired: () => void): () => void;
  /** Lets the process end on its own once its remaining work is done: stdin no longer keeps it alive. */
  public abstract letEnd(): void;
  /** Ends the process now, whatever is still running. */
  public abstract exit(code: number): void;
  /** A diagnostic line, on stderr, never stdout, which carries only replies. */
  public abstract log(line: string): void;
}

export class NodeHost implements IHost {
  public deadline(ms: number, expired: () => void): () => void {
    const timer = setTimeout(expired, ms);
    timer.unref();
    return () => clearTimeout(timer);
  }

  public letEnd(): void {
    // A pipe or terminal is a socket, which can stop holding the process
    // open while it's still read. A file has no such hold: it ends by itself.
    (process.stdin as Partial<Pick<Socket, 'unref'>>).unref?.();
  }

  public exit(code: number): void {
    process.exit(code);
  }

  public log(line: string): void {
    console.error(`participant: ${line}`);
  }
}
