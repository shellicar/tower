/**
 * Holds serving back until nothing an earlier run left is still running.
 * Only launching a Claude Code could write into a conversation a leftover is
 * still writing to, so everything else (the control lines included) goes
 * ahead while the gate is shut.
 */
export class ServingGate {
  private release: () => void = () => {};
  private readonly opened = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  public open(): void {
    this.release();
  }

  /** Resolves once the gate is open, straight away if it already is. */
  public wait(): Promise<void> {
    return this.opened;
  }
}
