# Implementation Plan: Multi-Agent Chatbot with Dynamic Mode Selection

**Branch**: `001-multi-agent-chatbot` | **Date**: 2025-12-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-multi-agent-chatbot/spec.md`

## Summary

Build a multi-agent chatbot system that supports:
- Real-time streamed responses via SSE
- Dual tool execution (backend tools execute server-side, frontend tools stream to client)
- Dynamic agent mode switching with mode-specific toolkits
- Context injection from external sources
- Conversation state management with summarization

Technical approach: Extend existing FastAPI/React AG-UI implementation with a mode management layer, tool registry system, and context injection pipeline following HogAI architecture patterns.

## Technical Context

**Language/Version**: Python 3.11 (backend), TypeScript 5.6 (frontend)
**Primary Dependencies**:
- Backend: FastAPI, pydantic-ai-slim[ag-ui], OpenAI SDK, httpx
- Frontend: React 18, Vite, Playwright (testing)
**Storage**: In-memory conversation state (no persistent storage for MVP)
**Testing**:
- Backend: pytest with test_utils.py patterns
- Frontend: Playwright (e2e), Vitest (unit)
**Target Platform**: Web application (modern browsers with SSE support)
**Project Type**: Web application (backend + frontend)
**Performance Goals**:
- First token < 2 seconds
- 95% tool executions < 10 seconds
- 50+ messages per conversation
**Constraints**:
- Frontend tools execute without blocking response
- Mode switches preserve 100% context
- Tool routing 100% accurate
**Scale/Scope**: Single-user conversations, predefined modes, extensible tool registry

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution template has placeholder values. Applying reasonable defaults based on the existing codebase patterns:

| Principle | Status | Notes |
|-----------|--------|-------|
| Library-First | PASS | Core functionality will be modular (tools, modes, state) |
| CLI Interface | N/A | Web application, not CLI-focused |
| Test-First | PASS | Existing test patterns in backend/, will extend |
| Integration Testing | PASS | e2e tests exist in frontend/tests/ |
| Simplicity | PASS | Building on existing AG-UI foundation, minimal new dependencies |

**Gate Status**: PASSED - No violations requiring justification.

## Project Structure

### Documentation (this feature)

```text
specs/001-multi-agent-chatbot/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── api.yaml         # OpenAPI specification
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
backend/
├── server.py            # Main FastAPI server (existing, extend)
├── tools/               # NEW: Tool system
│   ├── __init__.py
│   ├── base.py          # MaxTool base class
│   ├── registry.py      # Tool auto-registration
│   └── builtin/         # Built-in tools
│       ├── weather.py
│       └── calculate.py
├── modes/               # NEW: Agent mode system
│   ├── __init__.py
│   ├── manager.py       # AgentModeManager
│   ├── definition.py    # AgentModeDefinition
│   └── presets/         # Mode configurations
│       ├── default.py
│       └── sql.py
├── state/               # NEW: State management
│   ├── __init__.py
│   ├── conversation.py  # ConversationState
│   └── reducer.py       # Message merge logic
├── context/             # NEW: Context injection
│   ├── __init__.py
│   └── manager.py       # ContextManager
├── test_backend_tools.py     # Existing tests
├── test_frontend_tools.py    # Existing tests
├── test_e2e.py               # Existing tests
└── tests/               # NEW: Additional tests
    ├── test_modes.py
    ├── test_tools.py
    └── test_state.py

frontend/
├── src/
│   ├── App.tsx          # Existing, extend
│   ├── tools.ts         # Existing frontend tool handlers
│   ├── components/      # Existing UI components
│   │   ├── ChatContainer.tsx
│   │   ├── Message.tsx
│   │   ├── InputArea.tsx
│   │   └── Loading.tsx
│   ├── hooks/
│   │   ├── useChat.ts   # Existing AG-UI hook
│   │   └── useTools.ts  # NEW: Frontend tool execution
│   ├── context/
│   │   └── ChatContext.tsx  # Existing
│   ├── types/
│   │   └── index.ts     # Existing types
│   └── modes/           # NEW: Mode awareness
│       └── useModes.ts
├── tests/
│   ├── frontend-tools.spec.ts  # Existing Playwright tests
│   └── modes.spec.ts    # NEW: Mode switching tests
└── __tests__/           # Unit tests

tests/                   # NEW: Cross-cutting integration tests
├── contract/
│   └── test_ag_ui_events.py
└── integration/
    └── test_full_flow.py
```

**Structure Decision**: Web application structure (Option 2) matching existing `backend/` + `frontend/` layout. New directories added for modular tool system, mode management, and state handling.

## Complexity Tracking

> No Constitution violations requiring justification.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A | - | - |
