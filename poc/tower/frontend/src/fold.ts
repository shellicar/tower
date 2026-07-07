// Pure event-folding: tagged events in, per-agent view state out.
// No DOM, no socket — this is the logic the unit tests cover.

import type { TaggedEvent } from "./feed";

export interface ConversationEntry {
  role: "user" | "assistant" | "error";
  text: string;
  /** Assistant entries stream until their turn ends. */
  streaming: boolean;
  turnId?: string;
}

export interface FeedLine {
  label: string;
  detail: string;
}

export interface AgentView {
  agentId: string;
  conversation: ConversationEntry[];
  feed: FeedLine[];
  lastSeen: number;
}

export interface BoardState {
  agents: Map<string, AgentView>;
}

export function newBoard(): BoardState {
  return { agents: new Map() };
}

const FEED_LIMIT = 200;

/**
 * Fold one tagged event into the board. Returns the affected agent's view.
 * Any event from an unknown agent id discovers that agent (per the spec).
 */
export function fold(board: BoardState, tagged: TaggedEvent, now: number): AgentView {
  let agent = board.agents.get(tagged.agentId);
  if (agent === undefined) {
    agent = { agentId: tagged.agentId, conversation: [], feed: [], lastSeen: now };
    board.agents.set(tagged.agentId, agent);
  }
  agent.lastSeen = now;

  const ev = tagged.event;
  const type = typeof ev.type === "string" ? ev.type : "(untyped)";

  switch (type) {
    case "agent_ready":
      pushFeed(agent, "ready", tagged.agentId);
      break;
    case "turn_started": {
      const text = str(ev.text);
      const kind =
        typeof ev.from === "object" && ev.from !== null
          ? str((ev.from as Record<string, unknown>).kind)
          : "?";
      agent.conversation.push({ role: "user", text, streaming: false, turnId: str(ev.turnId) });
      pushFeed(agent, "turn_started", `${str(ev.turnId)} from ${kind}: ${text}`);
      break;
    }
    case "text_delta": {
      const turnId = str(ev.turnId);
      const text = str(ev.text);
      const last = agent.conversation[agent.conversation.length - 1];
      if (last !== undefined && last.role === "assistant" && last.streaming && last.turnId === turnId) {
        last.text += text;
      } else {
        agent.conversation.push({ role: "assistant", text, streaming: true, turnId });
      }
      pushFeed(agent, "text_delta", text);
      break;
    }
    case "turn_ended": {
      const turnId = str(ev.turnId);
      const last = agent.conversation[agent.conversation.length - 1];
      if (last !== undefined && last.streaming && last.turnId === turnId) {
        last.streaming = false;
      }
      pushFeed(agent, "turn_ended", `${turnId} (${str(ev.stopReason)})`);
      break;
    }
    case "error": {
      const message = str(ev.message);
      const suffix = typeof ev.turnId === "string" ? ` [turn ${ev.turnId}]` : "";
      agent.conversation.push({ role: "error", text: message + suffix, streaming: false });
      pushFeed(agent, "error", message + suffix);
      break;
    }
    default:
      // Unknown event types are shown generically, not dropped.
      pushFeed(agent, type, JSON.stringify(ev));
      break;
  }
  return agent;
}

function pushFeed(agent: AgentView, label: string, detail: string): void {
  agent.feed.push({ label, detail });
  if (agent.feed.length > FEED_LIMIT) agent.feed.splice(0, agent.feed.length - FEED_LIMIT);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
