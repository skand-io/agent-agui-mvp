# LangChain Sequential Tool Calling with Frontend/Backend Coordination

**Date**: 2026-01-03
**Goal**: Implement sequential tool calling using LangChain/LangGraph such that the system waits for frontend tool execution before proceeding to backend tools.

## Overview

When the user says "greet Kevin and get the weather for Tokyo", the system should:
1. LLM calls frontend tool `greet(name="Kevin")`
2. **System PAUSES and waits for frontend to execute the tool**
3. Frontend shows alert "Hello Kevin!" and returns result
4. LLM receives the result and continues
5. LLM calls backend tool `get_weather(city="Tokyo")`
6. Backend executes and returns weather
7. LLM summarizes results

## Current State Analysis

### Current Architecture (`backend/server.py`)
- Uses raw OpenAI SDK with OpenRouter
- Single request-response cycle
- When frontend tools are detected, backend `break`s out of the tool loop (line 1120)
- Frontend executes tools after stream ends
- **Problem**: No way to pause mid-stream and wait for frontend result

### Current Frontend (`frontend/src/hooks/useChat.ts`)
- Processes AG-UI events
- Executes frontend tools on `TOOL_CALL_END` event
- Has auto-follow-up mechanism after tool execution
- **Problem**: Follow-up sends new request, but LLM doesn't continue from where it left off

### Why Current Approach Doesn't Work
1. LLM generates ALL tool calls at once (greet + get_weather)
2. Backend streams ALL tool call events
3. Backend breaks at first frontend tool, but damage is done
4. The LLM already decided to call get_weather in the SAME response
5. No mechanism to pause mid-generation

## Desired End State

```
User: "greet Kevin and get the weather for Tokyo"

[First LLM call]
LLM: "I'll help you with that."
LLM: calls greet(name="Kevin")  ← First tool only

[System pauses - waits for frontend]
Frontend: shows alert, returns "Greeted Kevin"

[Second LLM call - with greet result in context]
LLM: sees greet result
LLM: calls get_weather(city="Tokyo")  ← Second tool only

[Backend executes]
Backend: returns "Weather: 22°C"

[Third LLM call - optional summarization]
LLM: "I greeted Kevin and the weather in Tokyo is 22°C"
```

## Implementation Approaches

### Approach 1: LangGraph with `interrupt()` (Recommended)

Use LangGraph's `interrupt()` function to pause execution and wait for frontend tool results.

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│                     LangGraph Agent                          │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐    ┌─────────────┐    ┌──────────────────┐   │
│  │  Agent   │───►│  Router     │───►│ Backend Tools    │   │
│  │  (LLM)   │    │  (should_   │    │ (get_weather)    │   │
│  └──────────┘    │  continue)  │    └──────────────────┘   │
│       ▲          └─────────────┘           │                │
│       │                 │                  │                │
│       │                 ▼                  │                │
│       │          ┌─────────────┐          │                │
│       │          │ Frontend    │          │                │
│       │          │ Tool Node   │          │                │
│       │          │ (interrupt) │          │                │
│       │          └─────────────┘          │                │
│       │                 │                  │                │
│       └─────────────────┴──────────────────┘                │
└─────────────────────────────────────────────────────────────┘

[Request 1: Initial message]
Client ──────────────────────────────► LangGraph
                                       │
                                       ▼
                                    Agent decides to call greet()
                                       │
                                       ▼
                                    Frontend Tool Node
                                       │
                                       ▼
                                    interrupt({tool_call_id, tool_name, args})
                                       │
                                       ▼
                                    Stream pauses, returns to client

[Client executes frontend tool]
alert("Hello Kevin!")

