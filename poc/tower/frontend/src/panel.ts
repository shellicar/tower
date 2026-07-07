// One panel per agent: drag by the title bar, resize by the corner grip.
// Rendering reads the folded AgentView; it owns no protocol logic.

import type { AgentView } from "./fold";

const CASCADE_STEP = 32;

export class Panel {
  readonly root: HTMLElement;
  private readonly conversationEl: HTMLElement;
  private readonly feedEl: HTMLElement;
  private readonly statusEl: HTMLElement;

  constructor(agentId: string, board: HTMLElement, index: number) {
    this.root = el("section", "panel");
    this.root.style.left = `${16 + index * CASCADE_STEP}px`;
    this.root.style.top = `${16 + index * CASCADE_STEP}px`;

    const titleBar = el("header", "panel-title");
    titleBar.textContent = agentId;
    this.statusEl = el("span", "panel-status");
    this.statusEl.textContent = "live";
    titleBar.appendChild(this.statusEl);

    this.conversationEl = el("div", "panel-conversation");
    this.feedEl = el("div", "panel-feed");

    const grip = el("div", "panel-grip");

    this.root.append(titleBar, this.conversationEl, this.feedEl, grip);
    board.appendChild(this.root);

    makeDraggable(this.root, titleBar);
    makeResizable(this.root, grip);
  }

  render(view: AgentView): void {
    this.conversationEl.replaceChildren(
      ...view.conversation.map((entry) => {
        const line = el("div", `entry entry-${entry.role}`);
        line.textContent = entry.text + (entry.streaming ? " ▌" : "");
        return line;
      }),
    );
    this.feedEl.replaceChildren(
      ...view.feed.slice(-30).map((f) => {
        const line = el("div", "feed-line");
        line.textContent = `${f.label}  ${f.detail}`;
        return line;
      }),
    );
    this.conversationEl.scrollTop = this.conversationEl.scrollHeight;
    this.feedEl.scrollTop = this.feedEl.scrollHeight;
  }

  setStale(stale: boolean): void {
    this.statusEl.textContent = stale ? "stale" : "live";
    this.root.classList.toggle("stale", stale);
  }
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function makeDraggable(panel: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener("pointerdown", (down: PointerEvent) => {
    const startX = down.clientX - panel.offsetLeft;
    const startY = down.clientY - panel.offsetTop;
    handle.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent): void => {
      panel.style.left = `${Math.max(0, e.clientX - startX)}px`;
      panel.style.top = `${Math.max(0, e.clientY - startY)}px`;
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

function makeResizable(panel: HTMLElement, grip: HTMLElement): void {
  grip.addEventListener("pointerdown", (down: PointerEvent) => {
    down.preventDefault();
    const startW = panel.offsetWidth - down.clientX;
    const startH = panel.offsetHeight - down.clientY;
    grip.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent): void => {
      panel.style.width = `${Math.max(240, startW + e.clientX)}px`;
      panel.style.height = `${Math.max(180, startH + e.clientY)}px`;
    };
    const up = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}
