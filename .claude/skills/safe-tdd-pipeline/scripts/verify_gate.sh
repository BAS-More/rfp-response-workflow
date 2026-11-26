#!/usr/bin/env bash
# verify_gate.sh - the automated gatekeeper (Stage 3). Run from anywhere inside the repo.
#
# Checks, each reported PASS / FAIL / SKIP:
#   test-lock  specs/ + tests/ unchanged since approval   (check_test_lock.sh)
#   typecheck  repo's typecheck script, else tsc / mypy / pyright / go vet when configured
#   lint       repo's lint script, else ruff / cargo clippy when configured
#   tests      the full test suite (FAILS if no test runner is found - TDD needs tests)
#   e2e        test:e2e / e2e script when the repo has one
#   secrets    hardcoded keys/tokens/private keys + tracked .env files (gitleaks if installed)
#
# Exit 0 only when nothing FAILed. Full output: .safe-tdd/gate.log  Summary: .safe-tdd/gate-report.txt
# Env:
#   SAFE_TDD_EXPECT_LOCK=<hash>  require the approved lock hash (strongly recommended)
#   SAFE_TDD_SKIP=lint,e2e       skip named checks - reported as SKIP, never as PASS
#   SAFE_TDD_ALLOW_NO_TESTS=1    report a missing test runner as SKIP instead of FAIL
#   SAFE_TDD_BUILTIN_SCAN=1      use the built-in secret scanner even when gitleaks is installed
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$root" || exit 2
mkdir -p .safe-tdd
[ -f .safe-tdd/.gitignore ] || echo '*' > .safe-tdd/.gitignore
log=.safe-tdd/gate.log
: > "$log"

results=()
found_tests=0
record() { results+=("$1|$2|$3"); }
skipped() { case ",${SAFE_TDD_SKIP:-}," in *",$1,"*) return 0 ;; esac; return 1; }
run_check() {
  local name=$1; shift
  if skipped "$name"; then record "$name" SKIP "skipped by SAFE_TDD_SKIP"; return; fi
  echo "===== $name: $*" >> "$log"
  "$@" >> "$log" 2>&1
  local rc=$?
  if [ $rc -eq 0 ]; then record "$name" PASS "$*"; else record "$name" FAIL "$* (exit $rc)"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1. test lock ----------
if skipped test-lock; then
  record test-lock SKIP "skipped by SAFE_TDD_SKIP"
elif [ -f .safe-tdd/test-lock.sha256 ]; then
  run_check test-lock bash "$here/check_test_lock.sh" ${SAFE_TDD_EXPECT_LOCK:+--expect "$SAFE_TDD_EXPECT_LOCK"}
else
  record test-lock FAIL "no lock recorded - run check_test_lock.sh --lock after spec approval"
fi

# ---------- 2. JavaScript / TypeScript ----------
if [ -f package.json ]; then
  if   [ -f pnpm-lock.yaml ]; then pm=pnpm
  elif [ -f yarn.lock ]; then pm=yarn
  elif [ -f bun.lockb ] || [ -f bun.lock ]; then pm=bun
  else pm=npm; fi
  scripts=" $(node -e 'try{const s=require(process.cwd()+"/package.json").scripts||{};process.stdout.write(Object.keys(s).join(" "))}catch(e){}' 2>/dev/null) "
  hs() { case "$scripts" in *" $1 "*) return 0 ;; esac; return 1; }
  if ! have node; then record node FAIL "package.json found but node is not installed"; fi

  tc=""; for s in typecheck type-check check-types tsc; do hs "$s" && { tc=$s; break; }; done
  if [ -n "$tc" ]; then run_check typecheck "$pm" run "$tc"
  elif [ -f tsconfig.json ] && [ -x node_modules/.bin/tsc ]; then run_check typecheck node_modules/.bin/tsc --noEmit
  fi
  hs lint && run_check lint "$pm" run lint
  if hs test && ! node -e 'process.exit(/no test specified/.test(require(process.cwd()+"/package.json").scripts.test)?0:1)' 2>/dev/null; then
    run_check tests env CI=1 "$pm" run test   # CI=1 stops vitest/jest from entering watch mode
    found_tests=1
  fi
  for s in test:e2e e2e test:integration; do hs "$s" && { run_check e2e env CI=1 "$pm" run "$s"; break; }; done
fi

# ---------- 3. Python ----------
if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ] || [ -f requirements.txt ] || [ -f pytest.ini ]; then
  py=python3; have python3 && python3 -c '' 2>/dev/null || py=python
  pr=""
  if [ -f uv.lock ] && have uv; then pr="uv run"; elif [ -f poetry.lock ] && have poetry; then pr="poetry run"; fi
  pyproj() { [ -f pyproject.toml ] && grep -q "$1" pyproject.toml; }
  if pyproj '\[tool.ruff' || [ -f ruff.toml ] || [ -f .ruff.toml ]; then run_check lint $pr ruff check .; fi
  if pyproj '\[tool.mypy' || [ -f mypy.ini ] || [ -f .mypy.ini ]; then run_check typecheck $pr mypy .
  elif pyproj '\[tool.pyright' || [ -f pyrightconfig.json ]; then run_check typecheck $pr pyright; fi
  if pyproj '\[tool.pytest' || [ -f pytest.ini ] || [ -f conftest.py ] || \
     find . -path ./node_modules -prune -o -type f \( -name 'test_*.py' -o -name '*_test.py' \) -print 2>/dev/null | grep -q .; then
    if [ "$found_tests" -eq 0 ]; then run_check tests $pr $py -m pytest -q; else run_check tests-py $pr $py -m pytest -q; fi
    found_tests=1
  fi
