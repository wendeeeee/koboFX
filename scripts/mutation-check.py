#!/usr/bin/env python3
"""
Prove a test can fail (CLAUDE.md: "remove the guard, watch it go red, restore").

Backs up FILE, applies each exact --replace OLD NEW (each OLD must occur exactly once),
runs one Jest test, and ALWAYS restores the file. Exit 0 when the mutant is killed (the
test failed), 1 when it survived.

  python3 scripts/mutation-check.py --file src/x.ts --replace 'old' 'new' \
      --project integration --path 'integration/funding-concurrency' --name 'several resumers'
"""
import argparse
import shutil
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--file', required=True)
parser.add_argument('--replace', nargs=2, action='append', metavar=('OLD', 'NEW'), required=True)
parser.add_argument('--project', default='integration')
parser.add_argument('--path', required=True)
parser.add_argument('--name', required=True)
args = parser.parse_args()

backup = args.file + '.mutation-backup'
shutil.copyfile(args.file, backup)
try:
    source = open(args.file).read()
    for old, new in args.replace:
        count = source.count(old)
        if count != 1:
            sys.exit(f'--replace target found {count} times (need exactly 1): {old!r}')
        source = source.replace(old, new)
    open(args.file, 'w').write(source)
    result = subprocess.run(
        ['npx', 'jest', '--selectProjects', args.project, '--runInBand', '--testPathPattern', args.path, '-t', args.name],
        capture_output=True, text=True,
    )
    output = result.stdout + result.stderr
    summary = [line for line in output.splitlines() if 'Tests:' in line]
    print(summary[-1] if summary else output[-2000:])
    if not summary or ' 0 total' in summary[-1] or 'failed' not in summary[-1] and result.returncode != 0:
        # No test ran (e.g. the mutant does not compile): that proves nothing.
        print(f'INVALID MUTANT: no test ran — fix the mutation\n{output[-1500:]}')
        sys.exit(2)
    if result.returncode == 0:
        print(f'MUTANT SURVIVED: {args.file} — the test "{args.name}" did not notice')
        sys.exit(1)
    print(f'MUTANT KILLED: "{args.name}" failed without the guard in {args.file}')
finally:
    shutil.move(backup, args.file)
