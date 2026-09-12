import type { Layout } from '../model/layout';

export type Reactive = {
  readonly layout: Layout;
  act(change: (layout: Layout) => void): void;
};

/** The whole of the framework's involvement with the model: the class reports
 *  no changes, so reading it goes through a counter the operations bump. */
export function reactive(layout: Layout): Reactive {
  let tick = $state(0);
  return {
    get layout() {
      void tick;
      return layout;
    },
    act(change) {
      change(layout);
      tick += 1;
    },
  };
}
