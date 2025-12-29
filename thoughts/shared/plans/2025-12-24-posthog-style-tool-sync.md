# PostHog-Style Tool Synchronization Implementation Plan

## Overview

This is an **alternative implementation plan** for frontend/backend tool synchronization using PostHog's state-in-arguments pattern. Instead of relying on message history for state correlation (Option B), this approach passes **full tool state explicitly in every tool call argument**.

**Key Difference from Option B**:
- **Option B (Message History)**: State is implicit in `toolCalls[]` + `tool` messages with `toolCallId` correlation
- **PostHog Style (This Plan)**: State is explicit in tool arguments - LLM tracks and replays full state each call

---

## Architecture Comparison

### Option B: Message History (Current Plan)

```
LLM generates: toolCalls: [{id: "tc1", name: "greet", args: {name: "John"}}]

Backend emits: TOOL_CALL_END for "greet"
Frontend executes: greet({name: "John"}) → "Greeted John"
Frontend adds: {role: "tool", toolCallId: "tc1", content: "Greeted John"}

Follow-up: LLM sees tool message → knows greet was executed
State correlation: toolCallId links call → result
```

### PostHog Style: State in Arguments (This Plan)

```
Tool definition includes state schema:
  todo_write(todos: list[TodoItem])   # Full state in args
  greet(name: str, execution_state: dict)  # State passed explicitly

LLM generates: todo_write({
  todos: [
    {id: "1", content: "Get weather", status: "completed", result: "20°C"},
    {id: "2", content: "Greet John", status: "in_progress"},
  ]
})

State is: In the tool arguments themselves
LLM must: Track all state and replay it each call
```

---

## PostHog Architecture Deep Dive

Based on research of PostHog's codebase:

### Key Files in PostHog

| File | Purpose |
|------|---------|
| `/ee/hogai/tool.py` | `MaxTool` base class with `_state` storage |
| `/ee/hogai/utils/types/base.py` | `AssistantState` Pydantic model (30+ fields) |
| `/ee/hogai/chat_agent/mode_manager.py` | State injection into tools |
| `/ee/hogai/taxonomy_agent/prompts.py` | Comprehensive system prompts |

### How PostHog Passes State

```python
# PostHog's MaxTool class
class MaxTool(BaseTool):
    def __init__(self, state: AssistantState, config: AssistantConfig):
        self._state = state  # Full state stored at initialization
        self._config = config

    def _run(self, *args, **kwargs) -> str:
        # Tool has access to self._state for all operations
        return self.execute(*args, **kwargs)

# State injection (mode_manager.py)
def get_tools(state: AssistantState) -> list[BaseTool]:
    return [
        TodoWriteTool(state=state, config=config),
        SearchTool(state=state, config=config),
        # ... tools receive state at construction
    ]
```

### PostHog's TodoItem Schema

```python
class TodoItem(BaseModel):
    id: str
    content: str
    status: Literal["pending", "in_progress", "completed"]
    result: Optional[str] = None  # Execution result

class TodoWriteArgs(BaseModel):
    todos: list[TodoItem]  # Full state in every call
```

---

## State Management: PostHog Style

### Where State Lives

| Aspect | PostHog Style | Message History (Option B) |
|--------|---------------|---------------------------|
| **State location** | Tool arguments every call | Spread across messages |
| **Who tracks state** | LLM must track & replay | Implicit in history |
| **State visibility** | Explicit in tool args | Parse from messages |
| **Error recovery** | LLM must remember | Re-send history |