[Request 2: Resume with result]
Client ──Command(resume="Greeted Kevin")─► LangGraph
                                       │
                                       ▼
                                    Frontend Tool Node receives result
                                       │
                                       ▼
                                    Returns ToolMessage to Agent
                                       │
                                       ▼
                                    Agent decides to call get_weather()
                                       │
                                       ▼
                                    Backend Tool Node (no interrupt)
                                       │
                                       ▼
                                    Returns weather result to Agent
                                       │
                                       ▼
                                    Agent generates final response
                                       │
                                       ▼
                                    Stream completes
```

**Key Code Pattern:**
```python
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import StateGraph, START, END
from langchain_core.messages import ToolMessage

class AgentState(TypedDict):
    messages: Annotated[list, add_messages]

FRONTEND_TOOLS = {"greet"}
BACKEND_TOOLS = {"get_weather"}

def frontend_tool_node(state: AgentState):
    """Pause and wait for frontend to execute the tool."""
    last_message = state["messages"][-1]
    tool_call = last_message.tool_calls[0]

    # Interrupt execution - client will resume with result
    result = interrupt({
        "type": "frontend_tool",
        "tool_call_id": tool_call["id"],
        "tool_name": tool_call["name"],
        "args": tool_call["args"]
    })

    # When resumed, `result` contains the frontend's response
    return {
        "messages": [
            ToolMessage(content=result, tool_call_id=tool_call["id"])
        ]
    }

def backend_tool_node(state: AgentState):
    """Execute backend tools immediately."""
    # ... execute and return result
    pass

def route_tools(state: AgentState):
    """Route to appropriate tool handler."""
    last_message = state["messages"][-1]
    if not last_message.tool_calls:
        return "end"

    tool_name = last_message.tool_calls[0]["name"]
    if tool_name in FRONTEND_TOOLS:
        return "frontend_handler"
    return "backend_handler"

# Build graph
workflow = StateGraph(AgentState)
workflow.add_node("agent", call_model)
workflow.add_node("frontend_handler", frontend_tool_node)
workflow.add_node("backend_handler", backend_tool_node)

workflow.add_edge(START, "agent")
workflow.add_conditional_edges("agent", route_tools, {
    "frontend_handler": "frontend_handler",
    "backend_handler": "backend_handler",
    "end": END
})
workflow.add_edge("frontend_handler", "agent")  # Loop back
workflow.add_edge("backend_handler", "agent")   # Loop back

# CRITICAL: Checkpointer is required for interrupt to work
memory = InMemorySaver()
graph = workflow.compile(checkpointer=memory)
```

**Client Resumption:**
```python
# First request - runs until interrupt
config = {"configurable": {"thread_id": "session-1"}}
events = graph.stream({"messages": [("user", "greet Kevin and get weather")]}, config)

# Client receives interrupt event, executes frontend tool
# ...

# Resume with frontend result
events = graph.stream(Command(resume="Greeted Kevin successfully"), config)
```

### Approach 2: Tool Ordering via Prompt Engineering

Force the LLM to call tools one at a time via system prompt.

**System Prompt:**
```
You have access to frontend and backend tools.

IMPORTANT: You can only call ONE tool at a time. After calling a frontend tool,
you MUST wait for the result before calling any other tools.

Frontend tools (require user interaction):
- greet: Shows a greeting to the user

Backend tools (execute on server):
- get_weather: Gets weather for a city

