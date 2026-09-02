import json, os
p = os.path.expanduser('~/.claude/settings.json')
s = json.load(open(p))
allow = s.setdefault('permissions', {}).setdefault('allow', [])
bad = [r for r in allow if r.startswith('Bash(ai-dossier sched') and not r.endswith(':*)')]
for r in bad: allow.remove(r)
for r in ['Bash(ai-dossier sched enqueue:*)', 'Bash(ai-dossier sched status:*)']:
    if r not in allow: allow.append(r)
json.dump(s, open(p, 'w'), indent=2)
print('removed malformed:', bad)
print('sched rules now:', [r for r in allow if 'sched' in r])
