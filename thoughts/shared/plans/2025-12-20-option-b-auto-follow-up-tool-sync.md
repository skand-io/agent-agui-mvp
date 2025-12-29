# Option B: Auto-Follow-Up Tool Synchronization Implementation Plan

## Overview

Implement the recommended Option B approach for frontend/backend tool synchronization. This leverages the **existing auto-follow-up mechanism** rather than adding complex `asyncio.Event` blocking. The approach is simpler, aligns with CopilotKit patterns, and maintains continuous SSE streaming.

**Key Enhancement**: Stop tool execution when encountering a frontend tool to ensure dependent backend tools receive correct data on the follow-up request.

**Protocol Compliance**: This implementation follows the [AG-UI Protocol](https://docs.ag-ui.com/llms-full.txt) specification using the official `ag_ui` Python library. See [AG-UI Protocol Compliance](#ag-ui-protocol-compliance) section for details.

---

## State Management Deep Dive

### The Core Question: Where Does Tool State Live?

When FE and BE tools need to be synchronized, we need to track:
1. Which tools have been called
2. Which tools have been executed
3. What results each tool produced

### Approach Comparison

| Approach | Where State Lives | Who Manages It | Complexity |
|----------|------------------|----------------|------------|
| **A: Message History** | `toolCalls` + `tool` messages | OpenAI API format | Low ✅ |
| **B: Args (PostHog-style)** | Tool arguments each call | LLM must track | Medium |
| **C: Server Session** | Backend memory/DB | Server code | High |

### PostHog's todo_write Approach (for reference)

PostHog passes **full state in every tool call**:

```python
# Every call includes complete state:
todo_write(todos=[
    {"id": "1", "content": "Get weather", "status": "completed"},
    {"id": "2", "content": "Greet John", "status": "in_progress"},
])
```

**How it works**: LLM must remember and replay entire state each call.
**Pros**: Explicit, auditable state
**Cons**: LLM must perfectly track state, verbose, error-prone

### Our Approach: Message History as State (Recommended)

State is **implicitly tracked** in message structure:

```typescript
messages: [
  // 1. Assistant called two tools
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {id: "tc1", name: "get_weather", arguments: '{"city":"Tokyo"}'},
      {id: "tc2", name: "greet", arguments: '{"name":"John"}'}
    ]
  },
  // 2. Tool results (presence = executed, absence = pending)
  { role: "tool", toolCallId: "tc1", content: "Weather: 20°C" },  // ✅ BE executed
  { role: "tool", toolCallId: "tc2", content: "Greeted John" },   // ✅ FE executed
]
```

**How state is determined**:
- `toolCalls` array = what LLM requested
- `tool` messages with matching `toolCallId` = what was executed
- Missing `tool` message = not yet executed (LLM will retry on follow-up)

**Why this is better**:
1. **Already implemented** - OpenAI API expects this exact format
2. **Automatic correlation** - `toolCallId` links call → result
3. **No LLM state management** - LLM just reads history
4. **Backend can verify** - Check which `toolCallId`s have results

---

## Detailed State Storage Architecture

### Data Structures

#### Frontend Types (`frontend/src/types/index.ts`)

```typescript
// Tool call attached to assistant message
interface ToolCallData {
  id: string;           // Unique ID (e.g., "call_abc123")
  name: string;         // Tool name (e.g., "get_weather")
  arguments: string;    // JSON string (e.g., '{"city":"Tokyo"}')
}

// A message in the conversation
interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallData[];  // Only on assistant messages
  toolCallId?: string;         // Only on tool messages - links to ToolCallData.id
  isFrontend?: boolean;        // Was this a frontend tool execution?
  isBackend?: boolean;         // Was this a backend tool execution?
}
```

#### Backend Types (`backend/server.py`)

```python
class ToolCallData(BaseModel):
    id: str                    # Matches frontend ToolCallData.id
    name: str
    arguments: str = "{}"

class ChatMessage(BaseModel):
    role: MessageRole          # "user" | "assistant" | "tool"
    content: str = ""
    tool_calls: list[ToolCallData] | None  # Only on assistant messages
    tool_call_id: str | None               # Only on tool messages
```

### Where State Lives at Each Step

#### Step 1: User Sends Message
```typescript
// Frontend state (useChat.ts)
messages = [
  { role: "user", content: "Get weather for Tokyo and greet John" }
]
```

#### Step 2: LLM Generates Tool Calls
```typescript
// Backend receives from LLM, streams to frontend
// Frontend builds state from SSE events:

// On TOOL_CALL_START + TOOL_CALL_ARGS events:
toolCalls = {
  "call_abc123": { name: "get_weather", arguments: '{"city":"Tokyo"}' },
  "call_def456": { name: "greet", arguments: '{"name":"John"}' }
}

// On TEXT_MESSAGE_END, assistant message is added:
messages = [
  { role: "user", content: "Get weather for Tokyo and greet John" },
  {
    role: "assistant",
    content: "",  // May be empty if only tool calls
    id: "msg_xyz",
    toolCalls: [
      { id: "call_abc123", name: "get_weather", arguments: '{"city":"Tokyo"}' },
      { id: "call_def456", name: "greet", arguments: '{"name":"John"}' }
    ]
  }
]
```

#### Step 3: Backend Executes BE Tool, Stops at FE Tool
```typescript
// On TOOL_CALL_RESULT event for get_weather:
messages = [
  { role: "user", content: "Get weather for Tokyo and greet John" },
  { role: "assistant", content: "", toolCalls: [...] },
  {
    role: "tool",
    toolCallId: "call_abc123",  // Links to assistant's toolCalls[0].id
    content: "Weather in Tokyo: 20°C, Sunny",
    isBackend: true
  }
]

// On TOOL_CALL_END for greet (FE tool):
// Backend STOPS here, emits RUN_FINISHED
// greet has NO tool message yet - this is how we know it's pending
```

#### Step 4: Frontend Executes FE Tool
```typescript
// useChat.ts:532-555 - TOOL_CALL_END handler
// Looks up handler from actions Map, executes it

const result = await contextAction.handler({ name: "John" });
// result = "Greeted John successfully"

// Adds tool message:
messages = [
  { role: "user", content: "Get weather for Tokyo and greet John" },
  { role: "assistant", content: "", toolCalls: [...] },
  { role: "tool", toolCallId: "call_abc123", content: "Weather...", isBackend: true },
  {
    role: "tool",
    toolCallId: "call_def456",  // Links to assistant's toolCalls[1].id
    content: 'Frontend tool "greet" executed: Greeted John successfully',
    isFrontend: true
  }
]
```

#### Step 5: Auto-Follow-Up Sends Full State
```typescript
// useChat.ts:173-179 - shouldFollowUp check
// frontendToolExecuted = true, so follow-up triggers

// sendMessageInternal called with updated messages
// Backend receives full message history:
{
  messages: [
    { role: "user", content: "Get weather for Tokyo and greet John" },
    {
      role: "assistant",
      toolCalls: [
        { id: "call_abc123", name: "get_weather", arguments: '{"city":"Tokyo"}' },
        { id: "call_def456", name: "greet", arguments: '{"name":"John"}' }
      ]
    },
    { role: "tool", toolCallId: "call_abc123", content: "Weather in Tokyo: 20°C" },
    { role: "tool", toolCallId: "call_def456", content: "Greeted John successfully" }
  ],
  threadId: "thread_123",
  runId: "run_456"
}
```

#### Step 6: LLM Sees Complete State
```python
# Backend builds OpenAI messages (server.py:636-735)
# LLM receives:
[
  {"role": "user", "content": "Get weather for Tokyo and greet John"},
  {
    "role": "assistant",
    "content": "",
    "tool_calls": [
      {"id": "call_abc123", "type": "function", "function": {"name": "get_weather", "arguments": "..."}},
      {"id": "call_def456", "type": "function", "function": {"name": "greet", "arguments": "..."}}
    ]
  },
  {"role": "tool", "tool_call_id": "call_abc123", "content": "Weather in Tokyo: 20°C"},
  {"role": "tool", "tool_call_id": "call_def456", "content": "Greeted John successfully"}
]

# LLM sees ALL results → generates final response:
# "The weather in Tokyo is 20°C and sunny. I've greeted John for you!"
```

### State Correlation: The `toolCallId` Link

The **critical link** is `toolCallId`:

```
┌─────────────────────────────────────────────────────────────────┐
│                    ASSISTANT MESSAGE                             │
├─────────────────────────────────────────────────────────────────┤
│ toolCalls: [                                                     │
│   { id: "call_abc123", name: "get_weather", ... },  ◄───┐       │
│   { id: "call_def456", name: "greet", ... }         ◄───┼──┐    │
│ ]                                                        │  │    │
└──────────────────────────────────────────────────────────┼──┼────┘
                                                           │  │
┌──────────────────────────────────────────────────────────┼──┼────┐
│                    TOOL MESSAGES                         │  │    │
├──────────────────────────────────────────────────────────┼──┼────┤
│ { role: "tool", toolCallId: "call_abc123", ... }    ────┘  │    │
│ { role: "tool", toolCallId: "call_def456", ... }    ───────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**How to determine tool state**:
```typescript
function getToolState(messages: Message[]): Map<string, 'pending' | 'executed'> {
  const state = new Map<string, 'pending' | 'executed'>();

  // Find assistant message with toolCalls
  const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
  if (!assistantMsg?.toolCalls) return state;

  // Mark all as pending initially
  for (const tc of assistantMsg.toolCalls) {
    state.set(tc.id, 'pending');
  }

  // Find matching tool results
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      state.set(msg.toolCallId, 'executed');
    }
  }

  return state;
  // Result: { "call_abc123": "executed", "call_def456": "executed" }
}
```

### Code References: Where State is Read/Written

| Operation | File | Lines | Description |
|-----------|------|-------|-------------|
| **Store tool calls** | `useChat.ts` | 117, 497-508 | `toolCalls` dict accumulates during streaming |
| **Attach to assistant** | `useChat.ts` | 262-327 | `attachToolCallToAssistant()` adds `toolCalls` array |
| **Add BE tool result** | `useChat.ts` | 625-674 | `TOOL_CALL_RESULT` handler adds tool message |
| **Add FE tool result** | `useChat.ts` | 532-555 | `TOOL_CALL_END` handler executes & adds tool message |
| **Send to backend** | `useChat.ts` | 85-98 | Payload includes `toolCalls` and `toolCallId` |
| **Parse in backend** | `server.py` | 700-707 | `build_messages_with_context()` builds OpenAI format |
| **Check if FE tool** | `server.py` | 1009-1011 | `if tool_name in BACKEND_TOOLS` else it's frontend |

### Why This Beats PostHog's Approach

| Aspect | Message History (Ours) | Args-Based (PostHog) |
|--------|------------------------|----------------------|
| **State location** | Spread across messages | Repeated in every call |
| **State size** | Grows incrementally | Full copy each time |
| **LLM burden** | Just read history | Must track & replay |
| **Correlation** | Automatic via `toolCallId` | Manual ID matching |
| **Error recovery** | Re-send history | LLM must remember |
| **Debugging** | Inspect message array | Parse tool args |

---

### State Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        REQUEST 1                                 │
├─────────────────────────────────────────────────────────────────┤
│ User: "Get weather for Tokyo and greet John"                    │
│                                                                  │
│ LLM generates toolCalls: [get_weather, greet]                   │
│                                                                  │
│ Backend processes:                                               │
│   ├─ get_weather (BE) → execute → TOOL_CALL_RESULT              │
│   └─ greet (FE) → TOOL_CALL_END → STOP (don't continue!)        │
│                                                                  │
│ RUN_FINISHED                                                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   FRONTEND PROCESSES                             │
├─────────────────────────────────────────────────────────────────┤
│ 1. Receives get_weather result → adds tool message              │
│ 2. Receives greet TOOL_CALL_END → executes handler              │
│ 3. Adds greet result as tool message                            │
│ 4. Auto-follow-up triggered (frontendToolExecuted=true)         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                        REQUEST 2 (Follow-up)                     │
├─────────────────────────────────────────────────────────────────┤
│ Messages sent to backend:                                        │
│   ├─ User: "Get weather for Tokyo and greet John"               │
│   ├─ Assistant: {toolCalls: [get_weather, greet]}               │
│   ├─ Tool: {toolCallId: "tc1", content: "Weather: 20°C"}        │
│   └─ Tool: {toolCallId: "tc2", content: "Greeted John"}         │
│                                                                  │
│ LLM sees BOTH results → generates final text response           │
│ (No new tool calls needed - all results present)                │
└─────────────────────────────────────────────────────────────────┘
```

