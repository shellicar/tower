import type { Attachment } from 'svelte/attachments';

export type ResizeOptions = {
  min: number;
  max: number;
  /** Called on every pointer move, with the width the panel should now be. */
  onWidth: (width: number) => void;
  /** Called once when the drag ends, for anything worth persisting. */
  onSettled?: (width: number) => void;
};

/** Drag an edge to resize the panel it belongs to.
 *
 *  Attach to the handle; the panel is the handle's parent, and the width is
 *  measured from that panel's own left edge rather than from the window's, so
 *  it holds wherever the panel sits. The handle grows the panel rightwards, so
 *  it belongs on the panel's right edge. */
export function resizeWidth(options: ResizeOptions): Attachment<HTMLElement> {
  return (handle) => {
    const panel = handle.parentElement;
    if (panel === null) return;

    const down = (event: PointerEvent) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);

      const move = (moved: PointerEvent) => {
        const from = panel.getBoundingClientRect().left;
        options.onWidth(Math.min(options.max, Math.max(options.min, moved.clientX - from)));
      };
      const up = (ended: PointerEvent) => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        const from = panel.getBoundingClientRect().left;
        options.onSettled?.(Math.min(options.max, Math.max(options.min, ended.clientX - from)));
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    };

    handle.addEventListener('pointerdown', down);
    return () => handle.removeEventListener('pointerdown', down);
  };
}
