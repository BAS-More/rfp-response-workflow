#!/usr/bin/env bash
# Railway GraphQL API helper
# Usage: railway-api.sh '<graphql-query>' ['<variables-json>']
#
# Exit status: 0 only when the API answered with data. A GraphQL error inside an HTTP 200 —
# which is how Railway reports "Not Authorized" — exits 1. The raw response body is always
# printed to stdout unchanged, so existing parsers are unaffected; diagnostics go to stderr.

set -euo pipefail

SKILL_ID="use-railway"
SKILL_VERSION="${RAILWAY_SKILL_VERSION:-1.2.2}"

export RAILWAY_CALLER="${RAILWAY_CALLER:-skill:${SKILL_ID}@${SKILL_VERSION}}"
export RAILWAY_AGENT_SESSION="${RAILWAY_AGENT_SESSION:-railway-skill-$(date +%s)-$$}"

CONFIG_FILE="${RAILWAY_CONFIG_FILE:-$HOME/.railway/config.json}"
API_URL="${RAILWAY_API_URL:-https://backboard.railway.com/graphql/v2}"

# ---------------------------------------------------------------------------------------------
# JSON engine. jq is preferred but is NOT a hard dependency. The previous version exited 1 and
# pointed at a macOS-only package manager, which makes the script unusable on Windows, where that
# manager does not exist and jq is absent — measured 2026-10-26 on this host. node is already
# required by the surrounding toolchain, so either will do.
# ---------------------------------------------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  JSON_ENGINE=jq
elif command -v node >/dev/null 2>&1; then
  JSON_ENGINE=node
else
  echo '{"error": "Needs jq or node to read the config and build the request. Install one: https://jqlang.github.io/jq/download/ or https://nodejs.org"}'
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo '{"error": "Railway config not found. Run: railway login"}'
  exit 1
fi

# Under MSYS/Git Bash, $HOME is /c/Users/... — a path that MSYS-linked tools resolve but native
# Windows binaries (node, and the mingw curl build) do not; they read it as C:\c\Users\... and
# fail with ENOENT. Normalise before handing a path to either of them.
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

read_field() {
  # $1 = accessToken | token | tokenExpiresAt
  case "$JSON_ENGINE" in
    jq)   jq -r --arg k "$1" '(.user[$k] // empty) | tostring' "$CONFIG_FILE" 2>/dev/null || true ;;
    node) node -e 'const u=(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).user)||{};const v=u[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$(winpath "$CONFIG_FILE")" "$1" 2>/dev/null || true ;;
  esac
}

read_token() {
  # CLI 5.15.0 stores the session token at .user.accessToken and leaves .user.token as an empty
  # object — verified against this host's config on 2026-10-26. Reading .user.token alone (what
  # this script did until now) yielded "null" and the script reported "No Railway token found.
  # Run: railway login" to an already-logged-in user. .user.token is still tried second so an
  # older CLI layout keeps working.
  local t
  t="$(read_field accessToken)"
  if [[ -z "$t" || "$t" == "null" || "$t" == "[object Object]" || "$t" == "{}" ]]; then
    t="$(read_field token)"
  fi
  [[ "$t" == "null" || "$t" == "[object Object]" || "$t" == "{}" ]] && t=""
  printf '%s' "$t"
}

TOKEN="$(read_token)"

