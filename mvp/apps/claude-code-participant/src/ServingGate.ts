/** Holds serving back until the leftover scan has finished. */
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
