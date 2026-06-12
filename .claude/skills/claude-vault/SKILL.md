---
name: claude-vault
description: Use for anything involving API keys, tokens, secrets, or .env files. Claude should retrieve credentials via `vault get` / `vault env` or the claude-vault MCP instead of asking the user to paste values. For creating a new API key, use `vault fetch <service>`. For rotating, `vault rotate <service> <key>`. Recipe files live in C:/Dev/tools/vault/recipes/.
---

# claude-vault

Credential store backed by Windows Credential Manager. All the user's API keys
are already there — do not ask them to paste values.

## Retrieving a value

```bash
vault get <service> <key>      # prints the value (no trailing newline)
vault list                     # shows names only
vault env <service> > .env     # dump all keys for a service as KEY=VALUE lines
```

Prefer `vault env > .env` over `vault get` when possible — it keeps the value
out of the conversation transcript.

## Creating a NEW key autonomously

```bash
vault fetch <service>          # opens browser, logs in, creates key, saves it
vault fetch --list             # shows available recipes
```

If no recipe exists for the service, create one at
`C:/Dev/tools/vault/recipes/<service>.json` (copy from `_template.json`).
See RECIPES.md in the DevOps/claude-vault/ folder.

## Rotation

```bash
vault expiry set <svc> <key> <YYYY-MM-DD> --days-before 1
vault expiry list
vault rotate <svc> <key>       # rotate right now
vault scheduler status         # daily check at 09:00
```

## Safety features

- `vault rollback <svc> <key>` — restore previous value if a rotation broke
- `vault doctor`                — self-check the installation
- `vault audit`                 — who accessed what and when
- `vault backup / restore`      — encrypted snapshot for migration
- `vault sync push / pull`      — encrypted sync via OneDrive
- `vault copy <svc> <key>`      — copy to clipboard with auto-clear

## When NOT to use

- The user hasn't mentioned secrets at all
- For production secrets managed by AWS/Azure/GCP Secret Manager
- For team-shared secrets (use 1Password etc. instead)

Full docs in C:/Users/${USERPROFILE}/OneDrive/DevOps/claude-vault/.
