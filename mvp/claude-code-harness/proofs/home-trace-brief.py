# Proof 26: a condensed view of home-trace.mts output. Collapses per-project
# and per-file names into patterns and drops the serve tag from the phase, so
# one line stands for one kind of access. The full listing stays the evidence.
#   python3 proofs/home-trace-brief.py <home-trace.txt>
import re, sys, collections
rows = collections.Counter()
bucket = None
order = []
for line in open(sys.argv[1]):
    if line.startswith('== '):
        bucket = line[3:].strip()
        if bucket not in order: order.append(bucket)
        continue
    m = re.match(r'\s+(W| ) \[(.*?)\] \{(.*?)\} (\S+) (\S+) ?(\S*) -> (.*?) x(\d+)$', line.rstrip())
    if not m: continue
    w, who, phase, call, path, flags, result, n = m.groups()
    phase = re.sub(r'^(fresh|resumed|x-\w+|y-\w+):', '', phase)
    path = re.sub(r'/tmp/claude-1000/[^/]+', '/tmp/claude-1000/<project>', path)
    path = re.sub(r'/node-compile-cache/[^/]+(/.*)?$', '/node-compile-cache/<...>', path)
    path = re.sub(r'/claude-[0-9a-f]{4}-cwd$', '/claude-<xxxx>-cwd', path)
    path = re.sub(r'/(mcp-logs-[^/]+)/[^/]+$', r'/\1/<log>', path)
    path = re.sub(r'/claude-cli-nodejs/[^/]+', '/claude-cli-nodejs/<project>', path)
    path = re.sub(r'/(bridge-spawn|served-calls|images)/[^/]+$', r'/\1/<entry>', path)
    who = re.sub(r'claude > bash > .*', 'claude > bash > (command)', who) if 'probe' in phase else who
    rows[(bucket, w, who, phase, call, path, flags, result)] += int(n)
for b in order:
    print('==', b)
    for k, n in sorted((k, n) for k, n in rows.items() if k[0] == b):
        _, w, who, phase, call, path, flags, result = k
        print(f'  {w} [{who}] {{{phase}}} {call} {path} {flags} -> {result} x{n}')