When handling multi-step tasks:
1. Call ONE tool
2. Wait for result
3. Decide if more tools are needed
4. Call next tool if needed
```

**Pros:**
- Simple to implement
- Works with current architecture
- No LangGraph dependency

**Cons:**
- Relies on LLM following instructions (unreliable)
- More LLM calls = higher latency/cost
- Doesn't scale to complex tool chains

### Approach 3: CopilotKit's `emit_tool_calls` Pattern

CopilotKit uses a special config to "emit" frontend tool calls without executing them.

**From Reference Code (`coagents-wait-user-input/agent/weather_agent/agent.py:69-72`):**
```python
config = copilotkit_customize_config(
    config,
    emit_tool_calls="AskHuman",  # Tool names to emit, not execute
)
response = model.invoke(messages, config=config)
```

**How it works:**
1. LLM calls `AskHuman` tool
2. CopilotKit intercepts and streams tool call event
3. Graph transitions to `ask_human` node (empty)
4. `interrupt_after=["ask_human"]` pauses execution
5. Client receives tool call, executes, sends result
6. New request resumes graph with human response

**Pattern in Current Code:**
```python
# From coagents-wait-user-input:
graph = workflow.compile(
    checkpointer=memory,
    interrupt_after=["ask_human"]  # Pause AFTER this node
)
```

## Recommended Approach: LangGraph with `interrupt()`

### Why LangGraph?
1. **Built-in checkpointing**: State persists between requests
2. **Native interrupt/resume**: First-class support for human-in-the-loop
3. **Graph-based routing**: Clean separation of frontend vs backend tool handling
4. **Streaming support**: Works with SSE/AG-UI protocol
5. **Industry standard**: CopilotKit, LangServe use this pattern

### Implementation Plan

## Phase 1: Add LangGraph Dependency

### Changes Required:

#### 1. Update `pyproject.toml`
```toml
[project]
dependencies = [
    # Existing deps...
    "langgraph>=0.2.50",
    "langchain>=0.3.0",
    "langchain-openai>=0.2.0",  # Or langchain-community for OpenRouter
]
```

### Success Criteria:
- [x] `uv sync` installs LangGraph dependencies
- [x] Python imports work: `from langgraph.graph import StateGraph`

---

## Phase 2: Create LangGraph-Based Backend

### File: `backend_v2/server_langgraph.py`

**Structure:**
```python
"""
LangGraph-based AG-UI Backend with Sequential Tool Calling
"""
from __future__ import annotations

import json
import os
import uuid
from typing import Annotated, TypedDict, Literal
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import InMemorySaver

from ag_ui.core import (
    RunStartedEvent, RunFinishedEvent,
    TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent,
    ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent,
    StateSnapshotEvent, StateDeltaEvent,
    CustomEvent,
)
from ag_ui.encoder import EventEncoder

# ============= STATE =============
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

# ============= TOOLS =============
FRONTEND_TOOLS = {"greet"}

def get_weather(city: str) -> str:
    """Backend tool - get weather for a city."""
    # Real implementation would call weather API
    return f"Weather in {city}: 22°C, Sunny"

BACKEND_TOOL_HANDLERS = {
    "get_weather": get_weather,
}

# Tool definitions for LLM
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "greet",
            "description": "Greet a person by name (shows browser alert)",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}},
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    },
]

# ============= MODEL =============
# Using ChatOpenAI with OpenRouter base URL
model = ChatOpenAI(
    model="amazon/nova-2-lite-v1:free",
    openai_api_base="https://openrouter.ai/api/v1",
    openai_api_key=os.getenv("OPENROUTER_API_KEY"),
).bind_tools(TOOLS)

# ============= NODES =============
def call_model(state: AgentState) -> dict:
    """LLM agent node."""
    response = model.invoke(state["messages"])
    return {"messages": [response]}

def route_tools(state: AgentState) -> Literal["frontend_handler", "backend_handler", "end"]:
    """Route based on tool type."""
    last_message = state["messages"][-1]

    if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
        return "end"

    # Get FIRST tool call only (sequential execution)
    tool_call = last_message.tool_calls[0]
    tool_name = tool_call["name"]

    if tool_name in FRONTEND_TOOLS:
        return "frontend_handler"
    return "backend_handler"