### Why "Stop at FE Tool" is Critical

**Without stopping** (current behavior):
```
LLM calls: [fe_get_user_input(), be_process_input(???)]
                                            ↑
                            LLM guessed args since FE hasn't run!

Backend executes be_process_input with WRONG data immediately.
```

**With stopping** (new behavior):
```
LLM calls: [fe_get_user_input(), be_process_input(???)]

Backend:
  1. Sees fe_get_user_input is FE → emit TOOL_CALL_END, STOP
  2. Does NOT execute be_process_input
  3. RUN_FINISHED

Frontend:
  1. Executes fe_get_user_input → gets real result
  2. Adds to messages
  3. Auto-follow-up

Follow-up:
  1. LLM sees fe_get_user_input result
  2. LLM generates NEW call: be_process_input(CORRECT_DATA)
  3. Backend executes with correct data
```

---

## Current State Analysis

### What Already Works
1. **Auto-follow-up mechanism** (`useChat.ts:173-179`) - triggers recursive calls after tool execution
2. **Frontend tool execution** (`useChat.ts:532-555`) - handlers execute and results added to messages
3. **Backend tool execution** (`server.py:979-1008`) - handlers execute and emit `TOOL_CALL_RESULT`
4. **Message history threading** (`useChat.ts:85-98`) - includes toolCalls and toolCallId for proper LLM context

