# Summarise a batch.sh log (argv[1]): per seed, each resume's first request against the
# full-record resume (messages, whole body minus billing header/metadata, cache).
import json, os, re, sys, collections
here = os.path.dirname(os.path.abspath(__file__)) + '/../..'
rows = collections.OrderedDict()
for line in open(sys.argv[1]):
    m = re.match(r'(runs/\S+) (\S+) (runs/\S+)', line)
    if m:
        rows.setdefault(m[1], {})[m[2]] = m[3]
def first(run):
    idx = [json.loads(l) for l in open(os.path.join(here, run, 'api-bodies/index.jsonl')) if '"sdk"' in l]
    if not idx:
        return None, None
    b = json.load(open(os.path.join(here, run, 'api-bodies', idx[0]['request_file'])))
    r = json.load(open(os.path.join(here, run, 'api-bodies', idx[0]['response_file'])))
    return b, r['usage']
def strip(m):
    c = m['content']
    if isinstance(c, str):
        return json.dumps({'role': m['role'], 'content': c})
    out = []
    for b in c:
        b = {k: v for k, v in b.items() if k != 'cache_control'}
        if b.get('type') == 'thinking':
            b.pop('thinking', None)
        out.append(b)
    return json.dumps({'role': m['role'], 'content': out})
for seed, srcs in rows.items():
    print('==', seed)
    base, _ = first(srcs['full'])
    for src, run in srcs.items():
        b, u = first(run)
        if b is None:
            print('  %-9s %s  NO REQUEST' % (src, run)); continue
        msgs = [strip(m) for m in b['messages']]
        bm = [strip(m) for m in base['messages']]
        diffs = [i for i in range(max(len(msgs), len(bm))) if i >= len(msgs) or i >= len(bm) or msgs[i] != bm[i]]
        other = sorted(k for k in set(b) | set(base) if k not in ('messages', 'metadata', 'system') and json.dumps(b.get(k)) != json.dumps(base.get(k)))
        sysd = json.dumps(b['system'][1:]) != json.dumps(base['system'][1:])
        hdr = lambda q: dict(x.split('=', 1) for x in q['system'][0]['text'].split(': ', 1)[1].strip(';').split('; '))
        ha, hb = hdr(base), hdr(b)
        # cc_prompt_id differs between any two runs (noise floor), as does metadata's device id.
        other += ['billing.' + k for k in sorted(set(ha) | set(hb)) if k != 'cc_prompt_id' and ha.get(k) != hb.get(k)]
        print('  %-9s %s  messages %s; other fields differ: %s%s | cache_read %s cache_write %s input %s' % (
            src, run.split('/')[-1][:24], 'identical' if not diffs else 'differ at %s' % diffs, other or 'none',
            ' +system' if sysd else '', u.get('cache_read_input_tokens'), u.get('cache_creation_input_tokens'), u.get('input_tokens')))
