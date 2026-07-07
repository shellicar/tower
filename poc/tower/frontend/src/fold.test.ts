import { describe, expect, it } from "vitest";
import type { TaggedEvent } from "./feed";
import { fold, newBoard } from "./fold";

function ev(agentId: string, event: Record<string, unknown>): TaggedEvent {
  return { agentId, event };
}

describe("fold", () => {
  it("discovers an agent from agent_ready", () => {
    const board = newBoard();
    fold(board, ev("a-1", { type: "agent_ready", agentId: "a-1" }), 0);
    expect(board.agents.has("a-1")).toBe(true);
  });

  it("discovers an agent from any event with an unknown id", () => {
    const board = newBoard();
    fold(board, ev("a-2", { type: "text_delta", turnId: "t-1", text: "hi" }), 0);
    expect(board.agents.has("a-2")).toBe(true);
  });

  it("shows both sides: turn_started adds the user entry", () => {
    const board = newBoard();
    const view = fold(
      board,
      ev("a-1", { type: "turn_started", turnId: "t-1", text: "What's 2+2?", from: { kind: "human" } }),
      0,
    );
    expect(view.conversation).toHaveLength(1);
    expect(view.conversation[0]).toMatchObject({ role: "user", text: "What's 2+2?" });
  });

  it("accumulates text_deltas of one turn into one streaming entry", () => {
    const board = newBoard();
    fold(board, ev("a-1", { type: "turn_started", turnId: "t-1", text: "q", from: { kind: "human" } }), 0);
    fold(board, ev("a-1", { type: "text_delta", turnId: "t-1", text: "The " }), 1);
    const view = fold(board, ev("a-1", { type: "text_delta", turnId: "t-1", text: "answer" }), 2);
    expect(view.conversation).toHaveLength(2);
    expect(view.conversation[1]).toMatchObject({
      role: "assistant",
      text: "The answer",
      streaming: true,
    });
  });

  it("turn_ended stops the streaming entry", () => {
    const board = newBoard();
    fold(board, ev("a-1", { type: "text_delta", turnId: "t-1", text: "4" }), 0);
    const view = fold(board, ev("a-1", { type: "turn_ended", turnId: "t-1", stopReason: "end_turn" }), 1);
    expect(view.conversation[0]?.streaming).toBe(false);
  });

  it("a new turn starts a new assistant entry, not an append to the old", () => {
    const board = newBoard();
    fold(board, ev("a-1", { type: "text_delta", turnId: "t-1", text: "one" }), 0);
    fold(board, ev("a-1", { type: "turn_ended", turnId: "t-1", stopReason: "end_turn" }), 1);
    const view = fold(board, ev("a-1", { type: "text_delta", turnId: "t-2", text: "two" }), 2);
    expect(view.conversation).toHaveLength(2);
    expect(view.conversation[1]).toMatchObject({ text: "two", turnId: "t-2" });
  });

  it("errors are visible in the conversation, with optional turn id", () => {
    const board = newBoard();
    const rejected = fold(board, ev("a-1", { type: "error", message: "turn already in progress" }), 0);
    expect(rejected.conversation[0]).toMatchObject({ role: "error", text: "turn already in progress" });
    const midTurn = fold(board, ev("a-1", { type: "error", turnId: "t-9", message: "model call failed" }), 1);
    expect(midTurn.conversation[1]?.text).toContain("t-9");
  });

  it("unknown event types are shown generically, not dropped", () => {
    const board = newBoard();
    const view = fold(board, ev("a-1", { type: "warp_drive", flux: 42 }), 0);
    expect(view.feed).toHaveLength(1);
    expect(view.feed[0]?.label).toBe("warp_drive");
    expect(view.feed[0]?.detail).toContain("42");
  });

  it("keeps agents separate", () => {
    const board = newBoard();
    fold(board, ev("a-1", { type: "text_delta", turnId: "t-1", text: "one" }), 0);
    fold(board, ev("a-2", { type: "text_delta", turnId: "t-1", text: "two" }), 0);
    expect(board.agents.get("a-1")?.conversation[0]?.text).toBe("one");
    expect(board.agents.get("a-2")?.conversation[0]?.text).toBe("two");
  });

  it("tracks lastSeen for staleness", () => {
    const board = newBoard();
    fold(board, ev("a-1", { type: "agent_ready", agentId: "a-1" }), 100);
    const view = fold(board, ev("a-1", { type: "text_delta", turnId: "t", text: "x" }), 900);
    expect(view.lastSeen).toBe(900);
  });
});