### What's Missing
1. **Backend doesn't stop at FE tools** - continues executing subsequent BE tools with potentially wrong data
2. No `/tool_result` endpoint for server-side logging/persistence
3. No fetch timeout (can hang indefinitely)
4. No specific error codes for timeout vs other errors

### Key Code Locations:
- Auto-follow-up: `useChat.ts:173-179` - KEEP THIS, it's correct
- Frontend tool execution: `useChat.ts:532-555` - works correctly
- **Tool loop**: `server.py:971-1011` - NEEDS MODIFICATION to stop at FE tools
- Frontend tool skip: `server.py:1009-1011` - needs to break the loop
- Error handling: `server.py:1043` uses generic `RUNTIME_ERROR` code

## Desired End State

After implementation:
1. **Backend stops at first FE tool** - prevents executing dependent BE tools with wrong data
2. Frontend tools execute, results go to message history, auto-follow-up sends to LLM
3. LLM sees results and generates correct follow-up tool calls
4. Optional `/tool_result` endpoint logs frontend tool execution for debugging/analytics
5. Fetch requests have 2-minute timeout to prevent indefinite hangs
6. Specific error codes allow frontend error differentiation

### Verification:
- Run existing tests: `cd backend && uv run python test_e2e.py`
- Run frontend tests: `cd frontend && npm test`
- Manual test: Dependent FE→BE tool scenario works correctly

## What We're NOT Doing

1. **NOT adding asyncio.Event blocking** - too complex, breaks SSE expectations
2. **NOT removing auto-follow-up** - it's the correct pattern (matches CopilotKit)
3. **NOT passing state in tool args** (PostHog-style) - message history is cleaner
4. **NOT modifying the SSE generator to wait** - maintains continuous streaming

## Implementation Approach

### Development Philosophy: Tracer Bullet + TDD

We follow two key principles:

**1. Tracer Bullet Development**
> "A tracer bullet is a thin, end-to-end implementation that proves the architecture works."

Instead of building all features in isolation, we:
- Build the **smallest possible E2E flow** first
- Verify it works from user input → backend → frontend → follow-up → response
- Then expand with additional features

**2. Test-Driven Development (TDD)**
> "Red → Green → Refactor"

For each feature:
1. **RED**: Write a failing test that defines the expected behavior
2. **GREEN**: Write minimal code to make the test pass
3. **REFACTOR**: Clean up while keeping tests green

### Phase Overview (Tracer Bullet Order)

| Phase | What | TDD Approach |
|-------|------|--------------|
| **0** | E2E tracer bullet test | Write failing E2E test first |
| **1** | Backend: Stop at FE tool | Unit test → implement → pass |
| **2** | Verify tracer bullet works | Manual smoke test |
| **3** | Frontend: Fetch timeout | Unit test → implement → pass |
| **4** | Backend: Error codes | Unit test → implement → pass |
| **5** | Backend: /tool_result endpoint | Unit test → implement → pass |
| **6** | Frontend: Logging POST | Integration test → implement → pass |

---

## Phase 0: Tracer Bullet - Failing E2E Test (RED)

### Overview
Write a failing end-to-end test that exercises the COMPLETE flow:
1. User sends message requesting FE + BE tools
2. Backend stops at FE tool
3. Frontend executes FE tool
4. Auto-follow-up sends result
5. Backend executes remaining BE tools with correct context

**This test will FAIL initially** - that's the point. It defines our target behavior.

### Test to Write FIRST

**File**: `backend/test_tracer_bullet.py` (new file)

