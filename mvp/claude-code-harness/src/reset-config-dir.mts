// The only way to reset an agent's config directory: "we shouldnt make the
// agents use rm / ie they use a script to do it 'safely'" (Stephen, 27 Sep).
// Runs resetConfigDir, with all its refusals, and prints what it did.
//
//   pnpm reset-config-dir <name>
//
// Exit 0: reset. Exit 1: refused (the reason on stderr). Exit 2: usage.

import { resetConfigDir } from './harness.mts';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === undefined) {
  process.stderr.write('usage: pnpm reset-config-dir <name>\n');
  process.exit(2);
}
const name = args[0];

try {
  const result = resetConfigDir(name);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