### State Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        REQUEST 1                                 │
├─────────────────────────────────────────────────────────────────┤
│ User: "Get weather for Tokyo and greet John"                    │
│                                                                  │
│ LLM generates:                                                   │
│   tool_execution({                                               │
│     execution_state: {                                           │
│       pending_tools: [                                           │
│         {id: "1", name: "get_weather", args: {city: "Tokyo"}},   │
│         {id: "2", name: "greet", args: {name: "John"}}           │
│       ],                                                         │
│       completed_tools: []                                        │
│     }                                                            │
│   })                                                             │
│                                                                  │
│ Backend:                                                         │
│   1. Parses execution_state                                      │
│   2. Executes get_weather (BE tool)                              │
│   3. Sees greet is FE → stops                                    │
│   4. Emits state update: get_weather completed                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   FRONTEND PROCESSES                             │
├─────────────────────────────────────────────────────────────────┤
│ 1. Receives STATE_DELTA: get_weather → completed                 │
│ 2. Receives TOOL_CALL_END for greet → executes locally          │
│ 3. Updates state: greet → completed                              │
│ 4. Auto-follow-up with NEW full state                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        REQUEST 2 (Follow-up)                     │
├─────────────────────────────────────────────────────────────────┤
│ LLM generates:                                                   │
│   tool_execution({                                               │
│     execution_state: {                                           │
│       pending_tools: [],                                         │
│       completed_tools: [                                         │
│         {id: "1", name: "get_weather", result: "20°C, Sunny"},   │
│         {id: "2", name: "greet", result: "Greeted John"}         │
│       ]                                                          │
│     }                                                            │
│   })                                                             │
│                                                                  │
│ LLM sees ALL results in state → generates final response         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Detailed Implementation

### Phase 0: Define State Schema

#### New Types

**File**: `frontend/src/types/index.ts`

```typescript
/** Status of a tool in the execution pipeline */
export type ToolExecutionStatus = 'pending' | 'executing' | 'completed' | 'failed';

/** Where a tool executes */
export type ToolLocation = 'frontend' | 'backend';

/** A tool in the execution state (PostHog style) */
export interface ExecutionToolItem {
  /** Unique ID for this tool invocation */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments (JSON string or object) */
  args: Record<string, unknown>;
  /** Execution status */
  status: ToolExecutionStatus;
  /** Where this tool runs */
  location: ToolLocation;
  /** Result after execution (null if pending) */
  result?: string | null;
  /** Error message if failed */
  error?: string | null;
}

/** Full execution state passed in tool arguments */
export interface ToolExecutionState {
  /** Tools that need to be executed */
  pendingTools: ExecutionToolItem[];
  /** Tools that have been executed */
  completedTools: ExecutionToolItem[];
  /** Current execution index (which tool we're on) */
  currentIndex: number;
}
```

**File**: `backend/server.py`

```python
from pydantic import BaseModel, Field
from typing import Literal

class ToolExecutionStatus(str, Enum):
    PENDING = "pending"
    EXECUTING = "executing"
    COMPLETED = "completed"
    FAILED = "failed"

class ToolLocation(str, Enum):
    FRONTEND = "frontend"
    BACKEND = "backend"

class ExecutionToolItem(BaseModel):
    """A tool in the execution pipeline."""
    id: str
    name: str
    args: dict = Field(default_factory=dict)
    status: ToolExecutionStatus = ToolExecutionStatus.PENDING
    location: ToolLocation
    result: str | None = None
    error: str | None = None

class ToolExecutionState(BaseModel):
    """Full execution state passed in tool arguments (PostHog style)."""
    pending_tools: list[ExecutionToolItem] = Field(default_factory=list)
    completed_tools: list[ExecutionToolItem] = Field(default_factory=list)
    current_index: int = 0
```

---

### Phase 1: State Management Tool

Instead of individual tools, we define a **meta-tool** that manages execution state.

**File**: `backend/server.py`