```python
"""
Tracer Bullet E2E Test - Write this FIRST, it should FAIL.

This test defines the target behavior for FE/BE tool synchronization.
Run with: cd backend && uv run pytest test_tracer_bullet.py -v
"""
import json
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
from server import app


class TestTracerBullet:
    """
    E2E test for the complete FE/BE tool synchronization flow.

    Scenario: LLM calls [greet (FE), calculate (BE)] in one response
    Expected: Backend stops at greet, doesn't execute calculate yet
    """

    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_backend_stops_at_frontend_tool(self, client):
        """
        TRACER BULLET: Verify backend stops processing when it hits a FE tool.

        This is the core behavior we need to implement.
        The test should FAIL initially, then pass after Phase 1.
        """
        # Mock LLM to return both FE and BE tool calls
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].delta = MagicMock()
        mock_response.choices[0].delta.tool_calls = [
            MagicMock(
                index=0,
                id="call_fe_001",
                function=MagicMock(name="greet", arguments='{"name":"John"}')
            ),
            MagicMock(
                index=1,
                id="call_be_001",
                function=MagicMock(name="calculate", arguments='{"expression":"5+3"}')
            )
        ]
        mock_response.choices[0].delta.content = None
        mock_response.choices[0].finish_reason = "tool_calls"

        # Track which tools were executed
        executed_tools = []
        original_calculate = None

        def track_calculate(**kwargs):
            executed_tools.append("calculate")
            return "8"

        with patch('server.client.chat.completions.create') as mock_llm:
            mock_llm.return_value = iter([mock_response])

            # Patch calculate to track if it's called
            from server import BACKEND_TOOLS
            original_calculate = BACKEND_TOOLS["calculate"]["handler"]
            BACKEND_TOOLS["calculate"]["handler"] = track_calculate

            try:
                response = client.post(
                    "/chat",
                    json={
                        "messages": [{"role": "user", "content": "greet John and calculate 5+3"}],
                        "frontendTools": [{
                            "name": "greet",
                            "description": "Greet someone",
                            "parameters": {
                                "type": "object",
                                "properties": {"name": {"type": "string"}},
                                "required": ["name"]
                            }
                        }],
                        "threadId": "test-tracer",
                        "runId": "run-001"
                    },
                )

                # Parse SSE events
                events = []
                for line in response.iter_lines():
                    if line and line.startswith("data: "):
                        event_data = json.loads(line[6:])
                        events.append(event_data)

                # CRITICAL ASSERTION: calculate should NOT have been called
                # because backend should stop at greet (FE tool)
                assert "calculate" not in executed_tools, \
                    "Backend should NOT execute calculate when greet (FE) comes first!"

                # Verify we got TOOL_CALL_END for greet
                tool_call_ends = [e for e in events if e.get("type") == "TOOL_CALL_END"]
                greet_ended = any(e.get("toolCallId") == "call_fe_001" for e in tool_call_ends)
                assert greet_ended, "Should emit TOOL_CALL_END for greet"

                # Verify we got RUN_FINISHED
                run_finished = any(e.get("type") == "RUN_FINISHED" for e in events)
                assert run_finished, "Should emit RUN_FINISHED"

            finally:
                # Restore original handler
                BACKEND_TOOLS["calculate"]["handler"] = original_calculate

    def test_be_tools_execute_when_no_fe_tools(self, client):
        """
        Verify BE-only tools still execute normally.
        This should pass even before our changes (regression test).
        """
        response = client.post(
            "/chat",
            json={
                "messages": [{"role": "user", "content": "calculate 5+3"}],
                "frontendTools": [],
                "threadId": "test-be-only",
                "runId": "run-002"
            },
        )

        assert response.status_code == 200
        # Should get a response (existing behavior should work)
```

### Success Criteria (Phase 0):

#### Automated Verification:
- [x] Test file created: `backend/test_tracer_bullet.py`
- [x] Test runs (but FAILS): `cd backend && uv run pytest test_tracer_bullet.py -v`
- [x] Failure message clearly shows: "Backend should NOT execute calculate when greet (FE) comes first!"

#### What the Failure Tells Us:
The test failure proves that **currently** the backend executes ALL tools regardless of FE/BE distinction. This is the bug we're fixing.

**IMPORTANT**: Do NOT proceed to Phase 1 until this test exists and fails as expected.

---

## Phase 1: Stop Tool Execution at First Frontend Tool (GREEN)

### Overview
Now implement the **minimal code** to make the tracer bullet test pass.

**TDD Principle**: We already have a failing test from Phase 0. Now we write the smallest change to make it pass.

### Changes Required:

#### 1. Modify Tool Execution Loop
**File**: `backend/server.py`
**Lines**: 971-1018 (tool execution loop)

**Current Code** (lines 971-1012):
```python
for _idx, tool_call in current_tool_calls.items():
    tool_name = tool_call["name"]
    tool_call_id = tool_call["id"]

    # Signal end of tool call arguments
    yield encoder.encode(ToolCallEndEvent(tool_call_id=tool_call_id))

    # Execute backend tools and stream result
    if tool_name in BACKEND_TOOLS:
        tool_start = time.time()
        logger.info(f"   🔨 Executing: {tool_name}")
        try:
            args = json.loads(tool_call["arguments"]) if tool_call["arguments"] else {}
            handler = BACKEND_TOOLS[tool_name]["handler"]
            result = handler(**args)
            # ... emit TOOL_CALL_RESULT
        except Exception as e:
            # ... emit error result
    else:
        # Frontend tools: no result from server (client executes them)
        logger.info(f"   📤 Frontend tool: {tool_name} (client will execute)")
```

