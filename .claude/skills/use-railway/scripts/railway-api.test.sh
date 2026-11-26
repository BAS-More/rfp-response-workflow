#!/usr/bin/env bash
# Proof for railway-api.sh. Self-contained: builds its own fixture configs with an obviously
# invalid placeholder, so the real ~/.railway/config.json is never copied and no credential is
# ever written to disk or printed. One live query is made, which needs a logged-in CLI.
#
# Run: bash scripts/railway-api.test.sh
#
# What it pins (all three were live defects on 2026-10-26, Windows + CLI 5.15.0):
#   1. `jq` absent made the script exit 1 with "Install with: brew install jq" — unusable on a
#      host with no brew, even though node was available all along.
#   2. The token was read from .user.token, which CLI 5.15.0 leaves as an empty object; the real
#      value is at .user.accessToken. A logged-in user was told "No Railway token found".
#   3. A GraphQL error inside an HTTP 200 — how Railway reports "Not Authorized" — was passed
#      through as if it were data, with exit 0. Nothing downstream could tell success from
#      failure. Note the recorded cause for this one ("Cloudflare 403 without a User-Agent") did
#      NOT reproduce: with no UA, with curl/8.11.0 and with a custom UA the endpoint answered
#      HTTP 200 every time. The variable was token validity, not the User-Agent.

cd "$(dirname "$0")"
SCRIPT="./railway-api.sh"
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT INT TERM HUP
pass=0; fail=0
t() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "   ok    $1"; else fail=$((fail+1)); echo "   FAIL  $1 — expected '$3', got '$2'"; fi; }

NOW="$(date +%s)"
P="INVALID-PLACEHOLDER-NOT-A-CREDENTIAL"
# Current CLI 5.15.0 shape: value at accessToken, `token` an empty object.
printf '{"user":{"id":"x","token":{},"accessToken":"%s","tokenExpiresAt":%s}}\n' "$P" "$((NOW + 3600))" > "$FIX/current.json"
# Pre-5.x shape: a plain string at `token`, no accessToken.
printf '{"user":{"id":"x","token":"%s","tokenExpiresAt":%s}}\n'                  "$P" "$((NOW + 3600))" > "$FIX/legacy.json"
# Lapsed session — the state that produces the misleading "Not Authorized".
printf '{"user":{"id":"x","accessToken":"%s","tokenExpiresAt":%s}}\n'            "$P" "$((NOW - 3600))" > "$FIX/expired.json"
# Logged out: nothing usable anywhere.
printf '{"user":{"id":"x","token":{}}}\n'                                                              > "$FIX/loggedout.json"

echo "=== live query (needs a logged-in railway CLI) ==="
OUT="$(bash "$SCRIPT" '{ me { id email } }' 2>/dev/null)"; RC=$?
t "live query exits 0" "$RC" "0"
case "$OUT" in *'"me"'*) t "live query returns data" yes yes;; *) t "live query returns data" no yes;; esac
# Guard the vacuous form: empty stdout also contains no "errors".
if [ -n "$OUT" ]; then
  case "$OUT" in *'"errors"'*) t "live query is error-free" no yes;; *) t "live query is error-free" yes yes;; esac
else
  t "live query is error-free (stdout was empty, so this proved nothing)" no yes
fi

echo
echo "=== arguments ==="
OUT="$(bash "$SCRIPT" 2>/dev/null)"; RC=$?
t "missing query exits 1" "$RC" "1"
case "$OUT" in *"No query provided"*) t "missing query is named" yes yes;; *) t "missing query is named" no yes;; esac
OUT="$(bash "$SCRIPT" '{ me { id } }' 'not json' 2>/dev/null)"; RC=$?
t "invalid variables JSON exits 1" "$RC" "1"
case "$OUT" in *"valid JSON"*) t "invalid variables are named" yes yes;; *) t "invalid variables are named" no yes;; esac

echo
echo "=== defect 3: a GraphQL error inside HTTP 200 ==="
OUT="$(RAILWAY_CONFIG_FILE="$FIX/current.json" bash "$SCRIPT" '{ me { id } }' 2>/dev/null)"; RC=$?
ERR="$(RAILWAY_CONFIG_FILE="$FIX/current.json" bash "$SCRIPT" '{ me { id } }' 2>&1 >/dev/null)"
t "a rejected token exits 1" "$RC" "1"
case "$OUT" in *'"errors"'*) t "raw body still on stdout, so parsers are unaffected" yes yes;; *) t "raw body still on stdout, so parsers are unaffected" no yes;; esac
case "$ERR" in *"inside HTTP 200"*) t "stderr explains the 200-with-errors shape" yes yes;; *) t "stderr explains the 200-with-errors shape" no yes;; esac
case "$ERR" in *"railway login"*) t "stderr says what to do about it" yes yes;; *) t "stderr says what to do about it" no yes;; esac

