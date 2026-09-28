/**
 * An async queue: pushed values come out of the iterator in order, and the
 * iterator ends once the channel is closed and drained. It is the prompt
 * stream a query reads, so Claude Code keeps running between messages.
 */
export class MessageChannel<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private closed = false;

  public get isClosed(): boolean {
    return this.closed;
  }

  public push(value: T): void {
    if (this.closed) {
      throw new Error('channel is closed');
    }
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value, done: false });
      return;
    }
    this.queued.push(value);
  }

  public close(): void {
    this.closed = true;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: undefined, done: true });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queued.length > 0) {
          return Promise.resolve({ value: this.queued.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