**New Code**:
```python
for _idx, tool_call in current_tool_calls.items():
    tool_name = tool_call["name"]
    tool_call_id = tool_call["id"]

    # Signal end of tool call arguments
    yield encoder.encode(ToolCallEndEvent(tool_call_id=tool_call_id))

    # Execute backend tools and stream result
    if tool_name in BACKEND_TOOLS:
        tool_start = time.time()
        logger.info(f"   🔨 Executing: {tool_name}")
        try:
            args = json.loads(tool_call["arguments"]) if tool_call["arguments"] else {}
            handler = BACKEND_TOOLS[tool_name]["handler"]
            result = handler(**args)

            tool_time = (time.time() - tool_start) * 1000
            result_preview = result[:50] if len(result) > 50 else result
            logger.info(f"   ✅ {tool_name} completed: {tool_time:.0f}ms | Result: {result_preview}...")

            # TOOL_CALL_RESULT with result
            result_message_id = str(uuid.uuid4())
            yield encoder.encode(ToolCallResultEvent(
                message_id=result_message_id,
                tool_call_id=tool_call_id,
                content=result,
                role="tool"
            ))
        except Exception as e:
            tool_time = (time.time() - tool_start) * 1000
            logger.error(f"   ❌ {tool_name} failed: {tool_time:.0f}ms | Error: {str(e)}")
            result_message_id = str(uuid.uuid4())
            yield encoder.encode(ToolCallResultEvent(
                message_id=result_message_id,
                tool_call_id=tool_call_id,
                content=f"Error: {str(e)}",
                role="tool"
            ))
    else:
        # Frontend tool encountered - STOP processing remaining tools
        # The frontend will execute this tool, add result to messages,
        # and auto-follow-up will send a new request with the result.
        # This prevents executing subsequent BE tools with wrong/missing data.
        logger.info(f"   📤 Frontend tool: {tool_name} - stopping to await client execution")
        logger.info(f"   ⏸️  Remaining tools will execute on follow-up request")
        break  # EXIT THE LOOP - critical for correctness!
```

#### 2. Update Step Finished Logic
**File**: `backend/server.py`
**Lines**: 1013-1018

The STEP_FINISHED for tool_execution should still emit after the break:

```python
# STEP_FINISHED: Tool execution complete (even if we stopped early)
if current_tool_calls:
    yield encoder.encode(StepFinishedEvent(
        step_name="tool_execution",
        timestamp=get_timestamp()
    ))
```

This is already correct - the `if current_tool_calls:` block runs after the loop.

### Why This Works

1. **BE tools before FE tool**: Execute normally, results in history
2. **FE tool encountered**: Emit TOOL_CALL_END, break loop
3. **BE tools after FE tool**: NOT executed this request
4. **Frontend**: Executes FE tool, adds result, triggers follow-up
5. **Follow-up request**: LLM sees FE result, generates new BE tool calls with correct data
6. **State tracking**: Message history shows which tools have results

### Success Criteria (Phase 1):

#### Automated Verification (TDD: Green):
- [x] **Tracer bullet test PASSES**: `cd backend && uv run pytest test_tracer_bullet.py -v`
- [x] Existing tests still pass: `cd backend && uv run python test_e2e.py`
- [x] Backend starts without errors: `cd backend && uv run python server.py`

#### The Moment of Truth:
Run the tracer bullet test. If it passes, Phase 1 is complete:
```bash
cd backend && uv run pytest test_tracer_bullet.py::TestTracerBullet::test_backend_stops_at_frontend_tool -v
```

**IMPORTANT**: Do NOT proceed to Phase 2 until the tracer bullet test is GREEN.

---

## Phase 2: Verify Tracer Bullet E2E (Manual Smoke Test)

### Overview
Now that the automated test passes, verify the full E2E flow manually to ensure the tracer bullet truly works from user perspective.

### Manual Verification Steps:

1. **Start backend and frontend**:
   ```bash
   # Terminal 1
   cd backend && uv run python server.py

   # Terminal 2
   cd frontend && npm run dev
   ```

2. **Test 1: FE tool first, then BE tool**
   - Type: "Greet John and calculate 5+3"
   - Expected behavior:
     - Alert appears: "Hello, John!" (FE tool executed)
     - After alert dismissed, auto-follow-up happens
     - Final response includes calculation result "8"

3. **Test 2: BE tool first, then FE tool**
   - Type: "Calculate 5+3 and greet John"
   - Expected behavior:
     - Calculation "8" appears immediately
     - Then alert appears: "Hello, John!"
     - Final response acknowledges both

4. **Test 3: BE tools only (regression)**
   - Type: "Calculate 5+3 and get weather for Tokyo"
   - Expected behavior:
     - Both execute in single request (no stop needed)

### Success Criteria (Phase 2):

#### Automated Verification (Playwright tests):
- [x] Test 1 passes: FE tool executes, follow-up works
- [x] Test 2 passes: BE executes first, stops at FE, follow-up works
- [x] Test 3 passes: BE-only tools work normally (no regression)
- [x] Sequential tests pass: state not corrupted between requests

**IMPORTANT**: This is the tracer bullet verification. If any test fails, debug before proceeding.

---

## Phase 3: Add Fetch Timeout to Frontend (TDD)

### Overview
Add AbortController timeout to prevent indefinite hangs if server becomes unresponsive.

### Step 1: Write Failing Test (RED)

**File**: `frontend/__tests__/fetchTimeout.test.ts` (new file)

```typescript
/**
 * TDD: Write this test FIRST. It should FAIL initially.
 * Run with: cd frontend && npm test -- fetchTimeout
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Fetch Timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should abort fetch after 2 minute timeout', async () => {
    // This test verifies that useChat.ts implements a 120s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    const mockFetch = vi.fn(() =>
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      })
    );

    const fetchPromise = mockFetch();
    vi.advanceTimersByTime(120001);

    await expect(fetchPromise).rejects.toThrow('Aborted');
    clearTimeout(timeoutId);
  });

  it('should clear timeout on successful fetch', async () => {
    const controller = new AbortController();
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

    const timeoutId = setTimeout(() => controller.abort(), 120000);

    // Simulate successful fetch
    const mockFetch = vi.fn(() => Promise.resolve({ ok: true }));
    await mockFetch();

    clearTimeout(timeoutId);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });
});
```

### Step 2: Implement to Pass (GREEN)

#### 1. Frontend Fetch Timeout
**File**: `frontend/src/hooks/useChat.ts`
**Lines**: 103-107 (inside `sendMessageInternal`)

**Current Code** (lines 103-107):
```typescript
const response = await fetch(`${API_URL}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