def frontend_handler(state: AgentState) -> dict:
    """Pause for frontend tool execution using interrupt()."""
    last_message = state["messages"][-1]
    tool_call = last_message.tool_calls[0]

    # INTERRUPT: Pause execution and wait for frontend
    # The value we pass here is sent to the client
    frontend_result = interrupt({
        "type": "frontend_tool_call",
        "tool_call_id": tool_call["id"],
        "tool_name": tool_call["name"],
        "args": tool_call["args"],
    })

    # When resumed with Command(resume="..."), frontend_result contains that value
    return {
        "messages": [
            ToolMessage(
                content=str(frontend_result),
                tool_call_id=tool_call["id"],
            )
        ]
    }

def backend_handler(state: AgentState) -> dict:
    """Execute backend tools immediately."""
    last_message = state["messages"][-1]
    results = []

    for tool_call in last_message.tool_calls:
        tool_name = tool_call["name"]
        if tool_name in FRONTEND_TOOLS:
            continue  # Skip frontend tools (shouldn't happen, but defensive)

        handler = BACKEND_TOOL_HANDLERS.get(tool_name)
        if handler:
            result = handler(**tool_call["args"])
            results.append(
                ToolMessage(content=result, tool_call_id=tool_call["id"])
            )

    return {"messages": results}

# ============= GRAPH =============
workflow = StateGraph(AgentState)

workflow.add_node("agent", call_model)
workflow.add_node("frontend_handler", frontend_handler)
workflow.add_node("backend_handler", backend_handler)

workflow.add_edge(START, "agent")
workflow.add_conditional_edges("agent", route_tools, {
    "frontend_handler": "frontend_handler",
    "backend_handler": "backend_handler",
    "end": END,
})
workflow.add_edge("frontend_handler", "agent")  # Loop back after frontend result
workflow.add_edge("backend_handler", "agent")   # Loop back after backend result

# CRITICAL: Checkpointer required for interrupt() to work
memory = InMemorySaver()
graph = workflow.compile(checkpointer=memory)

# ============= FASTAPI =============
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

encoder = EventEncoder()

class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None
    resume_value: str | None = None  # Value to resume with after frontend tool

@app.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    thread_id = request.thread_id or str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    async def generate() -> AsyncGenerator[str, None]:
        run_id = str(uuid.uuid4())

        yield encoder.encode(RunStartedEvent(thread_id=thread_id, run_id=run_id))
        yield encoder.encode(StateSnapshotEvent(snapshot={"tool_logs": []}))

        try:
            # Determine input
            if request.resume_value:
                # Resuming after frontend tool
                input_data = Command(resume=request.resume_value)
            else:
                # New message
                input_data = {"messages": [HumanMessage(content=request.message)]}

            # Stream graph execution
            message_id = str(uuid.uuid4())
            current_tool_idx = 0

            for event in graph.stream(input_data, config, stream_mode="updates"):
                node_name = list(event.keys())[0]
                node_output = event[node_name]

                if node_name == "agent":
                    # Agent produced a message
                    for msg in node_output.get("messages", []):
                        if isinstance(msg, AIMessage):
                            # Stream text content
                            if msg.content:
                                yield encoder.encode(
                                    TextMessageStartEvent(message_id=message_id, role="assistant")
                                )
                                for chunk in msg.content:
                                    yield encoder.encode(
                                        TextMessageContentEvent(message_id=message_id, delta=chunk)
                                    )
                                yield encoder.encode(TextMessageEndEvent(message_id=message_id))

                            # Stream tool calls
                            for tc in msg.tool_calls or []:
                                yield encoder.encode(
                                    ToolCallStartEvent(
                                        tool_call_id=tc["id"],
                                        tool_call_name=tc["name"],
                                        parent_message_id=message_id,
                                    )
                                )
                                yield encoder.encode(
                                    ToolCallArgsEvent(
                                        tool_call_id=tc["id"],
                                        delta=json.dumps(tc["args"]),
                                    )
                                )
                                yield encoder.encode(ToolCallEndEvent(tool_call_id=tc["id"]))

                                # Add to tool_logs
                                yield encoder.encode(
                                    StateDeltaEvent(delta=[{
                                        "op": "add",
                                        "path": "/tool_logs/-",
                                        "value": {
                                            "id": tc["id"],
                                            "message": f"Calling {tc['name']}...",
                                            "status": "processing",
                                        },
                                    }])
                                )
                                current_tool_idx += 1

                elif node_name == "frontend_handler":
                    # Frontend tool needs execution - graph will be interrupted
                    # The interrupt event will cause stream to end
                    pass

                elif node_name == "backend_handler":
                    # Backend tool results
                    for msg in node_output.get("messages", []):
                        if isinstance(msg, ToolMessage):
                            yield encoder.encode(
                                ToolCallResultEvent(
                                    message_id=str(uuid.uuid4()),
                                    tool_call_id=msg.tool_call_id,
                                    content=msg.content,
                                    role="tool",
                                )
                            )

            yield encoder.encode(RunFinishedEvent(thread_id=thread_id, run_id=run_id))

        except Exception as e:
            yield encoder.encode(CustomEvent(name="error", value={"message": str(e)}))

    return StreamingResponse(generate(), media_type="text/event-stream")

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
```

### Success Criteria:
- [x] Server starts without errors
- [x] Health check returns 200
- [x] Graph compiles with checkpointer

---

## Phase 3: Handle Graph Interruption in AG-UI Events

When `interrupt()` is called in LangGraph, it raises a `GraphInterrupt` exception that ends the stream. We need to:

1. Detect when an interrupt occurred
2. Send a special AG-UI event to tell client "frontend tool needed"
3. Include the interrupt value (tool call details) in the event

### Changes to `server_langgraph.py`:

```python
from langgraph.errors import GraphInterrupt