```python
# The orchestration tool that receives and returns state
TOOL_ORCHESTRATOR = {
    "name": "execute_tools",
    "description": """
Execute one or more tools and track their state.

IMPORTANT: You must include the FULL current state in every call.
- pending_tools: Tools that need to be executed
- completed_tools: Tools that have been executed (with results)

Example flow:
1. First call: pending_tools=[{name:"greet",args:{name:"John"}}], completed_tools=[]
2. After execution: pending_tools=[], completed_tools=[{name:"greet",result:"Greeted John"}]

Always pass the complete state - do not rely on conversation history for state.
""",
    "parameters": {
        "type": "object",
        "properties": {
            "execution_state": {
                "type": "object",
                "description": "Current execution state with pending and completed tools",
                "properties": {
                    "pending_tools": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "name": {"type": "string"},
                                "args": {"type": "object"},
                                "status": {"type": "string"},
                                "location": {"type": "string"},
                            },
                            "required": ["id", "name", "args", "location"]
                        }
                    },
                    "completed_tools": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "name": {"type": "string"},
                                "args": {"type": "object"},
                                "status": {"type": "string"},
                                "result": {"type": "string"},
                                "error": {"type": "string"},
                            }
                        }
                    },
                    "current_index": {"type": "integer"}
                },
                "required": ["pending_tools", "completed_tools"]
            }
        },
        "required": ["execution_state"]
    }
}
```

---

### Phase 2: Backend State Processing

**File**: `backend/server.py` - Modify tool execution loop

```python
async def process_execution_state(
    state: ToolExecutionState,
    encoder: SSEEncoder
) -> AsyncGenerator[bytes, None]:
    """
    Process tools from execution state (PostHog style).

    Key behavior:
    - Execute backend tools sequentially
    - Stop at first frontend tool
    - Emit STATE_DELTA events for state changes
    - Return updated state for follow-up
    """
    updated_state = ToolExecutionState(
        pending_tools=[],
        completed_tools=list(state.completed_tools),
        current_index=state.current_index
    )

    for tool in state.pending_tools:
        tool_id = tool.id
        tool_name = tool.name
        tool_args = tool.args

        # Emit TOOL_CALL_START
        yield encoder.encode(ToolCallStartEvent(
            tool_call_id=tool_id,
            tool_call_name=tool_name
        ))

        # Emit TOOL_CALL_ARGS
        yield encoder.encode(ToolCallArgsEvent(
            tool_call_id=tool_id,
            delta=json.dumps(tool_args)
        ))

        # Emit TOOL_CALL_END
        yield encoder.encode(ToolCallEndEvent(tool_call_id=tool_id))

        if tool.location == ToolLocation.BACKEND:
            # Execute backend tool
            if tool_name in BACKEND_TOOLS:
                try:
                    handler = BACKEND_TOOLS[tool_name]["handler"]
                    result = handler(**tool_args)

                    # Add to completed with result
                    completed_tool = ExecutionToolItem(
                        id=tool_id,
                        name=tool_name,
                        args=tool_args,
                        status=ToolExecutionStatus.COMPLETED,
                        location=ToolLocation.BACKEND,
                        result=result
                    )
                    updated_state.completed_tools.append(completed_tool)

                    # Emit TOOL_CALL_RESULT
                    yield encoder.encode(ToolCallResultEvent(
                        message_id=str(uuid.uuid4()),
                        tool_call_id=tool_id,
                        content=result,
                        role="tool"
                    ))

                    # Emit STATE_DELTA for state tracking
                    yield encoder.encode(StateDeltaEvent(
                        operations=[{
                            "op": "add",
                            "path": f"/completed_tools/-",
                            "value": completed_tool.model_dump()
                        }]
                    ))

                except Exception as e:
                    # Add to completed with error
                    failed_tool = ExecutionToolItem(
                        id=tool_id,
                        name=tool_name,
                        args=tool_args,
                        status=ToolExecutionStatus.FAILED,
                        location=ToolLocation.BACKEND,
                        error=str(e)
                    )
                    updated_state.completed_tools.append(failed_tool)
            else:
                logger.warning(f"Unknown backend tool: {tool_name}")

        elif tool.location == ToolLocation.FRONTEND:
            # Frontend tool - STOP processing
            # Keep this tool and remaining as pending
            updated_state.pending_tools.append(tool)

            # Add remaining tools to pending
            remaining_idx = state.pending_tools.index(tool) + 1
            for remaining_tool in state.pending_tools[remaining_idx:]:
                updated_state.pending_tools.append(remaining_tool)

            logger.info(f"Frontend tool {tool_name} - stopping for client execution")
            break

    # Emit final state snapshot
    yield encoder.encode(StateSnapshotEvent(
        state=updated_state.model_dump()
    ))
```