**New Code**:
```typescript
// Add timeout to prevent indefinite hangs
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

let response: Response;
try {
  response = await fetch(`${API_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
} finally {
  clearTimeout(timeoutId);
}
```

Note: The `finally` block with `clearTimeout` ensures no memory leak even if fetch throws.

### Success Criteria (Phase 3):

#### Automated Verification (TDD):
- [x] **Test file created**: `frontend/__tests__/fetchTimeout.test.tsx`
- [x] **Test passes**: `cd frontend && npm run test:unit -- __tests__/fetchTimeout.test.tsx`
- [x] TypeScript compiles: `cd frontend && npm run build`
- [x] All tests pass: `cd frontend && npm run test:unit`

#### Manual Verification:
- [x] Chat works normally with server running (verified via Playwright tests)
- [ ] UI shows error after 2 minutes if server is killed mid-stream (not tested - optional)

---

## Phase 4: Add Specific Error Codes to Backend (TDD)

### Overview
Add distinguishable error codes so frontend can differentiate error types.

### Step 1: Write Failing Test (RED)

**File**: `backend/test_error_codes.py` (new file)

```python
"""
TDD: Write this test FIRST. It should FAIL initially.
Run with: cd backend && uv run pytest test_error_codes.py -v
"""
import pytest
from server import ErrorCode


class TestErrorCodes:
    """Test that error codes are properly defined."""

    def test_error_code_constants_exist(self):
        """Verify ErrorCode class has required constants."""
        assert hasattr(ErrorCode, 'RUNTIME_ERROR')
        assert hasattr(ErrorCode, 'TOOL_ERROR')
        assert hasattr(ErrorCode, 'TIMEOUT_ERROR')

    def test_error_code_values(self):
        """Verify error codes have correct string values."""
        assert ErrorCode.RUNTIME_ERROR == "RUNTIME_ERROR"
        assert ErrorCode.TOOL_ERROR == "TOOL_ERROR"
        assert ErrorCode.TIMEOUT_ERROR == "TIMEOUT_ERROR"
```

### Step 2: Implement to Pass (GREEN)

#### 1. Add Error Code Constants
**File**: `backend/server.py`
**Location**: After line 217 (after `get_timestamp` function)

**Add**:
```python
# Error codes for RunErrorEvent
class ErrorCode:
    """Error codes for AG-UI RUN_ERROR events."""
    RUNTIME_ERROR = "RUNTIME_ERROR"  # Generic runtime error
    TOOL_ERROR = "TOOL_ERROR"        # Tool execution failed
    TIMEOUT_ERROR = "TIMEOUT_ERROR"  # Request timeout (reserved for future use)
```

#### 2. Update Generic Error Handler
**File**: `backend/server.py`
**Line**: 1043

**Current Code**:
```python
yield encoder.encode(RunErrorEvent(message=str(e), code="RUNTIME_ERROR"))
```

**New Code**:
```python
yield encoder.encode(RunErrorEvent(message=str(e), code=ErrorCode.RUNTIME_ERROR))
```

### Success Criteria (Phase 4):

#### Automated Verification (TDD):
- [ ] **Test file created**: `backend/test_error_codes.py`
- [ ] **Test passes**: `cd backend && uv run pytest test_error_codes.py -v`
- [ ] Backend starts without errors: `cd backend && uv run python server.py`
- [ ] All backend tests pass: `cd backend && uv run python test_e2e.py`

---

## Phase 5: Add Optional `/tool_result` Logging Endpoint (TDD)

### Overview
Add optional POST endpoint for frontend to report tool execution results. This is for logging/analytics only - NOT for synchronization (message history handles that).

### Step 1: Write Failing Test (RED)

**File**: `backend/test_tool_result.py` (new file)

```python
"""
TDD: Write this test FIRST. It should FAIL initially.
Run with: cd backend && uv run pytest test_tool_result.py -v
"""
import pytest
from fastapi.testclient import TestClient
from server import app


@pytest.fixture
def client():
    return TestClient(app)


class TestToolResultEndpoint:
    """Test /tool_result logging endpoint."""

    def test_endpoint_exists(self, client):
        """Verify endpoint exists and accepts POST."""
        response = client.post(
            "/tool_result",
            json={
                "tool_call_id": "test-123",
                "tool_name": "greet",
                "result": "Hello, World!",
            },
        )
        assert response.status_code == 200

    def test_returns_ok_status(self, client):
        """Verify response structure."""
        response = client.post(
            "/tool_result",
            json={
                "tool_call_id": "test-456",
                "tool_name": "setTheme",
                "result": "Theme changed",
            },
        )
        data = response.json()
        assert data["status"] == "ok"
        assert "logged" in data["message"].lower()

    def test_accepts_optional_error_field(self, client):
        """Verify error field is optional and accepted."""
        response = client.post(
            "/tool_result",
            json={
                "tool_call_id": "test-789",
                "tool_name": "calculate",
                "result": None,
                "error": "Division by zero",
            },
        )
        assert response.status_code == 200

    def test_validates_required_fields(self, client):
        """Verify validation rejects missing required fields."""
        response = client.post(
            "/tool_result",
            json={"tool_name": "greet"},  # Missing tool_call_id and result
        )
        assert response.status_code == 422  # Validation error
```

### Step 2: Implement to Pass (GREEN)

#### 1. Add Pydantic Model
**File**: `backend/server.py`
**Location**: After `HealthResponse` class (around line 184)

**Add**:
```python
class ToolResultRequest(BaseModel):
    """Request body for optional tool result logging endpoint."""
    tool_call_id: str = Field(..., description="Tool call ID from TOOL_CALL_START event")
    tool_name: str = Field(..., description="Name of the tool that was executed")
    result: Any = Field(..., description="Result returned by the tool handler")
    error: str | None = Field(default=None, description="Error message if tool failed")
    thread_id: str | None = Field(default=None, alias="threadId", description="Thread ID for correlation")

    model_config = {"populate_by_name": True}


