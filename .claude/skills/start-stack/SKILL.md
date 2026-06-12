---
name: start-stack
description: Start the Soifer Platform stack (9Router, CrewAI, Backend, Paseo daemon + Expo Metro) or check which services are running.
argument-hint: "[check|start|stop]"
allowed-tools: Bash(curl *) Bash(npm run *) Bash(netstat *) Bash(tasklist *) Bash(powershell *)
---

## Stack services

| Service | Port | Check | Role |
|---------|------|-------|------|
| 9Router | 20128 | http://localhost:20128 | Token proxy, 51 AI providers, OAuth, fallback |
| CrewAI Bridge | 8000 | http://localhost:8000/health | Python FastAPI, crews/agents, SSE streaming |
| Soifer Backend | 3001 | http://localhost:3001/health | Express API (plugins, TaskMaster, sessions) |
| Paseo Daemon | 6767 | http://localhost:6767/api/status | Main server (agents, voice, terminal, git, worktrees) |
| Expo Metro | 8081 | http://localhost:8081 | Frontend UI (React Native Web, browser/mobile) |

## Current status

!`curl -s -o /dev/null -w "%{http_code}" http://localhost:20128 2>/dev/null || echo "down"`
!`curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health 2>/dev/null || echo "down"`
!`curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health 2>/dev/null || echo "down"`
!`curl -s -o /dev/null -w "%{http_code}" http://localhost:6767/api/status 2>/dev/null || echo "down"`
!`curl -s -o /dev/null -w "%{http_code}" http://localhost:8081 2>/dev/null || echo "down"`

## Instructions

Based on $ARGUMENTS (default: check):

**check**: Report which services are up/down with port status.

**start**: Start missing services in order:
1. 9Router: `cd C:/Dev/tools/9router && npm run dev`
2. CrewAI Bridge: `cd C:/Dev/tools/claudecodeui/crewai-bridge && python api.py`
3. Soifer Backend: `cd C:/Dev/tools/claudecodeui && npm run dev`
4. Paseo (daemon + Metro): `cd C:/Dev/tools/paseo && npm run dev:win`
   - Daemon starts on :6767
   - Metro bundler starts on :8081

**stop**: Kill processes on ports 20128, 8000, 3001, 6767, 8081.

## On-demand providers (not services — spawned by Paseo daemon)

These are CLI tools/binaries that Paseo spawns when a user selects the provider:
- `claude` — Claude SDK (direct library call)
- `codex` — OpenAI Codex app-server (local binary, self-managed port)
- `copilot` — GitHub Copilot via ACP (binary spawned per session)
- `opencode` — OpenCode (binary spawned per session)
- `pi` — Pi (binary spawned per session)
- `occ` — OpenClaude (binary spawned per session)
- `gemini` — Gemini CLI (binary spawned per session)
