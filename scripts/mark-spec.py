#!/usr/bin/env python3
# Sets the Note cell of spec rows: python3 scripts/mark-spec.py notes.json
# notes.json maps a row id (e.g. "D1") to its new note. Fails if a row is missing.
import json, re, sys
p = 'docs/specs/slate-photos-parity-001.md'
s = open(p).read()
notes = json.load(open(sys.argv[1]))
for k, v in notes.items():
    s, n = re.subn(rf"^(\| {re.escape(k)} \| .*? \| [A-Z ]+ \| (?:v1|v1\.x|Waived) \|)[^|\n]*\|$", lambda m: f"{m.group(1)} {v} |", s, flags=re.M)
    if n != 1: sys.exit(f'row {k} not found exactly once ({n})')
open(p, 'w').write(s)
print(f'marked {len(notes)} rows')
