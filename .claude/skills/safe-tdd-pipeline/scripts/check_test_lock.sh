#!/usr/bin/env bash
# check_test_lock.sh - lock the approved specs + tests, then prove nobody touched them.
#
#   check_test_lock.sh --lock            fingerprint specs/ and tests/ (end of Stage 1, after approval)
#   check_test_lock.sh                   verify nothing was added, changed or deleted (Stage 2/3)
#   check_test_lock.sh --expect HASH     also require the lock file itself to be the one approved
#   check_test_lock.sh --status          print the current lock hash
#
# Run from anywhere inside the repo. Env: SAFE_TDD_LOCK_DIRS (default: "specs tests").
# Exit: 0 intact | 1 tampered / nothing to lock | 2 usage | 3 no lock recorded
set -u

mode=verify
expect=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lock) mode=lock ;;
    --status) mode=status ;;
    --expect) expect="${2:-}"; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$root" || exit 2
state=.safe-tdd
manifest=$state/test-lock.sha256
dirs=${SAFE_TDD_LOCK_DIRS:-specs tests}

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# One line per file: "<hash> <path>" (paths normalised, sorted, stable across runs)
fingerprint() {
  for d in $dirs; do
    [ -d "$d" ] && find "$d" -type f \
      ! -path '*/node_modules/*' ! -path '*/__pycache__/*' ! -path '*/.pytest_cache/*' ! -name '*.pyc'
  done | LC_ALL=C sort | while IFS= read -r f; do
    h=$(sha "$f" | awk '{print $1}')
    printf '%s %s\n' "$h" "$f"
  done
}

lock_hash() { sha "$manifest" | awk '{print $1}'; }

case "$mode" in
  lock)
    mkdir -p "$state"
    [ -f "$state/.gitignore" ] || echo '*' > "$state/.gitignore"
    fingerprint > "$manifest.tmp"
    n=$(wc -l < "$manifest.tmp" | tr -d ' ')
    if [ "$n" -eq 0 ]; then
      rm -f "$manifest.tmp"
      echo "TEST-LOCK: nothing to lock - no files under: $dirs. Write the spec and tests first." >&2
      exit 1
    fi
    mv "$manifest.tmp" "$manifest"
    echo "TEST-LOCK: locked $n file(s) under: $dirs"
    echo "LOCK_HASH=$(lock_hash)"
    ;;
  status)
    [ -f "$manifest" ] || { echo "TEST-LOCK: no lock recorded"; exit 3; }
    echo "LOCK_HASH=$(lock_hash) ($(wc -l < "$manifest" | tr -d ' ') files)"
    ;;
  verify)
    [ -f "$manifest" ] || { echo "TEST-LOCK: FAIL - no lock recorded (run --lock after the spec is approved)"; exit 3; }
    rc=0
    if [ -n "$expect" ] && [ "$(lock_hash)" != "$expect" ]; then
      echo "TEST-LOCK: FAIL - the lock file was rewritten (hash $(lock_hash), approved $expect)"
      rc=1
    fi
    report=$(fingerprint | awk '
      NR == FNR { sp = index($0, " "); old[substr($0, sp + 1)] = substr($0, 1, sp - 1); next }
      { sp = index($0, " "); p = substr($0, sp + 1); h = substr($0, 1, sp - 1)
        if (!(p in old)) print "  ADDED    " p
        else if (old[p] != h) print "  CHANGED  " p
        seen[p] = 1 }
      END { for (p in old) if (!(p in seen)) print "  DELETED  " p }
    ' "$manifest" -)
    if [ -n "$report" ]; then
      echo "TEST-LOCK: FAIL - locked specs/tests were modified:"
      echo "$report" | LC_ALL=C sort -k2
      rc=1
    fi
    [ $rc -eq 0 ] && echo "TEST-LOCK: PASS - $(wc -l < "$manifest" | tr -d ' ') locked file(s) unchanged"
    exit $rc
    ;;
esac
