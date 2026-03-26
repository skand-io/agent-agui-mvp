# minimal-chat

Minimal CopilotKit-like chat app implementing the [AG-UI](https://docs.ag-ui.com) (Agent UI) protocol. FastAPI + LangGraph backend with React frontend, supporting both frontend and backend tool execution via SSE streaming.

## Prerequisites

- Python 3.11+
- Node.js 18+
- [uv](https://docs.astral.sh/uv/) (Python package manager)

## Setup

### 1. Clone and install dependencies

```bash
# Backend (from repo root)
uv sync

# Frontend
cd frontend_v2 && npm install
```

### 2. Configure environment variables

Create a `.env` file in the repo root:

```bash
# OpenRouter API - get key from https://openrouter.ai/
OPENROUTER_API_KEY=your-api-key-here
MODEL=google/gemini-2.5-flash-lite-preview-09-2025
```

### 3. Run the app

Start both servers (in separate terminals):

```bash
# Backend (from repo root)
cd backend_v2 && uv run python server_langgraph.py

# Frontend (from repo root)
cd frontend_v2 && npm run dev
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8000

## Testing

### Backend tests

```bash
cd backend_v2 && uv run pytest
```

### Frontend unit tests

```bash
cd frontend_v2 && npm run test:unit
```

### E2E tests (Playwright)

```bash
# Install browsers (first time only)
cd frontend_v2 && npx playwright install

# Run e2e tests (auto-starts both servers)
cd frontend_v2 && npm test

# Run with browser visible
cd frontend_v2 && npm run test:headed

# Run all tests (unit + e2e)
cd frontend_v2 && npm run test:all
```

## Project Structure

```
minimal-chat/
├── backend_v2/                 # Python FastAPI + LangGraph backend
│   ├── server_langgraph.py     # Main server with AG-UI SSE streaming
│   ├── tools/                  # Tool definitions (weather, calculator, haiku)
│   └── test_server_langgraph.py
├── frontend_v2/                # React + Vite frontend
│   ├── src/
│   │   ├── App.tsx             # Main chat UI
│   │   ├── useChat.ts          # AG-UI protocol hook
│   │   └── types.ts            # TypeScript types
│   ├── tests/                  # Playwright e2e tests
│   └── playwright.config.ts
├── pyproject.toml              # Python dependencies
└── .env                        # Environment variables (gitignored)
```