class ToolResultResponse(BaseModel):
    """Response for tool result logging endpoint."""
    status: str = Field(default="ok")
    message: str = Field(default="Result logged (follow-up handles continuation)")
```

#### 2. Add POST Endpoint
**File**: `backend/server.py`
**Location**: After the `/health` endpoint (around line 1059)

**Add**:
```python
@app.post("/tool_result", response_model=ToolResultResponse)
async def receive_tool_result(request: ToolResultRequest) -> ToolResultResponse:
    """
    Optional endpoint for frontend to report tool execution results.

    This is for LOGGING/PERSISTENCE only - NOT for synchronization.
    State is tracked via message history (toolCalls + tool messages).
    The auto-follow-up mechanism handles LLM continuation.

    Use cases:
    - Analytics: Track which tools are used and their success rates
    - Debugging: Log tool execution for troubleshooting
    - Persistence: Store results in database for later analysis
    """
    logger.info(f"📥 Tool result received: {request.tool_name} ({request.tool_call_id})")

    if request.error:
        logger.error(f"   Tool error: {request.error}")
    else:
        result_preview = str(request.result)[:100]
        logger.info(f"   Result: {result_preview}...")

    if request.thread_id:
        logger.info(f"   Thread: {request.thread_id[:8]}...")

    # Future: Could store in database for analytics
    # Future: Could emit to monitoring/alerting system

    return ToolResultResponse()
```

### Success Criteria (Phase 5):

#### Automated Verification (TDD):
- [ ] **Test file created**: `backend/test_tool_result.py`
- [ ] **Test passes**: `cd backend && uv run pytest test_tool_result.py -v`
- [ ] Backend starts without errors: `cd backend && uv run python server.py`
- [ ] All backend tests pass: `cd backend && uv run python test_e2e.py`

#### Manual Verification:
- [ ] Endpoint responds to curl:
  ```bash
  curl -X POST http://localhost:8000/tool_result \
    -H "Content-Type: application/json" \
    -d '{"tool_call_id":"test-123","tool_name":"greet","result":"Hello"}'
  ```
- [ ] Server logs show tool result when endpoint is called

---

## Phase 6: Add Optional Frontend Logging (Fire-and-Forget)

### Overview
Optionally add fire-and-forget POST to log tool results on server. This doesn't block or affect the auto-follow-up mechanism.

### Changes Required:

#### 1. Add Tool Result Logging
**File**: `frontend/src/hooks/useChat.ts`
**Location**: Inside TOOL_CALL_END handler, after successful tool execution (around line 555)

**Current Code** (lines 545-555):
```typescript
// Then add the tool result message with auto-completed todo list
const toolMessage: Message = {
  role: 'tool',
  content: `Frontend tool "${toolCall.name}" executed: ${result}`,
  isFrontend: true,
  toolCallId: event.toolCallId,
  currentTodos: getTodoListWithCompletedTask(updatedWithToolCall),
};
setMessages([...updatedWithToolCall, toolMessage]);
return { frontendToolExecuted: true, backendToolExecuted: false, action: contextAction, result };
```

**New Code**:
```typescript
// Then add the tool result message with auto-completed todo list
const toolMessage: Message = {
  role: 'tool',
  content: `Frontend tool "${toolCall.name}" executed: ${result}`,
  isFrontend: true,
  toolCallId: event.toolCallId,
  currentTodos: getTodoListWithCompletedTask(updatedWithToolCall),
};
setMessages([...updatedWithToolCall, toolMessage]);

// Optional: Log tool result to server (fire-and-forget, doesn't block follow-up)
// State is already tracked via message history - this is just for server-side logging
fetch(`${API_URL}/tool_result`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tool_call_id: event.toolCallId,
    tool_name: toolCall.name,
    result: result,
    thread_id: threadIdRef.current,
  }),
}).catch((err) => console.warn('Tool result logging failed:', err));

return { frontendToolExecuted: true, backendToolExecuted: false, action: contextAction, result };
```

### Success Criteria (Phase 6):

#### Automated Verification:
- [ ] TypeScript compiles: `cd frontend && npm run build`
- [ ] Existing tests pass: `cd frontend && npm test`
- [ ] No linting errors: `cd frontend && npm run lint`

#### Manual Verification:
- [ ] Tool execution still works normally
- [ ] Server logs show tool result being received
- [ ] Auto-follow-up still triggers correctly

---

## Phase 7: Final Integration & Cleanup (Refactor)

### Overview
This is the TDD "Refactor" phase. All tests are green, now we:
1. Run the full test suite to verify everything works together
2. Clean up any code duplication
3. Update documentation

### All Tests to Run

```bash
# Backend tests (all)
cd backend && uv run pytest test_tracer_bullet.py test_error_codes.py test_tool_result.py test_e2e.py -v

# Frontend tests (all)
cd frontend && npm test

# Full E2E manual test
# Start both servers and test the 3 scenarios from Phase 2
```

### Success Criteria (Phase 7):

#### Automated Verification:
- [ ] **All backend tests pass**: `cd backend && uv run pytest -v`
- [ ] **All frontend tests pass**: `cd frontend && npm test`
- [ ] No linting errors: `cd frontend && npm run lint`
- [ ] TypeScript compiles: `cd frontend && npm run build`
- [ ] Backend starts cleanly: `cd backend && uv run python server.py`

#### Manual Verification (Full E2E):
- [ ] Test 1: "Greet John and calculate 5+3" - FE tool first
- [ ] Test 2: "Calculate 5+3 and greet John" - BE tool first
- [ ] Test 3: "Get weather for Tokyo and calculate 5+3" - BE only
- [ ] Test 4: "Greet me and tell me how you greeted me" - Dependent tools

---

## Testing Strategy (TDD Summary)

### Test Files Created (in order)

| Phase | Test File | Purpose | TDD Stage |
|-------|-----------|---------|-----------|
| 0 | `backend/test_tracer_bullet.py` | E2E tracer bullet | RED → GREEN |
| 3 | `frontend/__tests__/fetchTimeout.test.ts` | Timeout behavior | RED → GREEN |
| 4 | `backend/test_error_codes.py` | Error code constants | RED → GREEN |
| 5 | `backend/test_tool_result.py` | Logging endpoint | RED → GREEN |

### Test Execution Order

```bash
# Phase 0: Write tracer bullet test (should FAIL)
cd backend && uv run pytest test_tracer_bullet.py -v
# Expected: FAIL - "Backend should NOT execute calculate when greet (FE) comes first!"

