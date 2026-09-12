import type { Layout } from '../model/layout';

export type Live = {
  readonly model: Layout;
  act(change: (model: Layout) => void): void;
};

/** The whole of the framework's involvement with the model: the class reports
 *  no changes, so reading it goes through a counter the operations bump. */
export function live(model: Layout): Live {
  let tick = $state(0);
  return {
    get model() {
      void tick;
      return model;
    },
    act(change) {
      change(model);
      tick += 1;
    },
  };
}
