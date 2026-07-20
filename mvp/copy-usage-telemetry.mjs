#!/usr/bin/env node
// Companion to migrate-usage-retention.sh: drains every `conv.v2.*.telemetry.usage`
// message already sitting in a source stream and republishes it verbatim (same
// subject, same payload) to the broker, so it lands in whichever stream currently
// claims that subject. Shells out to the `nats` CLI for both drain and publish —
// no NATS client library dependency, nothing new to install.
//
// Usage: node copy-usage-telemetry.mjs <sourceStream> <expectedCount>
// Exits non-zero on any mismatch or failure. Prints one line per republished
// message count, nothing else on success.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [, , sourceStream, expectedCountArg] = process.argv;
if (!sourceStream || !expectedCountArg) {
  console.error('usage: copy-usage-telemetry.mjs <sourceStream> <expectedCount>');
  process.exit(1);
}
const expectedCount = Number(expectedCountArg);
if (!Number.isInteger(expectedCount) || expectedCount < 0) {
  console.error(`expectedCount must be a non-negative integer, got ${expectedCountArg}`);
  process.exit(1);
}

const natsUrl = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const consumerName = `usage-migrate-${randomUUID().slice(0, 8)}`;

// spawnSync's default maxBuffer is 1MB — thousands of messages' worth of
// drain output blows straight past that and kills the process silently
// (empty stderr, non-zero/null status), which looked like a broker failure
// but wasn't one. 256MB is far past anything this migration will ever emit.
const MAX_BUFFER = 256 * 1024 * 1024;

function run(args) {
  const result = spawnSync('nats', ['--server', natsUrl, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (result.error) {
    throw new Error(`nats ${args.join(' ')} failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`nats ${args.join(' ')} failed (status ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

function runWithStdin(args, stdin) {
  const result = spawnSync('nats', ['--server', natsUrl, ...args], { encoding: 'utf8', input: stdin, maxBuffer: MAX_BUFFER });
  if (result.error) {
    throw new Error(`nats ${args.join(' ')} failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`nats ${args.join(' ')} failed (status ${result.status}):\n${result.stderr}`);
  }
  return result.stdout;
}

if (expectedCount === 0) {
  console.log('nothing to copy (expectedCount is 0)');
  process.exit(0);
}

console.error(`creating pull consumer ${consumerName} on ${sourceStream}, filtered to conv.v2.*.telemetry.usage`);
run([
  'consumer', 'add', sourceStream, consumerName,
  '--filter', 'conv.v2.*.telemetry.usage',
  '--deliver', 'all', '--ack', 'none', '--replay', 'instant', '--pull', '--defaults',
]);

let copied = 0;
try {
  const output = run(['consumer', 'next', sourceStream, consumerName, '--count', String(expectedCount), '--no-ack']);

  // Each message is a header line ("[time] subj: X / ...") then a blank line
  // then the JSON body, repeated. Parse pairs, tolerant of the banner/summary
  // lines the CLI also prints.
  const lines = output.split('\n');
  const headerRe = /^\[[^\]]*\]\s+subj:\s+(\S+)\s+\//;
  for (let i = 0; i < lines.length; i++) {
    const match = headerRe.exec(lines[i]);
    if (!match) continue;
    const subject = match[1];
    // Skip forward to the next non-empty line — that is the JSON body.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    const body = lines[j];
    if (!body || !body.trim().startsWith('{')) {
      throw new Error(`expected a JSON body after header for ${subject}, got: ${body}`);
    }
    runWithStdin(['pub', subject, '--force-stdin'], body);
    copied++;
    i = j;
  }
} finally {
  run(['consumer', 'rm', sourceStream, consumerName, '-f']);
}

if (copied !== expectedCount) {
  console.error(`copied ${copied} messages, expected ${expectedCount} — mismatch, investigate before purging the source`);
  process.exit(1);
}
console.log(`copied ${copied} messages from ${sourceStream}`);
