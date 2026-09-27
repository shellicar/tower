# Proof 26: from a condensed trace (home-trace-brief.txt), the accesses Claude
# Code's own process made outside the run's own directories, with the ones
# that are only lookups dropped: the ancestor walk (stat of <dir>/.claude/*,
# .git, ignore files), PATH searches and stats of the directories on the way
# to the working dir. Every write (W) by any process except the Bash tool's
# commands is kept.
#   python3 proofs/home-trace-machinery.py <home-trace-brief.txt>
import re, sys
bucket = None
walk = re.compile(r'/(\.git|HEAD|\.gitignore|\.ignore|\.rgignore)(/|$)|/\.claude/(agents|commands|skills|workflows|output-styles)$|/\.git/info/exclude')
for line in open(sys.argv[1]):
    if line.startswith('== '):
        bucket = line.strip(); continue
    m = re.match(r'\s+(W| ) \[(.*?)\] \{(.*?)\} (\S+) (\S+)', line)
    if not m: continue
    w, who, phase, call, path = m.groups()
    if who == 'claude > bash > (command)': continue
    if w != 'W':
        if who != 'claude': continue
        if call in ('statx', 'readlink', 'newfstatat', 'stat') and (walk.search(path) or re.fullmatch(r'/home/[^/]+(/\.local(/state)?)?|/home/[^/]+/\.claude(/state)?|/tmp|/tmp/claude-\d+|/run/user/<n>', path)):
            continue
        if walk.search(path): continue
    print(f'{bucket[3:]:<18} {line.rstrip()[2:]}'[:230])
