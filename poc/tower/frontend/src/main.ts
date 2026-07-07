import { WebSocketFeed } from "./feed";
import { fold, newBoard } from "./fold";
import { Panel } from "./panel";

const STALE_AFTER_MS = 30_000;

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("conn-status");
if (boardEl === null || statusEl === null) {
  throw new Error("index.html is missing #board or #conn-status");
}

const board = newBoard();
const panels = new Map<string, Panel>();

const feed = new WebSocketFeed(`ws://${window.location.host}/ws`);

feed.onStatus((s) => {
  statusEl.textContent = s;
  statusEl.className = s;
});

feed.onEvent((tagged) => {
  const view = fold(board, tagged, Date.now());
  let panel = panels.get(tagged.agentId);
  if (panel === undefined) {
    panel = new Panel(tagged.agentId, boardEl, panels.size);
    panels.set(tagged.agentId, panel);
  }
  panel.render(view);
  panel.setStale(false);
});

// Staleness sweep: mark agents silent for 30s (desirable in the brief).
setInterval(() => {
  const now = Date.now();
  for (const [id, view] of board.agents) {
    panels.get(id)?.setStale(now - view.lastSeen > STALE_AFTER_MS);
  }
}, 5_000);
