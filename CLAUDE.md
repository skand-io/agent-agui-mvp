# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Minimal CopilotKit-like backend server implementing the AG-UI (Agent UI) protocol. Uses FastAPI + OpenRouter for LLM API with support for both frontend and backend tool execution via SSE streaming.

## Project Structure

```
agent-agui-mvp/
├── backend/                    # Python FastAPI server
│   ├── server.py               # Main FastAPI server with AG-UI protocol
│   ├── test_utils.py           # Shared test utilities
│   ├── test_e2e.py             # Combined e2e tests
│   ├── test_backend_tools.py   # Backend tool tests
│   └── test_frontend_tools.py  # Frontend tool tests (API-level)
├── frontend/                   # React + Vite frontend
│   ├── src/
│   │   ├── components/         # React components
│   │   │   ├── ChatContainer.tsx
│   │   │   ├── Message.tsx
│   │   │   ├── InputArea.tsx
│   │   │   └── Loading.tsx
│   │   ├── hooks/
│   │   │   └── useChat.ts      # AG-UI protocol hook
│   │   ├── types/
│   │   │   └── index.ts        # TypeScript types
│   │   ├── tools.ts            # Frontend tool definitions
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── tests/
│   │   └── frontend-tools.spec.ts  # Playwright e2e tests
│   ├── package.json
│   ├── vite.config.ts
│   └── playwright.config.ts
├── .github/workflows/
│   └── test.yml                # GitHub Actions CI
├── .env                        # Environment variables (gitignored)
└── pyproject.toml              # Python dependencies (uv)
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

### Frontend (React/Vite/Playwright)

```bash
# Install dependencies
cd frontend && npm install

# Run dev server
cd frontend && npm run dev

# Build for production
cd frontend && npm run build

# Install Playwright browsers
cd frontend && npx playwright install

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
- `frontend/src/hooks/useChat.ts`: React hook for AG-UI protocol client
- `frontend/src/tools.ts`: Frontend tool definitions and handlers
- `frontend/tests/frontend-tools.spec.ts`: Playwright e2e tests for frontend tool execution

## Environment

Requires `.env` file in root with:
- `OPENROUTER_API_KEY`: OpenRouter API key
- `MODEL`: Model identifier (default: `amazon/nova-2-lite-v1:free`)
