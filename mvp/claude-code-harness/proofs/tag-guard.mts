// Proof 25: the tag scan as a reset guard, read-only. Never deletes anything.
//
//   node proofs/tag-guard.mts <name>
//
// Exit 0: no process carries TOWER_AGENT=<name>; a reset would go ahead.
// Exit 1: refused; each tagged process is named on stderr.
// Exit 2: usage.
// Stdout, either way: one JSON line, the scan's time and the pids found.
//
// Not wired into the harness's reset (src/harness.mts): that is unchanged.

import { scanTag } from './tag-scan.mts';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0]) {
  process.stderr.write('usage: node proofs/tag-guard.mts <name>\n');
  process.exit(2);
}
const name = args[0];
const scan = scanTag(name);
process.stdout.write(`${JSON.stringify({ name, at: scan.at, ms: scan.ms, scanned: scan.scanned, ownUidUnreadable: scan.ownUidUnreadable.length, found: scan.found.map((p) => ({ pid: p.pid, starttime: p.starttime, pidFileLive: p.pidFileLive, cmd: p.cmd.slice(0, 40) })) })}\n`);
if (scan.found.length > 0) {
  process.stderr.write(`tag-guard: would refuse to reset ${JSON.stringify(name)}: ${scan.found.length} process(es) carry the tag: ${scan.found.map((p) => `pid ${p.pid} (start ${p.starttime}, ${p.pidFileLive ? 'live pid file' : 'no live pid file'}, ${p.cmd.slice(0, 40)})`).join('; ')}\n`);
  process.exit(1);
}