---

### Phase 3: Frontend State Management

**File**: `frontend/src/hooks/useToolExecutionState.ts` (new file)

```typescript
import { useState, useCallback, useRef } from 'react';
import type { ToolExecutionState, ExecutionToolItem } from '../types';

export interface UseToolExecutionStateReturn {
  state: ToolExecutionState;
  addPendingTool: (tool: Omit<ExecutionToolItem, 'status'>) => void;
  markCompleted: (toolId: string, result: string) => void;
  markFailed: (toolId: string, error: string) => void;
  getNextPendingTool: () => ExecutionToolItem | null;
  hasPendingFrontendTools: () => boolean;
  resetState: () => void;
  applyStateSnapshot: (snapshot: ToolExecutionState) => void;
}

const initialState: ToolExecutionState = {
  pendingTools: [],
  completedTools: [],
  currentIndex: 0,
};

export function useToolExecutionState(): UseToolExecutionStateReturn {
  const [state, setState] = useState<ToolExecutionState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const addPendingTool = useCallback((tool: Omit<ExecutionToolItem, 'status'>) => {
    setState(prev => ({
      ...prev,
      pendingTools: [
        ...prev.pendingTools,
        { ...tool, status: 'pending' }
      ]
    }));
  }, []);

  const markCompleted = useCallback((toolId: string, result: string) => {
    setState(prev => {
      const toolIndex = prev.pendingTools.findIndex(t => t.id === toolId);
      if (toolIndex === -1) return prev;

      const tool = prev.pendingTools[toolIndex];
      const completedTool: ExecutionToolItem = {
        ...tool,
        status: 'completed',
        result,
      };

      return {
        ...prev,
        pendingTools: prev.pendingTools.filter(t => t.id !== toolId),
        completedTools: [...prev.completedTools, completedTool],
      };
    });
  }, []);

  const markFailed = useCallback((toolId: string, error: string) => {
    setState(prev => {
      const toolIndex = prev.pendingTools.findIndex(t => t.id === toolId);
      if (toolIndex === -1) return prev;

      const tool = prev.pendingTools[toolIndex];
      const failedTool: ExecutionToolItem = {
        ...tool,
        status: 'failed',
        error,
      };

      return {
        ...prev,
        pendingTools: prev.pendingTools.filter(t => t.id !== toolId),
        completedTools: [...prev.completedTools, failedTool],
      };
    });
  }, []);

  const getNextPendingTool = useCallback((): ExecutionToolItem | null => {
    const frontendTools = stateRef.current.pendingTools.filter(
      t => t.location === 'frontend'
    );
    return frontendTools[0] ?? null;
  }, []);

  const hasPendingFrontendTools = useCallback((): boolean => {
    return stateRef.current.pendingTools.some(t => t.location === 'frontend');
  }, []);

  const resetState = useCallback(() => {
    setState(initialState);
  }, []);

  const applyStateSnapshot = useCallback((snapshot: ToolExecutionState) => {
    setState(snapshot);
  }, []);

  return {
    state,
    addPendingTool,
    markCompleted,
    markFailed,
    getNextPendingTool,
    hasPendingFrontendTools,
    resetState,
    applyStateSnapshot,
  };
}
```

---

### Phase 4: Modified useChat Hook

**File**: `frontend/src/hooks/useChat.ts` - Key modifications

