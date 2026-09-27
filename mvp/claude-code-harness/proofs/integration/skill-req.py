#!/usr/bin/env python3
# What reached each main-loop request about skills, per lineage: the sequence
# of skill listings (names starting int-, markers), skill invocations, skill
# bodies loaded, and "no command" notices, across the request's messages.
# Also the non-int names of each listing. Prints nothing else of the bodies.
import glob, json, re, sys, os

def texts(m):
    c = m['content']
    if isinstance(c, str):
        return [c]
    return [x.get('text') or (json.dumps(x.get('content')) if x.get('type') == 'tool_result' else '') for x in c]

def seq(body):
    out = []
    for m in body['messages']:
        for t in texts(m):
            for blk in re.findall(r'The following skills are available for use with the Skill tool:(.*?)</system-reminder>', t, re.S):
                names = re.findall(r'^- ([\w:-]+):', blk, re.M)
                ints = [(n, (re.search(r'^- ' + re.escape(n) + r':.*?MARKER=(\w+)', blk, re.M) or [None, None])[1]) for n in names if n.startswith('int-')]
                others = sorted(n for n in names if not n.startswith('int-'))
                out.append(('listing', m['role'], ints, len(others)))
            for n in re.findall(r'<command-name>/([\w-]+)</command-name>', t):
                out.append(('invoke', n))
            for n in re.findall(r'Base directory for this skill: \S*/skills/([\w-]+)', t):
                out.append(('body-loaded', n))
            for n in re.findall(r'slash command /([\w-]+), but no command with that name is available', t):
                out.append(('no-command', n))
            if 'Unknown skill' in t:
                out.append(('unknown-skill', re.search(r'Unknown skill[^"<]{0,40}', t).group(0)))
    return out

def main(lineage):
    idx = [json.loads(l) for l in open(os.path.join(lineage, 'api-bodies', 'index.jsonl')) if l.strip()]
    res = []
    for r in sorted(idx, key=lambda r: r['timestamp']):
        if r.get('query_source') != 'sdk':
            continue
        f = os.path.join(lineage, 'api-bodies', r['request_file'])
        if not os.path.exists(f):
            continue
        b = json.load(open(f))
        last = b['messages'][-1]
        lastText = ' '.join(texts(last))[-80:].replace('\n', ' ')
        res.append({'ts': r['timestamp'], 'last': lastText, 'seq': seq(b)})
    return res

if __name__ == '__main__':
    out = {}
    for l in sys.argv[1:]:
        out[l] = main(l)
    print(json.dumps(out, indent=1))
