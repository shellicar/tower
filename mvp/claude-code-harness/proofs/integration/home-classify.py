#!/usr/bin/env python3
# Classify every access under the real home by Claude Code's own processes
# (the bundled claude binary and every descendant not started through the
# shell prefix), from an `strace -f -y -ttt -s 0` trace (paths only).
#   home-classify.py <trace> <agent> <private-home>
import re, sys, collections, os
trace, agent, phome = sys.argv[1:4]
HOME = os.path.expanduser('~')
ST = f'{HOME}/.local/state/tower-claude-code-harness'
classes = [
    ('login', lambda p: p.startswith(f'{HOME}/.claude/.credentials') or p.startswith(f'{HOME}/.claude/.lock') or re.match(re.escape(f'{HOME}/.claude/') + r'.*lock', p) is not None),
    ('declared: agent config dir', lambda p: p == f'{ST}/config-dirs/{agent}' or p.startswith(f'{ST}/config-dirs/{agent}/')),
    ('declared: work dir', lambda p: p == f'{ST}/work/{agent}' or p.startswith(f'{ST}/work/{agent}/')),
    ('declared: durable state', lambda p: p == f'{ST}/integration/{agent}' or p.startswith(f'{ST}/integration/{agent}/')),
]
MUT = re.compile(r'^(unlink|unlinkat|rename|renameat2?|rmdir|mkdir|mkdirat|symlink|symlinkat|link|linkat|chmod|fchmodat|fchownat|chown|truncate|utimensat|bind|setxattr|removexattr)$')
lines = open(trace, errors='replace').read().split('\n')
parent, execs = {}, collections.defaultdict(list)
clone = re.compile(r'^(\d+) [\d.]+ (?:<\.\.\. )?(?:clone3?|fork|vfork)(?:\(| resumed>).*= (\d+)')
ex = re.compile(r'^(\d+) [\d.]+ execve\("([^"]+)"')
# execve can be split into "<unfinished ...>" and "<... execve resumed>) = 0"
pending = {}
for l in lines:
    m = clone.match(l)
    if m: parent[int(m.group(2))] = int(m.group(1))
    m = ex.match(l)
    if m:
        pid = int(m.group(1))
        if '<unfinished' in l: pending[pid] = m.group(2)
        elif re.search(r'= 0$', l): execs[pid].append(m.group(2))
    m = re.match(r'^(\d+) [\d.]+ <\.\.\. execve resumed>.*= 0$', l)
    if m and int(m.group(1)) in pending: execs[int(m.group(1))].append(pending.pop(int(m.group(1))))
def chain(pid):
    out, t = [], pid
    for _ in range(1000):
        if t is None: break
        out.append((t, execs.get(t, [])))
        t = parent.get(t)
    return out
def kind(pid):
    """claude | claude-child:<exe> | prefix (command via the shell prefix) | other"""
    passed = []
    for t, ex_ in chain(pid):
        if any(e.endswith('/claude') for e in ex_) and not any(e.endswith('home-shell-prefix.sh') for e in ex_):
            if not passed: return 'claude'
            if any(e.endswith('home-shell-prefix.sh') for x in passed for e in x): return 'prefix'
            return 'claude-child:' + os.path.basename(passed[0][-1])
        if ex_: passed.append(ex_)
    return 'other'
def paths(l):
    out = []
    m = re.match(r'^\d+ [\d.]+ (?:<\.\.\. )?(\w+)\((-?\d+|AT_FDCWD)(?:<([^>]*)>)?, "([^"]*)"', l)
    if m:
        d, n = m.group(3), m.group(4)
        if n.startswith('/'): out.append(n)
        elif d is not None: out.append(f'{d}/{n}' if n else d)
    for q in re.findall(r'"(/[^"]*)"', l):
        if q not in out: out.append(q)
    for q in re.findall(r'<(/[^>]*)>', l):
        pass  # fd annotations on reads/writes of an open fd: not listed (file ops use paths above)
    return out
agg = collections.Counter()
for l in lines:
    m = re.match(r'^(\d+) ([\d.]+) (?:<\.\.\. )?(\w+)', l)
    if not m: continue
    call = m.group(3)
    if call in ('execve', 'clone', 'clone3', 'exit_group', 'wait4', 'vfork', 'fork'): continue
    pid = int(m.group(1))
    k = kind(pid)
    if k in ('other', 'prefix'): continue
    for p in paths(l):
        if not (p == HOME or p.startswith(HOME + '/')): continue
        cls = next((c for c, f in classes if f(p)), 'else')
        flags = re.search(r'O_[A-Z_|]+', l)
        fl = flags.group(0) if flags else ''
        mut = bool(MUT.match(call)) or bool(re.search(r'O_CREAT|O_WRONLY|O_RDWR|O_TRUNC', fl))
        res = re.search(r'= (-?\d+)(?:<[^>]*>)?(?: ([A-Z]+))?', l)
        r = 'unfinished' if '<unfinished' in l else ('ok' if res and not res.group(1).startswith('-') else (res.group(2) if res else '?'))
        np = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<uuid>', p)
        np = re.sub(r'\d{6,}', '<n>', np)
        agg[(cls, 'W' if mut else 'R', k, call, np if cls == 'else' or mut else re.sub(r'^(' + re.escape(ST) + r'/[^/]+/[^/]+)/.*', r'\1/...', np), r)] += 1
by = collections.defaultdict(list)
for key, n in agg.items(): by[key[0]].append((key, n))
for cls in ['login', 'declared: agent config dir', 'declared: work dir', 'declared: durable state', 'else']:
    es = by.get(cls, [])
    w = sum(n for k, n in es if k[1] == 'W')
    print(f'== {cls}: {sum(n for _, n in es)} accesses, {w} mutating')
    for (c, W, k, call, p, r), n in sorted(es, key=lambda x: (x[0][1] != 'W', x[0][4], x[0][3])):
        if cls.startswith('declared') and W == 'R': continue
        print(f'  {W} [{k}] {call} {p} -> {r} x{n}')
    if cls.startswith('declared'):
        print(f'  (reads: {sum(n for k, n in es if k[1] == "R")})')