```typescript
// Add state management
import { useToolExecutionState } from './useToolExecutionState';

export function useChat() {
  // ... existing state ...
  const {
    state: executionState,
    markCompleted,
    markFailed,
    getNextPendingTool,
    hasPendingFrontendTools,
    applyStateSnapshot,
  } = useToolExecutionState();

  // Handle STATE_SNAPSHOT events
  const handleStateSnapshot = useCallback((event: AGUIEvent) => {
    if (event.state && typeof event.state === 'object') {
      const snapshot = event.state as ToolExecutionState;
      applyStateSnapshot(snapshot);
    }
  }, [applyStateSnapshot]);

  // Modified event handler
  const handleEventWithContext = async (event: AGUIEvent) => {
    switch (event.type) {
      // ... existing cases ...

      case EventType.STATE_SNAPSHOT:
        handleStateSnapshot(event);
        break;

      case EventType.TOOL_CALL_END: {
        // Check if this is a frontend tool from our state
        const pendingTool = getNextPendingTool();
        if (pendingTool && pendingTool.id === event.toolCallId) {
          // Execute frontend tool
          const action = actions.get(pendingTool.name);
          if (action) {
            try {
              const result = await Promise.resolve(
                action.handler(pendingTool.args)
              );
              markCompleted(pendingTool.id, String(result));
              return { frontendToolExecuted: true };
            } catch (e) {
              markFailed(pendingTool.id, String(e));
              return { frontendToolExecuted: true };
            }
          }
        }
        break;
      }
    }
  };

  // Modified follow-up: Include full execution state
  const sendMessageWithState = async (content: string) => {
    const payload = {
      messages: [...messages, { role: 'user', content }],
      frontendTools: getToolsForBackend(),
      threadId: threadIdRef.current,
      runId: runIdRef.current,
      // PostHog style: Include full execution state
      executionState: executionState,
    };

    // ... rest of sendMessage logic ...
  };
}
```

---

### Phase 5: LLM System Prompt Update

The LLM needs instructions to track state explicitly:

**File**: `backend/server.py` - System message

```python
TOOL_STATE_INSTRUCTIONS = """
## Tool Execution State Management

You have access to tools that may execute on the frontend or backend.
You MUST track execution state explicitly using the execute_tools function.

### State Structure

```json
{
  "execution_state": {
    "pending_tools": [
      {"id": "unique-id", "name": "tool_name", "args": {...}, "location": "frontend|backend"}
    ],
    "completed_tools": [
      {"id": "unique-id", "name": "tool_name", "args": {...}, "result": "...", "status": "completed"}
    ],
    "current_index": 0
  }
}
```

### Rules

1. ALWAYS pass the complete state in every execute_tools call
2. Include ALL completed tools with their results
3. Include ALL pending tools that still need execution
4. When you receive state back, merge it with your tracked state
5. Frontend tools (greet, setTheme) will have results in the next follow-up
6. Backend tools (calculate, get_weather) return results immediately

### Example Flow

User: "Greet John and calculate 5+3"

Call 1:
```json
execute_tools({
  "execution_state": {
    "pending_tools": [
      {"id": "1", "name": "greet", "args": {"name": "John"}, "location": "frontend"},
      {"id": "2", "name": "calculate", "args": {"expression": "5+3"}, "location": "backend"}
    ],
    "completed_tools": [],
    "current_index": 0
  }
})
```

After backend processing, you receive:
- calculate completed with result "8"
- greet still pending (frontend tool)

Call 2 (follow-up):
```json
execute_tools({
  "execution_state": {
    "pending_tools": [],
    "completed_tools": [
      {"id": "2", "name": "calculate", "result": "8", "status": "completed"},
      {"id": "1", "name": "greet", "result": "Hello, John!", "status": "completed"}
    ],
    "current_index": 2
  }
})
```

All tools complete → generate final response.
"""
```

---

## Trade-offs Analysis

### Advantages of PostHog Style

| Advantage | Description |
|-----------|-------------|
| **Explicit state** | State is visible in every call, easy to debug |
| **No hidden state** | Don't need to parse message history |
| **Stateless backend** | Server doesn't need to track tool state |
| **Audit trail** | Every call has full state snapshot |

### Disadvantages of PostHog Style

| Disadvantage | Description |
|--------------|-------------|
| **Token cost** | Full state repeated every call (can be large) |
| **LLM burden** | LLM must perfectly track and replay state |
| **Error prone** | LLM might forget or corrupt state |
| **Verbose prompts** | Need extensive instructions for state management |
| **Complexity** | More complex schema than message history |