@app.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    # ...

    async def generate():
        try:
            for event in graph.stream(input_data, config, stream_mode="updates"):
                # Process events...
                pass

        except GraphInterrupt as interrupt:
            # Graph was interrupted - frontend tool needs execution
            # interrupt.value contains what we passed to interrupt()
            interrupt_data = interrupt.value

            yield encoder.encode(
                CustomEvent(
                    name="frontend_tool_required",
                    value=interrupt_data,
                )
            )

            # Send a special "AWAITING_FRONTEND" state
            yield encoder.encode(
                StateDeltaEvent(delta=[{
                    "op": "add",
                    "path": "/awaiting_frontend",
                    "value": {
                        "tool_call_id": interrupt_data["tool_call_id"],
                        "tool_name": interrupt_data["tool_name"],
                        "args": interrupt_data["args"],
                    },
                }])
            )

            # Do NOT send RUN_FINISHED - the run is paused, not complete
            yield encoder.encode(
                CustomEvent(name="run_paused", value={"reason": "awaiting_frontend_tool"})
            )
```

### Success Criteria:
- [x] GraphInterrupt is caught (using `__interrupt__` node in stream_mode="updates")
- [x] `frontend_tool_required` event is sent with tool details
- [x] Client can parse the interrupt event

---

## Phase 4: Frontend Handles Interrupt and Resumes

### Changes to `frontend/src/hooks/useChat.ts`:

```typescript
// New state for tracking interrupted runs
const [pendingFrontendTool, setPendingFrontendTool] = useState<{
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  threadId: string;
} | null>(null);

// Handle CUSTOM events for frontend_tool_required
case EventType.CUSTOM:
  if (event.name === "frontend_tool_required") {
    const { tool_call_id, tool_name, args } = event.value;

    // Execute frontend tool
    const result = await executeFrontendTool(tool_name, args);

    // Resume the graph with the result
    await resumeWithResult(threadId, result);
  }
  break;