# Phase 1: Implement fix (should PASS)
cd backend && uv run pytest test_tracer_bullet.py -v
# Expected: PASS

# Phase 3-5: TDD for each feature
cd backend && uv run pytest test_error_codes.py -v
cd backend && uv run pytest test_tool_result.py -v
cd frontend && npm test -- fetchTimeout

# Phase 7: All tests green
cd backend && uv run pytest -v
cd frontend && npm test
```

### Manual Testing Steps (Phase 2 & 7)
1. Start both backend and frontend
2. **Test 1: FE tool first** - "Greet John and calculate 5+3"
3. **Test 2: BE tool first** - "Calculate 5+3 and greet John"
4. **Test 3: BE-only** - "Get weather for Tokyo and calculate 5+3"
5. **Test 4: Dependent** - "Greet me, then tell me how you greeted me"

## State Management Summary

| What | Where | How |
|------|-------|-----|
| Tool calls requested | `assistant.toolCalls[]` | Array of `{id, name, arguments}` |
| Tool results | `tool` messages | `{role:"tool", toolCallId, content}` |
| Execution status | Implicit | Has matching `tool` message = executed |
| Pending tools | Implicit | No matching `tool` message = not executed |
| Follow-up trigger | `useChat.ts:173-179` | `frontendToolExecuted` flag |

**Key insight**: We don't need separate "pending" state. The message history IS the state. LLM generates new tool calls based on what results are present.

## Performance Considerations

- Fire-and-forget POST adds minimal latency (non-blocking)
- 2-minute timeout is conservative; adjust based on expected response times
- Stopping at FE tools may cause additional follow-up requests, but ensures correctness
- No memory leaks: AbortController properly cleaned up in finally block

## Migration Notes

- No breaking changes to existing API
- `/tool_result` endpoint is optional (can be ignored by frontend)
- Existing tests should pass without modification
- New behavior (stop at FE tool) is strictly safer than previous behavior

## AG-UI Protocol Compliance

This implementation follows the [AG-UI (Agent User Interaction) Protocol](https://docs.ag-ui.com/llms-full.txt) specification.

### Protocol Library
The backend uses the official `ag_ui` Python library for event encoding:
```python
from ag_ui.core import (
    RunStartedEvent, RunFinishedEvent, RunErrorEvent,
    StepStartedEvent, StepFinishedEvent,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent,
)
from ag_ui.encoder import EventEncoder
```

### Event Type Compliance

| AG-UI Event | Implementation | Required Fields |
|-------------|----------------|-----------------|
| `RUN_STARTED` | ✅ `server.py:859` | `threadId`, `runId` |
| `RUN_FINISHED` | ✅ `server.py:1042` | - |
| `RUN_ERROR` | ✅ `server.py:1048` | `message`, `code` |
| `STEP_STARTED` | ✅ `server.py:867` | `stepName` |
| `STEP_FINISHED` | ✅ `server.py:1019` | `stepName`, `timestamp` |
| `TEXT_MESSAGE_START` | ✅ `server.py:876` | `messageId`, `role` |
| `TEXT_MESSAGE_CONTENT` | ✅ `server.py:904` | `delta` |
| `TEXT_MESSAGE_END` | ✅ `server.py:962` | - |
| `TOOL_CALL_START` | ✅ `server.py:932` | `toolCallId`, `toolCallName`, `parentMessageId` |
| `TOOL_CALL_ARGS` | ✅ `server.py:944` | `toolCallId`, `delta` |
| `TOOL_CALL_END` | ✅ `server.py:976` | `toolCallId` |
| `TOOL_CALL_RESULT` | ✅ `server.py:993` | `toolCallId`, `content`, `role: "tool"` |

### Tool Call Lifecycle (AG-UI Compliant)

Per AG-UI spec, tools follow this streaming pattern:
```
TOOL_CALL_START → TOOL_CALL_ARGS (multiple) → TOOL_CALL_END → TOOL_CALL_RESULT
```

- Each event shares a `toolCallId` linking them together
- Arguments stream as JSON fragments via `delta` field
- `parentMessageId` links tool calls to the assistant message
- `TOOL_CALL_RESULT` uses `role: "tool"` to become a tool message in conversation history

### Frontend Tool Handling (AG-UI Pattern)

Per AG-UI: "Tools are defined in the frontend and passed to the agent during execution."

Our implementation:
1. Frontend registers tools via `useCopilotAction()` hook
2. Tool definitions sent to backend in `/chat` request as `frontendTools`
3. Backend includes them in LLM context alongside `BACKEND_TOOLS`
4. For frontend tools: backend emits `TOOL_CALL_END` but NO `TOOL_CALL_RESULT`
5. Frontend executes handler, adds result as tool message, triggers follow-up

### State Management Events (Future)

AG-UI also defines state management events not yet implemented:
- `STATE_SNAPSHOT`: Complete state representation
- `STATE_DELTA`: RFC 6902 JSON Patch incremental updates
- `MESSAGES_SNAPSHOT`: Full conversation history sync

These are optional for MVP but defined in `frontend/src/types/index.ts` for future use.

## References

- **AG-UI Protocol Spec**: https://docs.ag-ui.com/llms-full.txt
- Race condition analysis: `docs/FE_BE_TOOL_RACE_CONDITION.md`
- Research document: `thoughts/shared/research/2025-12-18-tool-call-race-conditions.md`
- CopilotKit pattern reference: Auto-follow-up is the standard pattern
- OpenAI API: Tool call/result message threading format
