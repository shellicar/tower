// The capture wrapper. The SDK is pointed at bin/claude-capture (which runs
// this file) as its `pathToClaudeCodeExecutable`; this process runs the real
// binary with the same argv and copies its stdin, stdout and stderr to files,
// each line stamped. Everything else passes through untouched.
//
// Each spawn gets its own numbered directory under <run>/claude/, so a run in
// which the SDK starts the binary more than once keeps every capture.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineRecorder, stamp } from './record.mts';

const captureRoot = process.env.HARNESS_CAPTURE_DIR;
const realBinary = process.env.HARNESS_REAL_CLAUDE;
if (!captureRoot || !realBinary) {
  process.stderr.write('claude-capture: HARNESS_CAPTURE_DIR and HARNESS_REAL_CLAUDE must both be set\n');
  process.exit(2);
}

function claimSpawnDir(root: string): string {
  mkdirSync(root, { recursive: true });
  for (let n = 1; ; n += 1) {
    const dir = join(root, String(n));
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }
}

const dir = claimSpawnDir(captureRoot);

const env = { ...process.env };
delete env.HARNESS_CAPTURE_DIR;
delete env.HARNESS_REAL_CLAUDE;

const argv = process.argv.slice(2);

// Env values are not recorded: inherited values can hold secrets (a parent
// Claude Code session exports a messaging token, for one). Names only.
writeFileSync(
  join(dir, 'argv.json'),
  `${JSON.stringify(
    {
      startedAt: stamp(),
      realBinary,
      argv,
      cwd: process.cwd(),
      wrapperPid: process.pid,
      envNames: Object.keys(env).sort(),
    },
    null,
    2,
  )}\n`,
);

const stdinRec = new LineRecorder(createWriteStream(join(dir, 'stdin.txt')));
const stdoutRec = new LineRecorder(createWriteStream(join(dir, 'stdout.txt')));
const stderrRec = new LineRecorder(createWriteStream(join(dir, 'stderr.txt')));

const child = spawn(realBinary, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });

const forwardedSignals: { at: string; signal: NodeJS.Signals }[] = [];
const stdinErrors: { at: string; message: string }[] = [];

process.stdin.on('data', (chunk: Buffer) => {
  stdinRec.push(chunk);
  child.stdin.write(chunk);
});
process.stdin.on('end', () => {
  child.stdin.end();
});
child.stdin.on('error', (err) => {
  // The binary exited while input was still arriving; the capture keeps it.
  stdinErrors.push({ at: stamp(), message: err.message });
});

child.stdout.on('data', (chunk: Buffer) => {
  stdoutRec.push(chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk: Buffer) => {
  stderrRec.push(chunk);
  process.stderr.write(chunk);
});

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) {
  process.on(signal, () => {
    forwardedSignals.push({ at: stamp(), signal });
    child.kill(signal);
  });
}

child.on('error', (err) => {
  process.stderr.write(`claude-capture: failed to start ${realBinary}: ${err.message}\n`);
});

child.on('close', async (code, signal) => {
  const exitedAt = stamp();
  process.stdin.destroy();
  await Promise.all([stdinRec.end(), stdoutRec.end(), stderrRec.end()]);
  writeFileSync(
    join(dir, 'exit.json'),
    `${JSON.stringify(
      {
        exitedAt,
        code,
        signal,
        forwardedSignals,
        stdinErrors,
        trailingPartialLine: { stdin: stdinRec.trailingPartial, stdout: stdoutRec.trailingPartial, stderr: stderrRec.trailingPartial },
        redactions: { stdin: stdinRec.redactions, stdout: stdoutRec.redactions, stderr: stderrRec.redactions },
      },
      null,
      2,
    )}\n`,
  );
  if (signal) {
    for (const s of signals) {
      process.removeAllListeners(s);
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