// Function to resume graph after frontend tool
async function resumeWithResult(threadId: string, result: string) {
  const response = await fetch(`${API_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      thread_id: threadId,
      resume_value: result,  // This triggers Command(resume=...)
    }),
  });

  // Process the resumed stream
  await processStream(response);
}
```

### Success Criteria:
- [x] Frontend detects `frontend_tool_required` event
- [x] Frontend executes tool (shows alert)
- [x] Frontend sends resume request with result
- [x] Graph continues from where it paused
- [x] Backend tool (get_weather) executes after resume

---

## Phase 5: End-to-End Test

### Test Scenario:
```
User: "greet Kevin and get the weather for Tokyo"

Expected Flow:
1. [Request 1] User message → LangGraph
2. LLM calls greet(name="Kevin")
3. Graph hits interrupt() in frontend_handler
4. [Response 1] Stream ends with frontend_tool_required event
5. Frontend shows alert "Hello Kevin!"
6. [Request 2] Resume with result → LangGraph
7. Graph continues, LLM sees greet result
8. LLM calls get_weather(city="Tokyo")
9. backend_handler executes, returns weather
10. LLM generates final response
11. [Response 2] Complete stream with all results
```

### Playwright Test:
```typescript
test('sequential tool calling: frontend then backend', async ({ page }) => {
  await page.goto('/');

  // Handle alert dialog
  let alertShown = false;
  page.on('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Kevin');
    alertShown = true;
    await dialog.accept();
  });

  // Send message
  await page.fill('[data-testid="message-input"]', 'greet Kevin and get the weather for Tokyo');
  await page.click('[data-testid="send-button"]');

  // Wait for completion
  await expect(page.getByTestId('message-input')).toBeEnabled({ timeout: 30000 });

  // Verify alert was shown (frontend tool executed)
  expect(alertShown).toBe(true);

  // Verify weather result (backend tool executed)
  await expect(page.locator('text=Weather')).toBeVisible();
  await expect(page.locator('text=Tokyo')).toBeVisible();

  // Verify sequential execution (greet before weather)
  const messages = await page.$$('[data-testid^="message-"]');
  // Check order of tool results...
});
```

### Success Criteria:
- [x] Test passes (3/3 tests pass)
- [x] Alert shown BEFORE weather fetch (verified: "greet before weather")
- [x] Both tool results visible in UI (weather response found in messages)
- [x] No race conditions (interrupt/resume flow works correctly)

---

## What We're NOT Doing

- ❌ Persistent database checkpointing (using in-memory for simplicity)
- ❌ Multiple concurrent frontend tools (sequential only)
- ❌ Complex error recovery/retry logic
- ❌ Production-ready threading/sessions
- ❌ WebSocket streaming (using SSE)

## File Structure

```
backend_v2/
├── server_langgraph.py   # New LangGraph-based server
├── server.py             # Keep existing for comparison
└── pyproject.toml        # Add langgraph deps

frontend_v2/
└── src/
    └── useChat.ts        # Update to handle interrupt/resume
```

## Performance Considerations

- **Latency**: Each interrupt = 1 round trip. "greet + weather" = 2 requests instead of 1
- **State size**: InMemorySaver stores full message history per thread
- **Concurrency**: Single-threaded graph execution per thread_id

## Migration Notes

This is additive - the existing `server.py` can coexist with `server_langgraph.py` on different ports for comparison.

## References

### LangGraph Documentation
- [Human-in-the-loop with interrupt](https://langchain-ai.github.io/langgraph/how-tos/human_in_the_loop/wait-user-input/)
- [Command and interrupt blog post](https://blog.langchain.com/making-it-easier-to-build-human-in-the-loop-agents-with-interrupt/)
- [ReAct Agent from scratch](https://langchain-ai.github.io/langgraph/how-tos/react-agent-from-scratch/)

### Reference Implementations
- CopilotKit wait-user-input: `reference_code/CopilotKit-main/examples/coagents-wait-user-input/`
- AG-UI Demo: `reference_code/open-ag-ui-demo-langgraph-main/`

### Existing Code
- Current backend: `backend/server.py`
- Current frontend hook: `frontend/src/hooks/useChat.ts`
