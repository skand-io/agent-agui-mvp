# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Minimal CopilotKit-like backend server implementing the AG-UI (Agent UI) protocol. Uses FastAPI + OpenRouter for LLM API with support for both frontend and backend tool execution via SSE streaming.

## Commands

```bash
# Install dependencies
uv sync

# Run server
uv run python server.py

# Run all tests
uv run python test_e2e.py

# Run backend tool tests only
uv run python test_backend_tools.py

# Run frontend tool tests only
uv run python test_frontend_tools.py
```

## Architecture

**AG-UI Protocol Events** (SSE streaming):
- `RUN_STARTED/FINISHED`: Lifecycle events
- `TEXT_MESSAGE_START/CONTENT/END`: Text streaming
- `TOOL_CALL_START/ARGS/END/RESULT`: Tool execution

**Tool Types**:
- **Backend tools**: Execute on server, return `TOOL_CALL_RESULT` (e.g., `get_weather`, `calculate`)
- **Frontend tools**: Server streams call info only, NO result - client executes (e.g., `greet`, `setTheme`)

**Key Files**:
- `server.py`: FastAPI server with `/chat` endpoint, tool definitions, and SSE streaming
- `test_utils.py`: Shared test utilities (server lifecycle, SSE parsing)
- `test_backend_tools.py` / `test_frontend_tools.py`: Separated tool tests

## Environment

Requires `.env` file with:
- `OPENROUTER_API_KEY`: OpenRouter API key
- `MODEL`: Model identifier (default: `amazon/nova-2-lite-v1:free`)
