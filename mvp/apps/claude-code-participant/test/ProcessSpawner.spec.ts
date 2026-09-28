import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { NodeProcessSpawner } from '../src/ProcessSpawner.js';

function isRunning(pid: number): boolean {
  try {
    // Signal 0 only asks whether the process exists.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === 'win32')('NodeProcessSpawner', () => {
  it('ends every process in the group it signals', async () => {
    const spawner = new NodeProcessSpawner();
    // A leader in a group of its own with a second process in that group,
    // whose pid it prints.
    const leader = spawner.spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { cwd: undefined, env: { PATH: process.env.PATH }, signal: new AbortController().signal, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] }) as unknown as ChildProcess;
    const [output] = (await once(leader.stdout as NodeJS.ReadableStream, 'data')) as [Buffer];
    const member = Number(output.toString().trim());
    const exited = once(leader, 'exit');
    spawner.signalGroup(leader.pid as number, 'SIGTERM');
    await exited;
    // The member may take a moment to be reaped by init once it's killed.
    const deadline = Date.now() + 2000;
    while (isRunning(member) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const survived = isRunning(member);
    if (survived) {
      // Nothing this test started is left behind, even when it fails.
      process.kill(member, 'SIGKILL');
    }
    expect(survived).toBe(false);
  });
});
