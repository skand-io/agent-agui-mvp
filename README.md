# AG-UI MVP

A minimal CopilotKit-like implementation using the [AG-UI (Agent UI) Protocol](https://docs.ag-ui.com). This project demonstrates how to build an AI chat interface with both frontend and backend tool execution via Server-Sent Events (SSE) streaming.

## Features

- **AG-UI Protocol Implementation**: Full support for SSE streaming events
- **Frontend Tools**: Execute tools in the browser (e.g., `greet`, `setTheme`)
- **Backend Tools**: Execute tools on the server (e.g., `get_weather`, `calculate`)
- **React + Vite Frontend**: Modern TypeScript React app with component-based architecture
- **FastAPI Backend**: Python server with OpenRouter LLM integration
- **E2E Testing**: Playwright tests for frontend tool execution
- **CI/CD**: GitHub Actions workflow for automated testing

## Project Structure

```
agent-agui-mvp/
├── backend/                    # Python FastAPI server
│   ├── server.py               # Main AG-UI protocol server
│   ├── test_utils.py           # Shared test utilities
│   ├── test_e2e.py             # Combined e2e tests
│   ├── test_backend_tools.py   # Backend tool tests
│   └── test_frontend_tools.py  # Frontend tool tests (API-level)
├── frontend/                   # React + Vite frontend
│   ├── src/
│   │   ├── components/         # React components
│   │   ├── hooks/              # Custom React hooks
│   │   ├── types/              # TypeScript types
│   │   └── tools.ts            # Frontend tool definitions
│   ├── tests/                  # Playwright e2e tests
│   ├── vite.config.ts
│   └── playwright.config.ts
├── .github/workflows/          # GitHub Actions CI
└── .env                        # Environment variables (not committed)
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 20+
- [uv](https://github.com/astral-sh/uv) (Python package manager)

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/rawmarshmellows/agent-agui-mvp.git
   cd agent-agui-mvp
   ```

2. **Create environment file**
   ```bash
   cat > .env << EOF
   OPENROUTER_API_KEY=your-api-key-here
   MODEL=amazon/nova-2-lite-v1:free
   EOF
   ```

3. **Install backend dependencies**
   ```bash
   uv sync
   ```

4. **Install frontend dependencies**
   ```bash
   cd frontend && npm install
   ```

### Running the Application

1. **Start the backend server**
   ```bash
   cd backend && uv run python server.py
   ```

2. **Start the frontend dev server** (in another terminal)
   ```bash
   cd frontend && npm run dev
   ```

3. Open http://localhost:3000 in your browser

### Running Tests

**Backend tests:**
```bash
cd backend && uv run python test_e2e.py
```

**Frontend Playwright tests:**
```bash
cd frontend && npx playwright install && npm test
```

## AG-UI Protocol Events

The implementation supports the following SSE events:

| Event | Description |
|-------|-------------|
| `RUN_STARTED` | Indicates a new run has begun |
| `RUN_FINISHED` | Indicates the run has completed |
| `TEXT_MESSAGE_START` | Starts a new text message |
| `TEXT_MESSAGE_CONTENT` | Streams text content delta |
| `TEXT_MESSAGE_END` | Ends the current text message |
| `TOOL_CALL_START` | Starts a tool call |
| `TOOL_CALL_ARGS` | Streams tool call arguments |
| `TOOL_CALL_END` | Ends tool call (triggers frontend execution) |
| `TOOL_CALL_RESULT` | Returns backend tool execution result |

## Tool Types

### Frontend Tools
Execute in the browser. The server streams the tool call but does NOT return a result.

- **greet**: Shows an alert greeting a person by name
- **setTheme**: Changes the page background color

### Backend Tools
Execute on the server and return results via `TOOL_CALL_RESULT`.

- **get_weather**: Returns weather information for a city
- **calculate**: Evaluates mathematical expressions

## Example Prompts

Try these in the chat:
- "Greet Alice" - Triggers the frontend `greet` tool
- "Change the theme to lightblue" - Triggers the frontend `setTheme` tool
- "What's the weather in Tokyo?" - Triggers the backend `get_weather` tool
- "Calculate 15 * 7" - Triggers the backend `calculate` tool

## GitHub Actions

The repository includes a CI workflow that runs on push/PR to main:
- Backend Python tests
- Frontend Playwright e2e tests

To enable CI, add `OPENROUTER_API_KEY` as a repository secret.

## License

MIT
