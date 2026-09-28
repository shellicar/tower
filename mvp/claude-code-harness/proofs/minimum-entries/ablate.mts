// Minimum entries: from a commit-resume plan (plan.mts, or p24-plan.mts for
// proof 24's recordings), take each chosen pickup's R0@ holding (every
// entry Claude Code appended, resumed at the last main entry with a uuid)
// and write variants of it with entry kinds left out, as a new plan that
// commit-resume/run.mts can run. compare.mts here compares each variant's
// request with the base's and with the live one.
//
// An entry's kind is its `type`, plus `subtype` (system) or
// `attachment.type` (attachment). `user` and `assistant` are never left out
// on their own. Only the main session's entries change; a subagent's
// (subpath) appends are passed through as they are.
//
// Variants per pickup:
//   base              the R0@ holding as it is
//   -<kind>           an entry kind without a uuid (off the chain) left out
//   -<kind>/b         an entry kind on the chain left out, links as they are
//                     (broken: a child still names the missing entry)
//   -<kind>/r         the same, each kept entry whose parentUuid names a
//                     left-out entry re-pointed to the nearest kept ancestor
//   -offchain         every entry without a uuid left out
//   -attach/b|r       every attachment entry left out
//   -system/b|r       every system entry left out
//   conv/b|r          only user and assistant entries kept
//   keep:<k+k>/b|r    only user, assistant and the named kinds kept
//                     (--keep k1+k2,k3 adds one such variant per set)
//
// resumeSessionAt is always the uuid of the last main entry the reduced
// holding still has (the base's rule, applied after the cut). Re-pointing
// is done here rather than in load(): load() only returns the holding, so
// the entries Claude Code gets are the same either way.
//
//   node proofs/minimum-entries/ablate.mts <source-plan-dir> <out-dir>
//        [--pickups scen/point,...] [--only-live] [--variants base,-kind/b,...]
//        [--keep k1+k2,k3] [--no-singles]

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Json = Record<string, unknown>;
interface Key {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}
interface Holding {
  appends: { key: Key; entries: Json[] }[];
  resumeSessionAt: string | null;
}
interface Pickup {
  scenario: string;
  rep: number;
  sessionId: string;
  point: string;
  probe: string;
  options: Json;
  refs: { kind: string; file: string }[];
  holdings: Record<string, string>;
}

const kindOf = (e: Json): string => {
  const a = e.attachment as Json | undefined;
  return `${String(e.type)}${e.subtype ? `:${String(e.subtype)}` : ''}${a && typeof a.type === 'string' ? `:${a.type}` : ''}`;
};
const CONV = new Set(['user', 'assistant']);

function variant(base: Holding, drop: (e: Json) => boolean, relink: boolean): Holding {
  const main = base.appends.find((a) => !a.key.subpath);
  if (!main) {
    return base;
  }
  const parentOf = new Map<string, string | null>();
  const dropped = new Set<string>();
  for (const e of main.entries) {
    if (typeof e.uuid === 'string') {
      parentOf.set(e.uuid, typeof e.parentUuid === 'string' ? e.parentUuid : null);
      if (drop(e)) {
        dropped.add(e.uuid);
      }
    }
  }
  const kept: Json[] = [];
  for (const e of main.entries) {
    if (drop(e)) {
      continue;
    }
    if (relink && typeof e.parentUuid === 'string' && dropped.has(e.parentUuid)) {
      let p: string | null = e.parentUuid;
      while (p !== null && dropped.has(p)) {
        p = parentOf.get(p) ?? null;
      }
      kept.push({ ...e, parentUuid: p });
    } else {
      kept.push(e);
    }
  }
  let at: string | null = null;
  for (let i = kept.length - 1; i >= 0; i -= 1) {
    const u = (kept[i] as Json).uuid;
    if (typeof u === 'string') {
      at = u;
      break;
    }
  }
  return { appends: base.appends.map((a) => (a === main ? { key: a.key, entries: kept } : a)), resumeSessionAt: at };
}