### When to Use PostHog Style

- When you need **explicit audit trails** of all state changes
- When your **LLM is reliable** at state tracking (GPT-4, Claude)
- When you have **few tools** (state stays small)
- When you need **stateless backend** (no session storage)

### When to Use Message History (Option B)

- When you want **simpler implementation**
- When **token cost** is a concern
- When you **don't trust LLM** to track state perfectly
- When you have **many tools** or **large results**

---

## Implementation Phases (TDD)

### Phase 0: Write Failing E2E Test

**File**: `backend/test_posthog_style.py`

```python
"""
TDD: Test PostHog-style state passing.
This test should FAIL initially.
"""
import json
import pytest
from fastapi.testclient import TestClient
from server import app


class TestPostHogStyleState:
    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_state_passed_in_tool_args(self, client):
        """Verify execution state is correctly passed and returned."""
        response = client.post("/chat", json={
            "messages": [{"role": "user", "content": "test"}],
            "frontendTools": [{"name": "greet", "parameters": {...}}],
            "executionState": {
                "pendingTools": [
                    {"id": "1", "name": "greet", "args": {"name": "John"}, "location": "frontend"}
                ],
                "completedTools": [],
                "currentIndex": 0
            }
        })

        events = parse_sse_events(response)
        state_snapshot = next(e for e in events if e["type"] == "STATE_SNAPSHOT")

        # Greet should still be pending (frontend tool)
        assert len(state_snapshot["state"]["pendingTools"]) == 1
        assert state_snapshot["state"]["pendingTools"][0]["name"] == "greet"

    def test_backend_tool_moves_to_completed(self, client):
        """Verify backend tools are executed and moved to completed."""
        response = client.post("/chat", json={
            "messages": [{"role": "user", "content": "test"}],
            "executionState": {
                "pendingTools": [
                    {"id": "1", "name": "calculate", "args": {"expression": "5+3"}, "location": "backend"}
                ],
                "completedTools": [],
                "currentIndex": 0
            }
        })

        events = parse_sse_events(response)
        state_snapshot = next(e for e in events if e["type"] == "STATE_SNAPSHOT")

        # Calculate should be completed with result
        assert len(state_snapshot["state"]["completedTools"]) == 1
        assert state_snapshot["state"]["completedTools"][0]["name"] == "calculate"
        assert state_snapshot["state"]["completedTools"][0]["result"] == "8"
```

### Phase 1-6: Follow TDD Pattern

Each phase follows the same TDD structure as Option B:
1. Write failing test
2. Implement minimal code to pass
3. Refactor

---

## Success Criteria

### Automated
- [ ] All PostHog-style tests pass
- [ ] State correctly passed in tool arguments
- [ ] Backend tools execute and update state
- [ ] Frontend tools remain pending for client execution
- [ ] STATE_SNAPSHOT events emitted correctly
- [ ] Follow-up receives updated state

### Manual
- [ ] "Greet John and calculate 5+3" works correctly
- [ ] State visible in browser dev tools
- [ ] LLM correctly tracks state across follow-ups

---

## Decision: Which Approach to Use?

### Recommendation

For **minimal-chat**, **Option B (Message History)** is recommended because:

1. **Simpler implementation** - Already how OpenAI API works
2. **Lower token cost** - Don't repeat full state every call
3. **LLM reliability** - Don't depend on LLM state tracking
4. **Existing pattern** - CopilotKit uses message history

### When PostHog Style Makes Sense

Use PostHog style if:
- You need **explicit state audit trails**
- You're using a **very capable LLM** (GPT-4, Claude Opus)
- You have **few tools with small state**
- You want **stateless backend**

---

## References

- Option B Plan: `thoughts/shared/plans/2025-12-20-option-b-auto-follow-up-tool-sync.md`
- PostHog source: `/ee/hogai/tool.py`, `/ee/hogai/utils/types/base.py`
- Race condition analysis: `docs/FE_BE_TOOL_RACE_CONDITION.md`
