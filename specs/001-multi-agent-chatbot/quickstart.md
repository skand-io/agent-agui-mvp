# Quickstart: Multi-Agent Chatbot

**Feature**: 001-multi-agent-chatbot
**Date**: 2025-12-14

## Prerequisites

- Python 3.11+
- Node.js 18+
- uv (Python package manager)
- OpenRouter API key

## Setup

### 1. Clone and Install

```bash
# Backend dependencies
cd minimal-chat
uv sync

# Frontend dependencies
cd frontend
npm install
npx playwright install
cd ..
```

### 2. Configure Environment

Create `.env` in the root directory:

```bash
OPENROUTER_API_KEY=your_key_here
MODEL=anthropic/claude-3-5-sonnet
```

### 3. Start Development Servers

In separate terminals:

```bash
# Terminal 1: Backend
cd backend && uv run python server.py

# Terminal 2: Frontend
cd frontend && npm run dev
```

Open http://localhost:5173 in your browser.

## Quick Usage

### Basic Chat

Send a message and receive a streamed response:

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"id": "1", "type": "human", "content": "Hello, what can you do?"}
    ]
  }'
```

### With Backend Tool

Ask something that triggers a tool:

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"id": "1", "type": "human", "content": "What is the weather in San Francisco?"}
    ]
  }'
```

Expected SSE events:
1. `RUN_STARTED`
2. `TEXT_MESSAGE_START`
3. `TOOL_CALL_START` (name: get_weather)
4. `TOOL_CALL_ARGS` (city: San Francisco)
5. `TOOL_CALL_RESULT` (weather data)
6. `TOOL_CALL_END`
7. `TEXT_MESSAGE_CONTENT` (streamed response)
8. `TEXT_MESSAGE_END`
9. `RUN_FINISHED`

### With Frontend Tool

Register a frontend tool and trigger it:

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"id": "1", "type": "human", "content": "Switch to dark mode"}
    ],
    "tools": [
      {
        "name": "set_theme",
        "description": "Change the UI theme",
        "args_schema": {
          "type": "object",
          "properties": {
            "theme": {"type": "string", "enum": ["light", "dark"]}
          },
          "required": ["theme"]
        },
        "execution_location": "frontend"
      }
    ]
  }'
```

Frontend receives `TOOL_CALL_*` events without `TOOL_CALL_RESULT` (executes locally).

### With Mode Switching

Start in default mode, switch to SQL mode:

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"id": "1", "type": "human", "content": "I need to write a SQL query to find all users who signed up last month"}
    ]
  }'
```

The assistant will use `switch_mode` tool to change to SQL mode, then provide SQL-specific assistance.

### With Context Injection

Provide UI context:

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"id": "1", "type": "human", "content": "Tell me more about this"}
    ],
    "context": {
      "ui_context": {
        "current_page": "/insights/123",
        "selected_item": {
          "type": "insight",
          "id": 123,
          "name": "Weekly Active Users"
        }
      }
    }
  }'
```

The assistant knows you're looking at the "Weekly Active Users" insight.

## Running Tests

```bash
# All backend tests
cd backend && uv run python test_e2e.py

# Specific test files
cd backend && uv run python test_backend_tools.py
cd backend && uv run python test_frontend_tools.py

# Frontend e2e tests
cd frontend && npm test

# Frontend unit tests
cd frontend && npm run test:unit

# All frontend tests
cd frontend && npm run test:all
```

## Project Structure

```
minimal-chat/
├── backend/
│   ├── server.py          # Main FastAPI server
│   ├── tools/             # Tool system
│   ├── modes/             # Agent modes
│   ├── state/             # State management
│   └── context/           # Context injection
├── frontend/
│   ├── src/
│   │   ├── hooks/useChat.ts   # AG-UI client
│   │   ├── tools.ts           # Frontend tool handlers
│   │   └── components/        # UI components
│   └── tests/
└── specs/001-multi-agent-chatbot/
    ├── spec.md            # Feature specification
    ├── plan.md            # Implementation plan
    ├── research.md        # Research decisions
    ├── data-model.md      # Data entities
    └── contracts/api.yaml # OpenAPI spec
```

## Key Concepts

### AG-UI Protocol

Server-Sent Events stream with typed events:
- `RUN_STARTED/FINISHED`: Lifecycle
- `TEXT_MESSAGE_*`: Response streaming
- `TOOL_CALL_*`: Tool execution

### Tool Types

| Type | Execution | Result |
|------|-----------|--------|
| Backend | Server | `TOOL_CALL_RESULT` event |
| Frontend | Browser | No result event (client handles) |

### Agent Modes

- `default`: General assistant, common tools
- `sql`: SQL query generation and execution
- (extensible: add more modes as needed)

### Context Injection

Frontend sends `context` with request. Server formats as system message before user message.

## Troubleshooting

### "API key not found"
Ensure `.env` has `OPENROUTER_API_KEY` set.

### "Connection refused on port 8000"
Start the backend server: `cd backend && uv run python server.py`

### "Tool not found"
Check tool is registered. Use `GET /tools` to list available tools.

### SSE events not streaming
Ensure `Accept: text/event-stream` header is set. Check CORS if using browser.
