import { describe, expect, it } from 'vitest';
import { ClaudeCodeProcess } from '../src/ClaudeCodeProcess.js';
import type { ChildProcessHandle } from '../src/ProcessSpawner.js';
import { FakeChild } from './support.js';

function child(pid: number | undefined = 4001): FakeChild {
  return new FakeChild(pid);
}

function started(running: FakeChild): ClaudeCodeProcess {
  const claudeCode = new ClaudeCodeProcess();
  claudeCode.started(running as unknown as ChildProcessHandle);
  return claudeCode;
}

/** Whether `exited` has settled once pending callbacks have run. */
async function hasSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

describe('ClaudeCodeProcess', () => {
  it('has no pid before the SDK starts it', () => {
    expect(new ClaudeCodeProcess().runningPid).toBeUndefined();
  });

  it("has Claude Code's pid while it runs", () => {
    expect(started(child(4321)).runningPid).toBe(4321);
  });

  it('has no pid once Claude Code has exited, so a reused pid is never signalled', () => {
    const running = child(4321);
    const claudeCode = started(running);
    running.exit(0);
    expect(claudeCode.runningPid).toBeUndefined();
  });

  it('has not exited while Claude Code runs', async () => {
    expect(await hasSettled(started(child()).exited)).toBe(false);
  });

  it('has exited once Claude Code exits', async () => {
    const running = child();
    const claudeCode = started(running);
    running.exit(0);
    expect(await hasSettled(claudeCode.exited)).toBe(true);
  });

  it('has exited once Claude Code is killed by a signal', async () => {
    const running = child();
    const claudeCode = started(running);
    running.exit(null, 'SIGTERM');
    expect(await hasSettled(claudeCode.exited)).toBe(true);
  });

  it('has exited when the start failed', async () => {
    expect(await hasSettled(started(new FakeChild(undefined)).exited)).toBe(true);
  });

  it('has exited when Claude Code had exited before it was handed over', async () => {
    const gone = child();
    gone.exit(1);
    expect(await hasSettled(started(gone).exited)).toBe(true);
  });
});
