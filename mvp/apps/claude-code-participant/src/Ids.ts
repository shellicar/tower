import { randomUUID } from 'node:crypto';

/** Entropy: every id the participant mints, instance ids and query ids alike. */
export abstract class IIds {
  public abstract mint(): string;
}

export class RandomIds implements IIds {
  public mint(): string {
    return randomUUID();
  }
}