echo
echo "=== defect 2: which config field the token is read from ==="
ERR="$(RAILWAY_CONFIG_FILE="$FIX/current.json" bash "$SCRIPT" '{ me { id } }' 2>&1 >/dev/null)"
case "$ERR" in *"No Railway token found"*) t "CLI 5.15.0 shape not misread as logged-out" no yes;; *) t "CLI 5.15.0 shape not misread as logged-out" yes yes;; esac
ERR="$(RAILWAY_CONFIG_FILE="$FIX/legacy.json" bash "$SCRIPT" '{ me { id } }' 2>&1 >/dev/null)"
case "$ERR" in *"No Railway token found"*) t "pre-5.x string shape still read" no yes;; *) t "pre-5.x string shape still read" yes yes;; esac
OUT="$(RAILWAY_CONFIG_FILE="$FIX/loggedout.json" bash "$SCRIPT" '{ me { id } }' 2>/dev/null)"; RC=$?
t "genuinely logged out exits 1" "$RC" "1"
case "$OUT" in *"No Railway token found"*) t "genuinely logged out is reported as such" yes yes;; *) t "genuinely logged out is reported as such" no yes;; esac

echo
echo "=== a lapsed token is reported as lapsed, not as a permissions problem ==="
OUT="$(RAILWAY_CONFIG_FILE="$FIX/expired.json" bash "$SCRIPT" '{ me { id } }' 2>/dev/null)"; RC=$?
t "expired token exits 1" "$RC" "1"
case "$OUT" in *"expired"*) t "expiry is named rather than left as Not Authorized" yes yes;; *) t "expiry is named rather than left as Not Authorized" no yes;; esac

echo
echo "=== missing config ==="
OUT="$(RAILWAY_CONFIG_FILE="$FIX/no-such-file.json" bash "$SCRIPT" '{ me { id } }' 2>/dev/null)"; RC=$?
t "missing config exits 1" "$RC" "1"
case "$OUT" in *"config not found"*) t "missing config is named" yes yes;; *) t "missing config is named" no yes;; esac

echo
echo "=== defect 1: jq is not a hard dependency ==="
if grep -q "brew install jq" "$SCRIPT"; then t "no macOS-only install advice left" no yes; else t "no macOS-only install advice left" yes yes; fi
if grep -q 'JSON_ENGINE=node' "$SCRIPT"; then t "node is accepted as the JSON engine" yes yes; else t "node is accepted as the JSON engine" no yes; fi
# With jq available the jq branch must work too. Skipped, not silently passed, when jq is absent.
if command -v jq >/dev/null 2>&1; then
  OUT="$(bash "$SCRIPT" '{ me { id } }' 2>/dev/null)"; RC=$?
  t "jq branch also answers the live query" "$RC" "0"
else
  echo "   SKIP  jq branch not exercised: jq is not installed on this host"
fi

echo
echo "=== credential handling and strictness ==="
if grep -q 'H @"\$(winpath "\$HDR")"' "$SCRIPT"; then t "auth header read from a file by curl" yes yes; else t "auth header read from a file by curl" no yes; fi
if grep -q 'Authorization: Bearer \$TOKEN' "$SCRIPT"; then t "no token interpolated into a curl argument" no yes; else t "no token interpolated into a curl argument" yes yes; fi
if grep -q 'chmod 600 "\$HDR"' "$SCRIPT"; then t "header file is 0600" yes yes; else t "header file is 0600" no yes; fi
if grep -q "trap 'rm -rf \"\$WORK\"' EXIT INT TERM HUP" "$SCRIPT"; then t "work dir removed on exit and on signals" yes yes; else t "work dir removed on exit and on signals" no yes; fi
if grep -q 'cygpath -m' "$SCRIPT"; then t "MSYS paths normalised for native binaries" yes yes; else t "MSYS paths normalised for native binaries" no yes; fi
if grep -q 'set -euo pipefail' "$SCRIPT"; then t "set -euo pipefail" yes yes; else t "set -euo pipefail" no yes; fi
if bash -n "$SCRIPT"; then t "parses clean" yes yes; else t "parses clean" no yes; fi

echo
if [ "$fail" -eq 0 ]; then
  echo "   railway-api proof: PASS ($pass assertions)"
else
  echo "   railway-api proof: FAILED — $fail of $((pass + fail))"
  exit 1
fi