function main(): void {
  const src = resolve(process.argv[2] ?? '');
  const out = resolve(process.argv[3] ?? '');
  if (!process.argv[2] || !process.argv[3]) {
    process.stderr.write('usage: ablate.mts <source-plan-dir> <out-dir> [...]\n');
    process.exit(2);
  }
  const args = process.argv.slice(4);
  const opt = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const want = opt('--pickups') ? new Set(String(opt('--pickups')).split(',')) : undefined;
  const onlyLive = args.includes('--only-live');
  const onlyVariants = opt('--variants') ? new Set(String(opt('--variants')).split(',')) : undefined;
  const keeps = opt('--keep') ? String(opt('--keep')).split(',') : [];
  const singles = !args.includes('--no-singles');

  let pickups = JSON.parse(readFileSync(join(src, 'pickups.json'), 'utf8')) as Pickup[];
  if (want) {
    pickups = pickups.filter((p) => want.has(`${p.scenario}/${p.point}`));
  }
  if (onlyLive) {
    pickups = pickups.filter((p) => p.refs.some((r) => r.kind === 'live'));
  }
  const hdir = join(out, 'holdings');
  mkdirSync(hdir, { recursive: true });
  const saved = new Set<string>();
  const save = (h: Holding): string => {
    const id = createHash('sha256').update(JSON.stringify(h)).digest('hex').slice(0, 16);
    if (!saved.has(id)) {
      writeFileSync(join(hdir, `${id}.json`), JSON.stringify(h));
      saved.add(id);
    }
    return id;
  };
  const outPickups: Json[] = [];
  const jobs = new Map<string, Json>();
  for (const p of pickups) {
    const base = JSON.parse(readFileSync(join(src, 'holdings', `${p.holdings['R0@'] as string}.json`), 'utf8')) as Holding;
    const main = base.appends.find((a) => !a.key.subpath);
    const entries = main?.entries ?? [];
    const kinds = new Map<string, boolean>(); // kind -> on the chain
    for (const e of entries) {
      const k = kindOf(e);
      kinds.set(k, (kinds.get(k) ?? false) || typeof e.uuid === 'string');
    }
    const vs: Record<string, Holding> = { base };
    if (singles) {
      for (const [k, chain] of [...kinds].sort()) {
        if (CONV.has(k)) {
          continue;
        }
        const d = (e: Json): boolean => kindOf(e) === k;
        if (chain) {
          vs[`-${k}/b`] = variant(base, d, false);
          vs[`-${k}/r`] = variant(base, d, true);
        } else {
          vs[`-${k}`] = variant(base, d, false);
        }
      }
      vs['-offchain'] = variant(base, (e) => typeof e.uuid !== 'string', false);
      for (const [name, d] of [
        ['-attach', (e: Json) => e.type === 'attachment'],
        ['-system', (e: Json) => e.type === 'system'],
        ['conv', (e: Json) => !CONV.has(String(e.type))],
      ] as const) {
        vs[`${name}/b`] = variant(base, d, false);
        vs[`${name}/r`] = variant(base, d, true);
      }
    }
    for (const set of keeps) {
      const keep = new Set([...CONV, ...set.split('+').filter((x) => x !== '')]);
      const d = (e: Json): boolean => !keep.has(kindOf(e));
      vs[`keep:${set}/b`] = variant(base, d, false);
      vs[`keep:${set}/r`] = variant(base, d, true);
    }
    const holdings: Record<string, string> = {};
    for (const [name, h] of Object.entries(vs)) {
      if (onlyVariants && name !== 'base' && !onlyVariants.has(name)) {
        continue;
      }
      holdings[name] = save(h);
    }
    // What each variant left out, for the report: kind -> count.
    const kindCounts: Record<string, number> = {};
    for (const e of entries) {
      kindCounts[kindOf(e)] = (kindCounts[kindOf(e)] ?? 0) + 1;
    }
    outPickups.push({ ...p, holdings, kinds: kindCounts });
    for (const [name, h] of Object.entries(holdings)) {
      const id = createHash('sha256')
        .update(JSON.stringify([h, p.probe, p.options, p.sessionId]))
        .digest('hex')
        .slice(0, 16);
      if (!jobs.has(id)) {
        jobs.set(id, { id, holding: h, probe: p.probe, options: p.options, sessionId: p.sessionId, first: `${p.scenario}/${p.point}/${name}` });
      }
    }
  }
  writeFileSync(join(out, 'pickups.json'), `${JSON.stringify(outPickups, null, 1)}\n`);
  writeFileSync(join(out, 'jobs.json'), `${JSON.stringify([...jobs.values()], null, 1)}\n`);
  writeFileSync(join(out, 'source.txt'), `${src}\n`);
  process.stdout.write(`${outPickups.length} pickups, ${saved.size} holdings, ${jobs.size} jobs -> ${out}\n`);
}

main();