fi

# ---------- 4. Go / Rust ----------
if [ -f go.mod ]; then run_check typecheck go vet ./...; run_check tests go test ./...; found_tests=1; fi
if [ -f Cargo.toml ]; then
  cargo clippy --version >/dev/null 2>&1 && run_check lint cargo clippy --all-targets -- -D warnings
  run_check tests cargo test; found_tests=1
fi

# ---------- 5. Makefile fallback ----------
if [ "$found_tests" -eq 0 ] && [ -f Makefile ] && grep -qE '^test:' Makefile; then run_check tests make test; found_tests=1; fi

if [ "$found_tests" -eq 0 ]; then
  if [ "${SAFE_TDD_ALLOW_NO_TESTS:-0}" = 1 ]; then record tests SKIP "no test runner found (allowed by SAFE_TDD_ALLOW_NO_TESTS)"
  else record tests FAIL "no test runner found (package.json test script, pytest, go, cargo or make test)"; fi
fi

# ---------- 6. Secret scan (prints file:line only - never the value) ----------
scan_secrets() {
  if have gitleaks && [ "${SAFE_TDD_BUILTIN_SCAN:-0}" != 1 ]; then
    echo "===== secrets: gitleaks" >> "$log"
    gitleaks dir . --redact --no-banner >> "$log" 2>&1 || gitleaks detect --no-git --redact --source . >> "$log" 2>&1
    return $?
  fi
  local files
  files=$(mktemp)
  if git rev-parse --git-dir >/dev/null 2>&1; then git ls-files -co --exclude-standard -z > "$files"
  else find . -type f -not -path './.git/*' -print0 > "$files"; fi
  local skip='(^|/)(node_modules|\.git|dist|build|\.next|coverage|vendor|\.venv|\.safe-tdd)/|(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum)$|\.(min\.js|map|png|jpe?g|gif|ico|pdf|woff2?|zip)$'
  local list
  list=$(mktemp)
  tr '\0' '\n' < "$files" | grep -vE "$skip" | tr '\n' '\0' > "$list"
  # name<TAB>regex. Written so this file never matches itself.
  local pats="aws-access-key	AKIA[0-9A-Z]{16}
anthropic-key	sk-ant-[A-Za-z0-9_-]{20,}
openai-style-key	sk-(proj-)?[A-Za-z0-9]{32,}
github-token	(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}
github-pat	github_pat_[A-Za-z0-9_]{40,}
slack-token	xox[abprs]-[A-Za-z0-9-]{10,}
google-api-key	AIza[0-9A-Za-z_-]{35}
stripe-live-key	(sk|rk)_live_[0-9A-Za-z]{20,}
private-key	-----BEGIN ([A-Z]+ )?PRIVATE KEY-----
hardcoded-credential	(api[_-]?key|apikey|secret|passw(or)?d|access[_-]?token|auth[_-]?token|client[_-]?secret)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][^\"'[:space:]]{12,}[\"']"
  local hits=0 name re out
  echo "===== secrets: built-in scan" >> "$log"
  while IFS='	' read -r name re; do
    [ -s "$list" ] || break
    out=$(xargs -0 grep -nIHiE -e "$re" < "$list" 2>/dev/null | awk -v n="$name" '{
        c = $0; sub(/^[^:]*:[0-9]+:/, "", c); lc = tolower(c)
        if (lc ~ /safe-tdd: *allow-secret/) next
        if (n == "hardcoded-credential" && lc ~ /(example|dummy|fake|placeholder|changeme|your[_-]|xxxx|redacted|process\.env|os\.environ|getenv|\$\{)/) next
        split($0, a, ":"); print "  " a[1] ":" a[2] "  [" n "]" }')
    if [ -n "$out" ]; then echo "$out" | tee -a "$log"; hits=$((hits + 1)); fi
  done <<< "$pats"
  if git rev-parse --git-dir >/dev/null 2>&1; then
    out=$(git ls-files | grep -E '(^|/)\.env(\.[A-Za-z0-9_-]+)?$' | grep -vE '\.(example|sample|template|defaults)$')
    if [ -n "$out" ]; then echo "$out" | sed 's/^/  tracked env file: /' | tee -a "$log"; hits=$((hits + 1)); fi
  fi
  rm -f "$files" "$list"
  [ "$hits" -eq 0 ]
}
if skipped secrets; then record secrets SKIP "skipped by SAFE_TDD_SKIP"
else
  secret_out=$(scan_secrets); rc=$?
  if [ $rc -eq 0 ]; then record secrets PASS "no hardcoded secrets found"
  else record secrets FAIL "possible hardcoded secrets - see list below"; fi
fi

# ---------- Report ----------
fails=0
{
  echo "SAFE-TDD GATE REPORT  $(date '+%Y-%m-%d %H:%M')  repo: $root"
  for r in "${results[@]}"; do
    IFS='|' read -r n s d <<< "$r"
    printf '  %-5s %-10s %s\n' "$s" "$n" "$d"
    [ "$s" = FAIL ] && fails=$((fails + 1))
  done
  [ -n "${secret_out:-}" ] && echo "$secret_out"
  if [ "$fails" -eq 0 ]; then echo "GATE: PASS"; else echo "GATE: FAIL ($fails check(s)) - details in .safe-tdd/gate.log"; fi
} | tee .safe-tdd/gate-report.txt
[ "$(tail -n 1 .safe-tdd/gate-report.txt)" = "GATE: PASS" ]