# ---------------------------------------------------------------------------------------------
# The stored token is a SHORT-LIVED session token (.user.tokenExpiresAt is about an hour out),
# not a long-lived API token, and only the CLI performs the refresh-token exchange. A script
# that reads it straight from disk therefore gets a silently lapsed token and the API answers
# HTTP 200 with {"errors":[{"message":"Not Authorized"}]} — observed here on 2026-10-26, when an
# identical request succeeded minutes later after the CLI had refreshed the file. Nudge the CLI
# and re-read, rather than firing a request whose failure reads like a permissions problem.
#
# Note on the User-Agent: this was recorded as "Cloudflare returns 403 without a UA header". That
# did NOT reproduce — with no UA, with curl/8.11.0 and with a custom UA the endpoint answered
# HTTP 200 every time; the differing outcome was token validity, not the UA. One is sent below
# because an API client should identify itself, not because it is required.
# ---------------------------------------------------------------------------------------------
token_expired() {
  local exp now
  exp="$(read_field tokenExpiresAt)"
  [[ -z "$exp" || ! "$exp" =~ ^[0-9]+$ ]] && return 1   # no usable expiry: assume valid
  (( ${#exp} >= 13 )) && exp=$(( exp / 1000 ))          # tolerate milliseconds
  now="$(date +%s)"
  (( exp <= now + 30 ))
}

if token_expired && command -v railway >/dev/null 2>&1; then
  echo "railway-api: stored token has expired; asking the CLI to refresh it" >&2
  railway whoami >/dev/null 2>&1 || true
  TOKEN="$(read_token)"
fi

if [[ -z "$TOKEN" ]]; then
  echo '{"error": "No Railway token found. Run: railway login"}'
  exit 1
fi

if token_expired; then
  echo '{"error": "Railway token has expired and could not be refreshed. Run: railway login"}'
  exit 1
fi

QUERY="${1:-}"
VARS="${2:-}"

if [[ -z "$QUERY" ]]; then
  echo '{"error": "No query provided"}'
  exit 1
fi

# Build payload with query and optional variables.
build_payload() {
  case "$JSON_ENGINE" in
    jq)
      if [[ -n "$VARS" ]]; then jq -n --arg q "$QUERY" --argjson v "$VARS" '{query: $q, variables: $v}'
      else jq -n --arg q "$QUERY" '{query: $q}'; fi ;;
    node)
      node -e 'const q=process.argv[1],v=process.argv[2];process.stdout.write(JSON.stringify(v?{query:q,variables:JSON.parse(v)}:{query:q}))' "$QUERY" "$VARS" ;;
  esac
}

if ! PAYLOAD="$(build_payload)"; then
  echo '{"error": "Could not build the request payload. Is the variables argument valid JSON?"}'
  exit 1
fi

# The token goes in a 0600 file read by curl, never in argv, where any process listing would
# show it. The body goes in a file too, so a long query cannot hit the command-line length cap.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM HUP
HDR="$WORK/headers"
BODYF="$WORK/body.json"
: > "$HDR"; chmod 600 "$HDR"
{
  printf 'Authorization: Bearer %s\n' "$TOKEN"
  printf 'Content-Type: application/json\n'
  printf 'User-Agent: %s/%s\n' "$SKILL_ID" "$SKILL_VERSION"
  printf 'X-Railway-Skill-Id: %s\n' "$SKILL_ID"
  printf 'X-Railway-Skill-Version: %s\n' "$SKILL_VERSION"
  printf 'X-Railway-Agent-Session: %s\n' "$RAILWAY_AGENT_SESSION"
} > "$HDR"
printf '%s' "$PAYLOAD" > "$BODYF"

# curl's own failure must not be swallowed by the pipeline, hence the explicit status capture.
set +e
RESP="$(curl -sS --max-time "${RAILWAY_API_TIMEOUT:-30}" -H @"$(winpath "$HDR")" --data-binary @"$(winpath "$BODYF")" -w $'\n%{http_code}' "$API_URL" 2>"$WORK/curl.err")"
CURL_RC=$?
set -e

if (( CURL_RC != 0 )); then
  echo '{"error": "Request to the Railway API failed"}'
  sed 's/^/railway-api: /' "$WORK/curl.err" >&2 || true
  exit 1
fi

HTTP_CODE="${RESP##*$'\n'}"
BODY="${RESP%$'\n'*}"

# Always emit the raw body, so callers that only parse stdout are unaffected.
printf '%s\n' "$BODY"

first_error() {
  case "$JSON_ENGINE" in
    jq)   printf '%s' "$BODY" | jq -r '(.errors[0].message // empty)' 2>/dev/null || true ;;
    node) printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j?.errors?.[0]?.message||""))}catch{process.stdout.write("")}})' 2>/dev/null || true ;;
  esac
}

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "railway-api: HTTP $HTTP_CODE from $API_URL" >&2
  exit 1
fi

ERR="$(first_error)"
if [[ -n "$ERR" ]]; then
  echo "railway-api: the API returned an error inside HTTP 200: $ERR" >&2
  case "$ERR" in
    *"Not Authorized"*|*"Unauthorized"*)
      echo "railway-api: the session token may have lapsed. Run: railway login" >&2 ;;
  esac
  exit 1
fi
