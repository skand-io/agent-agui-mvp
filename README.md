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

- **Python 3.11+**
- **Node.js 20+**
- **[uv](https://github.com/astral-sh/uv)** - Fast Python package manager
  ```bash
  # Install uv (macOS/Linux)
  curl -LsSf https://astral.sh/uv/install.sh | sh
  ```

### Step 1: Clone and Setup Environment

```bash
# Clone the repository
git clone https://github.com/rawmarshmellows/agent-agui-mvp.git
cd agent-agui-mvp

# Create the .env file with your OpenRouter API key
cat > .env << 'EOF'
OPENROUTER_API_KEY=your-openrouter-api-key-here
MODEL=amazon/nova-2-lite-v1:free
EOF
```

> **Note**: Get your OpenRouter API key from [openrouter.ai](https://openrouter.ai)

### Step 2: Install Dependencies

```bash
# Install Python backend dependencies
uv sync

# Install Node.js frontend dependencies
cd frontend
npm install
cd ..
```

### Step 3: Run the Application

You need **two terminal windows** to run both servers:

**Terminal 1 - Start the Backend (FastAPI server on port 8000):**
```bash
cd backend
uv run python server.py
```

You should see:
```
INFO:     Uvicorn running on http://0.0.0.0:8000
```

**Terminal 2 - Start the Frontend (Vite dev server on port 3000):**
```bash
cd frontend
npm run dev
```

You should see:
```
VITE v5.x.x  ready in xxx ms
➜  Local:   http://localhost:3000/
```

### Step 4: Use the Chat Interface

1. Open your browser to **http://localhost:3000**
2. Try these example prompts:

| Prompt | What Happens |
|--------|--------------|
| `Greet Alice` | Frontend tool - shows an alert in your browser |
| `Change the theme to lightblue` | Frontend tool - changes background color |
| `What's the weather in Tokyo?` | Backend tool - returns mock weather data |
| `Calculate 15 * 7` | Backend tool - evaluates math expression |

---

## Running Tests

### Backend API Tests

These tests verify the AG-UI protocol implementation and tool execution at the API level.

```bash
cd backend

# Run all backend tests
uv run python test_e2e.py

# Run only backend tool tests (get_weather, calculate)
uv run python test_backend_tools.py

# Run only frontend tool tests at API level (greet, setTheme)
uv run python test_frontend_tools.py
```

### Frontend E2E Tests (Playwright)

These tests run a real browser and verify the complete user flow.

**First-time setup - Install Playwright browsers:**
```bash
cd frontend
npx playwright install
```

**Run the tests:**
```bash
cd frontend

# Run tests in headless mode (CI-style)
npm test

# Run tests with browser visible (useful for debugging)
npm run test:headed
```

> **Note**: Playwright tests automatically start both the frontend and backend servers, so you don't need to start them manually.

**View test report:**
After running tests, open the HTML report:
```bash
npx playwright show-report
```

---

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

---

## GitHub Actions CI

The repository includes a CI workflow (`.github/workflows/test.yml`) that runs on push/PR to main:
- Backend Python tests
- Frontend Playwright e2e tests

**To enable CI in your fork:**
1. Go to your repository Settings → Secrets and variables → Actions
2. Add a new secret: `OPENROUTER_API_KEY` with your API key value

---

## Troubleshooting

### Backend won't start
- Make sure you have Python 3.11+ installed: `python --version`
- Ensure `.env` file exists in the root directory with valid `OPENROUTER_API_KEY`
- Check if port 8000 is already in use: `lsof -i :8000`

### Frontend won't start
- Make sure you have Node.js 20+ installed: `node --version`
- Run `npm install` in the frontend directory
- Check if port 3000 is already in use: `lsof -i :3000`

### Tests fail with "Connection error"
- Ensure your `OPENROUTER_API_KEY` is valid
- Check your internet connection
- The free model may have rate limits - wait a few seconds between tests

### Playwright tests fail
- Make sure you've installed browsers: `npx playwright install`
- Try running with `npm run test:headed` to see what's happening

## License

MIT
