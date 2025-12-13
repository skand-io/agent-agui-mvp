# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Minimal CopilotKit-like backend server implementing the AG-UI (Agent UI) protocol. Uses FastAPI + OpenRouter for LLM API with support for both frontend and backend tool execution via SSE streaming.

## Project Structure

```
agent-agui-mvp/
├── backend/           # Python FastAPI server
│   ├── server.py      # Main FastAPI server with AG-UI protocol
│   ├── test_utils.py  # Shared test utilities
│   ├── test_e2e.py    # Combined e2e tests
│   ├── test_backend_tools.py  # Backend tool tests
│   └── test_frontend_tools.py # Frontend tool tests (API-level)
├── frontend/          # Web frontend with Playwright tests
│   ├── index.html     # React-based chat UI
│   ├── package.json   # Node.js dependencies
│   ├── playwright.config.ts  # Playwright configuration
│   └── tests/         # Playwright e2e tests
│       └── frontend-tools.spec.ts
├── .env               # Environment variables (API keys)
└── pyproject.toml     # Python dependencies (uv)
```

## Commands

### Backend (Python/FastAPI)

```bash
# Install dependencies
uv sync

# Run server
cd backend && uv run python server.py

# Run all API tests
cd backend && uv run python test_e2e.py

# Run backend tool tests only
cd backend && uv run python test_backend_tools.py

# Run frontend tool tests only (API-level)
cd backend && uv run python test_frontend_tools.py
```

### Frontend (Node.js/Playwright)

```bash
# Install dependencies
cd frontend && npm install

# Install Playwright browsers
cd frontend && npx playwright install

# Run frontend static server
cd frontend && npm run serve

# Run Playwright e2e tests
cd frontend && npm test

# Run Playwright tests with browser visible
cd frontend && npm run test:headed
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
- `backend/server.py`: FastAPI server with `/chat` endpoint, tool definitions, and SSE streaming
- `backend/test_utils.py`: Shared test utilities (server lifecycle, SSE parsing)
- `frontend/index.html`: React-based chat UI implementing AG-UI protocol client
- `frontend/tests/frontend-tools.spec.ts`: Playwright e2e tests for frontend tool execution

## Environment

Requires `.env` file in root with:
- `OPENROUTER_API_KEY`: OpenRouter API key
- `MODEL`: Model identifier (default: `amazon/nova-2-lite-v1:free`)
