---
name: 9router
description: Entry point for 9Router — local/remote AI gateway with OpenAI-compatible REST for chat, image, TTS, embeddings, web search, web fetch. Use when the user mentions 9Router, NINEROUTER_URL, or wants AI without writing provider boilerplate. This skill covers setup + indexes capability skills (load the matching local 9router-* skill), and how PAL and skill-gate reach 9router.
---

# 9Router

Local/remote AI gateway exposing OpenAI-compatible REST. One key, many providers, auto-fallback.

## Setup

```bash
export NINEROUTER_URL="http://localhost:20128"      # or VPS / tunnel URL
export NINEROUTER_KEY="sk-..."                      # from Dashboard → Keys (only if requireApiKey=true)
```

All requests: `${NINEROUTER_URL}/v1/...` with header `Authorization: Bearer ${NINEROUTER_KEY}` (omit if auth disabled).

Verify: `curl $NINEROUTER_URL/api/health` → `{"ok":true}`

## Discover models

```bash
curl $NINEROUTER_URL/v1/models                  # chat/LLM (default)
curl $NINEROUTER_URL/v1/models/image            # image-gen
curl $NINEROUTER_URL/v1/models/tts              # text-to-speech
curl $NINEROUTER_URL/v1/models/embedding        # embeddings
curl $NINEROUTER_URL/v1/models/web              # web search + fetch (entries have `kind` field)
curl $NINEROUTER_URL/v1/models/stt              # speech-to-text
curl $NINEROUTER_URL/v1/models/image-to-text    # vision
```

Use `data[].id` as `model` field in requests. Combos appear with `owned_by:"combo"`.

Response shape:
```json
{ "object": "list", "data": [
  { "id": "openai/gpt-5", "object": "model", "owned_by": "openai", "created": 1735000000 },
  { "id": "tavily/search", "object": "model", "kind": "webSearch", "owned_by": "tavily", "created": 1735000000 }
]}
```

## Capability skills

| Capability | Skill |
|---|---|
| Chat / code-gen | `9router-chat` |
| Image generation | `9router-image` |
| Text-to-speech | `9router-tts` |
| Speech-to-text | `9router-stt` |
| Embeddings | `9router-embeddings` |
| Web search | `9router-web-search` |
| Web fetch (URL → markdown) | `9router-web-fetch` |

## Reaching 9router from other tools (this machine)

Key: vault `claude-proxy/token` (same value as Claude Code's `ANTHROPIC_AUTH_TOKEN`). Never paste it.

| From | How | Cheap-pool models |
|---|---|---|
| PAL `chat` | custom provider, `CUSTOM_API_URL=http://localhost:20128/v1` in `C:\Dev\tools\pal-mcp-server\.env`. A name only routes here if it is in PAL `conf/custom_models.json`; otherwise an `openrouter/...` name goes to PAL's native OpenRouter and fails 400 | `openrouter/z-ai/glm-5.3`, `openrouter/moonshotai/kimi-k3`, `openrouter/xiaomi/mimo-v2.6-pro`, `tokenrouter/qwen/qwen3.8-max` |
| PAL `clink` | `claude-glm`, `claude-kimi`, `claude-mimo`, `claude-qwen` in `~/.pal/cli_clients` run the `claude` CLI with `--model <name>` through 9router | same |
| skill-gate | capability `9router.chat` (`find` "9router", then `execute` with `{"inputs":{"model","prompt"}}`); worker `~/.skill-gate/workers/ninerouter_chat.py`, 30 s cap | same, enforced by schema |
| skill-gate | `9router.web_search` (`{"inputs":{"query","max_results"?}}`) and `9router.web_fetch` (`{"inputs":{"url","max_chars"?}}`, max 8000); worker `ninerouter_web.py`, Tavily | n/a |

The pool list is BAS-More/skills `skills/personal/review-and-continue/model-pool.json` (`palModel`).

Web search/fetch: use `"provider":"tavily"` (this 9router version rejects `"model":"tavily/search"` with "Unknown provider"). Tavily key: vault `tavily/api-key`, added to 9router 2026-10-20. `glm/search` (400) and `ollama/fetch` (502) are configured but failing.

## Errors

- 401 → set/refresh `NINEROUTER_KEY` (Dashboard → Keys)
- 400 `Invalid model format` → check `model` exists in `/v1/models/<kind>`
- 503 `All accounts unavailable` → wait `retry-after` or add another provider account
