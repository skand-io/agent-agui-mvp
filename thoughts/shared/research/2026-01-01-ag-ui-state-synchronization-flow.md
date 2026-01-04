---
date: 2026-01-01T05:11:24Z
researcher: Claude
git_commit: 7f384a21ecdb0748221348667ceed2adb95abee1
branch: feat/revert-to-minimal
repository: minimal-chat
topic: "AG-UI State Synchronization and Tool Call Tracking: Implementation Without CopilotKit"
tags: [research, codebase, ag-ui, copilotkit, state-management, tool-call-tracking, langgraph]
status: complete
last_updated: 2026-01-01
last_updated_by: Claude
last_updated_note: "Added comprehensive AG-UI event state diagram and complete event type reference"
---

# Research: AG-UI State Synchronization and Tool Call Tracking Flow

**Date**: 2026-01-01T05:11:24Z
**Researcher**: Claude
**Git Commit**: 7f384a21ecdb0748221348667ceed2adb95abee1
**Branch**: feat/revert-to-minimal
**Repository**: minimal-chat

## Research Question

How does the AG-UI demo frontend update agent state to the backend, and how are tool calls tracked? The goal is to understand the call stack through CopilotKit's react-core package to implement state updates and tool call tracking without using CopilotKit.

## Complete AG-UI Event Types

The AG-UI protocol defines **21 distinct event types** in `ag-ui-main/sdks/python/ag_ui/core/events.py:16-45`:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                        AG-UI EVENT TYPES (21 Total)                                      │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  RUN LIFECYCLE (5 events)           │  TEXT MESSAGE (4 events)                          │
│  ├── RUN_STARTED                    │  ├── TEXT_MESSAGE_START                           │
│  ├── RUN_FINISHED                   │  ├── TEXT_MESSAGE_CONTENT                         │
│  ├── RUN_ERROR                      │  ├── TEXT_MESSAGE_END                             │
│  ├── STEP_STARTED                   │  └── TEXT_MESSAGE_CHUNK                           │
│  └── STEP_FINISHED                  │                                                   │
│                                     │  THINKING (5 events)                              │
│  TOOL CALL (5 events)               │  ├── THINKING_START                               │
│  ├── TOOL_CALL_START                │  ├── THINKING_END                                 │
│  ├── TOOL_CALL_ARGS                 │  ├── THINKING_TEXT_MESSAGE_START                  │
│  ├── TOOL_CALL_END                  │  ├── THINKING_TEXT_MESSAGE_CONTENT                │
│  ├── TOOL_CALL_CHUNK                │  └── THINKING_TEXT_MESSAGE_END                    │
│  └── TOOL_CALL_RESULT               │                                                   │
│                                     │  STATE & MESSAGES (3 events)                      │
│  ACTIVITY (2 events)                │  ├── STATE_SNAPSHOT                               │
│  ├── ACTIVITY_SNAPSHOT              │  ├── STATE_DELTA                                  │
│  └── ACTIVITY_DELTA                 │  └── MESSAGES_SNAPSHOT                            │
│                                     │                                                   │
│  CUSTOM (2 events)                  │                                                   │
│  ├── RAW                            │                                                   │
│  └── CUSTOM                         │                                                   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## State Transition Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              AG-UI PROTOCOL STATE MACHINE                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘

                                    ┌──────────────┐
                                    │   INITIAL    │
                                    │    STATE     │
                                    └──────┬───────┘
                                           │
                                           ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  RUN_STARTED                                                                              │
│  ├── thread_id, run_id, parent_run_id?, input?                                           │
│  └── Marks beginning of agent execution                                                   │
└───────────────────────────────────────┬──────────────────────────────────────────────────┘
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  STATE_SNAPSHOT (optional, early)                                                         │
│  ├── snapshot: State (full state object)                                                  │
│  └── Sets initial state for frontend                                                      │
└───────────────────────────────────────┬──────────────────────────────────────────────────┘
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           │                            │                            │
           ▼                            ▼                            ▼
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│   TEXT MESSAGE      │    │    TOOL CALLING     │    │   STATE UPDATE      │
│      FLOW           │    │       FLOW          │    │      FLOW           │
└──────────┬──────────┘    └──────────┬──────────┘    └──────────┬──────────┘
           │                          │                          │
           ▼                          ▼                          ▼
┌─────────────────────┐    ┌─────────────────────┐    ┌─────────────────────┐
│ TEXT_MESSAGE_START  │    │ TOOL_CALL_START     │    │ STATE_DELTA         │
│ ├── message_id      │    │ ├── tool_call_id    │    │ ├── delta: List     │
│ ├── role            │    │ ├── tool_call_name  │    │ └── JSON Patch ops  │
│ └── (default=asst)  │    │ └── parent_msg_id?  │    │     (RFC 6902)      │
└──────────┬──────────┘    └──────────┬──────────┘    └──────────┬──────────┘
           │                          │                          │
           ▼                          ▼                          │
┌─────────────────────┐    ┌─────────────────────┐               │
│ TEXT_MESSAGE_CONTENT│    │ TOOL_CALL_ARGS      │               │
│ ├── message_id      │    │ ├── tool_call_id    │               │
│ └── delta: str      │    │ └── delta: str      │               │
│   (streamed chunks) │    │   (streamed JSON)   │               │
└──────────┬──────────┘    └──────────┬──────────┘               │
           │ (repeats)                │ (repeats)                │
           ▼                          ▼                          │
┌─────────────────────┐    ┌─────────────────────┐               │
│ TEXT_MESSAGE_END    │    │ TOOL_CALL_END       │               │
│ └── message_id      │    │ └── tool_call_id    │               │
└──────────┬──────────┘    └──────────┬──────────┘               │
           │                          │                          │
           │                          ▼                          │
           │               ┌─────────────────────┐               │
           │               │ TOOL_CALL_RESULT    │               │
           │               │ ├── message_id      │               │
           │               │ ├── tool_call_id    │               │
           │               │ ├── content         │               │
           │               │ └── role?: "tool"   │               │
           │               └──────────┬──────────┘               │
           │                          │                          │
           └──────────────────────────┴──────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  RUN_FINISHED                                                                             │
│  ├── thread_id, run_id                                                                    │
│  └── result?: Any                                                                         │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                               ┌─────────────┐
                               │    IDLE     │
                               │   (ready)   │
                               └─────────────┘

                              ERROR HANDLING:
                        ┌──────────────────────────┐
                        │  RUN_ERROR               │
                        │  ├── message: str        │
                        │  └── code?: str          │
                        │  (Can occur at any point)│
                        └──────────────────────────┘
```

## Summary

The state synchronization and tool call tracking between frontend and backend in the AG-UI/CopilotKit architecture follows a bidirectional flow using:

**State Synchronization:**
1. **Frontend → Backend**: State is serialized as JSON and sent as part of GraphQL mutations (or direct POST)
2. **Backend → Frontend**: State updates are streamed via SSE using `StateSnapshotEvent` and `StateDeltaEvent` events

**Tool Call Tracking:**
1. **Message-Based (AG-UI Protocol)**: Standard `ToolCallStartEvent`, `ToolCallArgsEvent`, `ToolCallEndEvent` events update the messages array
2. **State-Based (Custom UI)**: Custom `tool_logs` array in agent state updated via `StateDeltaEvent` for user-friendly progress display

The key insight is that CopilotKit wraps the AG-UI protocol with a GraphQL layer, but the underlying state transport and tool tracking mechanisms can be implemented directly using SSE, JSON Patch, and standard AG-UI events.

## Detailed Findings

### 1. Frontend State Management (`useCoAgent` Hook)

**Location**: `reference_code/CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-coagent.ts`

The `useCoAgent` hook is the primary interface for managing shared state between frontend and agent:

```typescript
// page.tsx:80-87
const { state, setState } = useCoAgent({
  name: "langgraphAgent",
  initialState: {
    available_cash: totalCash,
    investment_summary: {} as any,
    investment_portfolio: [] as InvestmentPortfolio[]
  }
});
```

**How it works**:
- State is stored in React context via `coagentStatesRef` (line 235-236)
- `setState` function updates local React state via `setCoagentStatesWithRef` (lines 252-268)
- State is tracked per agent name in a `Record<string, CoagentState>` structure

### 2. Frontend → Backend: State Transmission

**Location**: `reference_code/CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-chat.ts:377-433`

When a chat message is sent, the `runChatCompletion` function serializes and transmits state:

```typescript
// use-chat.ts:415-426
agentStates: Object.values(coagentStatesRef.current!).map((state) => {
  const stateObject: AgentStateInput = {
    agentName: state.name,
    state: JSON.stringify(state.state),
  };
  if (state.config !== undefined) {
    stateObject.config = JSON.stringify(state.config);
  }
  return stateObject;
}),
```

**Key data structure** (`AgentStateInput`):
```typescript
{
  agentName: string;      // e.g., "langgraphAgent"
  state: string;          // JSON-stringified state object
  config?: string;        // Optional JSON-stringified config
}
```

This is sent via the `generateCopilotResponse` GraphQL mutation.

### 3. GraphQL Mutation Structure

**Location**: `reference_code/CopilotKit-main/CopilotKit/packages/runtime-client-gql/src/graphql/definitions/mutations.ts`

The mutation sends agent states and receives state updates:

```graphql
mutation generateCopilotResponse($data: GenerateCopilotResponseInput!, $properties: JSONObject) {
  generateCopilotResponse(data: $data, properties: $properties) {
    # ... other fields ...
    messages @stream {
      ... on AgentStateMessageOutput {
        threadId
        state
        running
        agentName
        nodeName
        runId
        active
        role
      }
    }
  }
}
```

### 4. Backend Agent Receives State

**Location**: `reference_code/open-ag-ui-demo-langgraph-main/agent/main.py:43-83`

The LangGraph agent receives state via `RunAgentInput`:

```python
@app.post("/langgraph-agent")
async def langgraph_agent(input_data: RunAgentInput):
    # Access frontend state
    available_cash = input_data.state["available_cash"]
    investment_portfolio = input_data.state["investment_portfolio"]

    # Initialize agent with frontend state
    state = AgentState(
        tools=input_data.tools,
        messages=input_data.messages,
        available_cash=input_data.state["available_cash"],
        investment_portfolio=input_data.state["investment_portfolio"],
        # ... other fields
    )
```

### 5. Backend → Frontend: AG-UI State Events

**Location**: `reference_code/open-ag-ui-demo-langgraph-main/agent/main.py:64-111`

The backend sends state updates via SSE events:

```python
# Full state snapshot (line 64-74)
yield encoder.encode(
    StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot={
            "available_cash": input_data.state["available_cash"],
            "investment_summary": input_data.state["investment_summary"],
            "investment_portfolio": input_data.state["investment_portfolio"],
            "tool_logs": []
        }
    )
)

# Incremental state update using JSON Patch (line 100-111)
yield encoder.encode(
    StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=[
            {
                "op": "replace",
                "path": "/tool_logs",
                "value": []
            }
        ]
    )
)
```

### 6. AG-UI Event Types for State

**Location**: `reference_code/ag-ui-main/sdks/typescript/packages/client/src/apply/default.ts`

The AG-UI client processes state events:

```typescript
// StateSnapshotEvent (lines 427-453)
case EventType.STATE_SNAPSHOT: {
  const { snapshot } = event as StateSnapshotEvent;
  state = snapshot;  // Replace entire state
  applyMutation({ state });
}

// StateDeltaEvent (lines 455-493)
case EventType.STATE_DELTA: {
  const { delta } = event as StateDeltaEvent;
  // Apply JSON Patch operations
  const result = applyPatch(state, delta, true, false);
  state = result.newDocument;
  applyMutation({ state });
}
```

### 7. Frontend Receives and Applies State Updates

**Location**: `reference_code/CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-chat.ts:623-666`

When `AgentStateMessage` is received from the backend:

```typescript
setCoagentStatesWithRef((prevAgentStates) => ({
  ...prevAgentStates,
  [lastAgentStateMessage.agentName]: {
    name: lastAgentStateMessage.agentName,
    state: lastAgentStateMessage.state,
    running: lastAgentStateMessage.running,
    active: lastAgentStateMessage.active,
    threadId: lastAgentStateMessage.threadId,
    nodeName: lastAgentStateMessage.nodeName,
    runId: lastAgentStateMessage.runId,
    config: prevAgentStates[lastAgentStateMessage.agentName]?.config,
  },
}));
```

## Tool Call Tracking

Tool calls are tracked using TWO separate mechanisms in the AG-UI architecture:

### 1. Message-Based Tool Call Tracking (AG-UI Events)

**Location**: `reference_code/open-ag-ui-demo-langgraph-main/agent/main.py:116-139`

The backend emits standard AG-UI tool call events that update the messages array:

```python
# Tool call detected in assistant message
if state["messages"][-1].tool_calls:
    yield encoder.encode(
        ToolCallStartEvent(
            type=EventType.TOOL_CALL_START,
            tool_call_id=state["messages"][-1].tool_calls[0].id,
            toolCallName=state["messages"][-1].tool_calls[0].function.name,
        )
    )

    yield encoder.encode(
        ToolCallArgsEvent(
            type=EventType.TOOL_CALL_ARGS,
            tool_call_id=state["messages"][-1].tool_calls[0].id,
            delta=state["messages"][-1].tool_calls[0].function.arguments,
        )
    )

    yield encoder.encode(
        ToolCallEndEvent(
            type=EventType.TOOL_CALL_END,
            tool_call_id=state["messages"][-1].tool_calls[0].id,
        )
    )
```

**Frontend Processing**: `reference_code/ag-ui-main/sdks/typescript/packages/client/src/apply/default.ts:205-377`

The AG-UI client processes these events to build the messages array:

```typescript
case EventType.TOOL_CALL_START: {
  const { toolCallId, toolCallName, parentMessageId } = event as ToolCallStartEvent;

  // Create or find assistant message
  let targetMessage: AssistantMessage = {
    id: parentMessageId || toolCallId,
    role: "assistant",
    toolCalls: [],
  };
  messages.push(targetMessage);

  // Add tool call to message
  targetMessage.toolCalls.push({
    id: toolCallId,
    type: "function",
    function: {
      name: toolCallName,
      arguments: "",
    },
  });
}

case EventType.TOOL_CALL_ARGS: {
  const { toolCallId, delta } = event as ToolCallArgsEvent;

  // Find message with this tool call
  const targetMessage = messages.find(m =>
    (m as AssistantMessage).toolCalls?.some(tc => tc.id === toolCallId)
  ) as AssistantMessage;

  // Append arguments
  const targetToolCall = targetMessage.toolCalls!.find(tc => tc.id === toolCallId);
  targetToolCall.function.arguments += delta;
}
```

**Result**: Tool calls are stored in the messages array as:
```typescript
{
  id: "msg-123",
  role: "assistant",
  toolCalls: [
    {
      id: "call_abc",
      type: "function",
      function: {
        name: "get_stock_data",
        arguments: '{"ticker": "AAPL"}'
      }
    }
  ]
}
```

### 2. Custom State-Based Tool Tracking (tool_logs)

**Location**: `reference_code/open-ag-ui-demo-langgraph-main/agent/stock_analysis.py:160-184`

The backend maintains a custom `tool_logs` array in the agent state for UI display purposes:

```python
# Add tool log to state
tool_log_id = str(uuid.uuid4())
state["tool_logs"].append({
    "id": tool_log_id,
    "message": "Analyzing user query",
    "status": "processing",
})

# Emit StateDeltaEvent to sync to frontend
config.get("configurable").get("emit_event")(
    StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=[
            {
                "op": "add",
                "path": "/tool_logs/-",  # Append to array
                "value": {
                    "message": "Analyzing user query",
                    "status": "processing",
                    "id": tool_log_id,
                },
            }
        ],
    )
)
```

**Updating tool status**: `reference_code/open-ag-ui-demo-langgraph-main/agent/stock_analysis.py:246-258`

```python
# Update tool log status to completed
index = len(state["tool_logs"]) - 1
config.get("configurable").get("emit_event")(
    StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=[
            {
                "op": "replace",
                "path": f"/tool_logs/{index}/status",
                "value": "completed",
            }
        ],
    )
)
```

**Frontend Display**: `reference_code/open-ag-ui-demo-langgraph-main/frontend/src/app/page.tsx:89-92`

Uses `useCoAgentStateRender` hook to render tool logs:

```typescript
useCoAgentStateRender({
  name: "langgraphAgent",
  render: ({state}) => <ToolLogs logs={state.tool_logs} />
})
```

**ToolLogs Component**: `reference_code/open-ag-ui-demo-langgraph-main/frontend/src/app/components/tool-logs.tsx:6-14`

```typescript
interface ToolLog {
  id: string | number
  message: string
  status: "processing" | "completed"
}

// Displays with animated spinner for "processing" and checkmark for "completed"
```

### Key Differences Between the Two Tracking Mechanisms

| Aspect | Message-Based (AG-UI Events) | State-Based (tool_logs) |
|--------|------------------------------|-------------------------|
| **Purpose** | Standard protocol for tool execution | Custom UI progress display |
| **Storage** | In `messages` array | In agent `state.tool_logs` |
| **Structure** | Full tool call with arguments | Simple status messages |
| **Update Method** | ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent | StateDeltaEvent with JSON Patch |
| **Frontend Hook** | Automatically processed by AG-UI client | Rendered via `useCoAgentStateRender` |
| **Use Case** | LLM tool execution tracking | User-friendly progress indicators |

### JSON Patch Operations for Tool Logs

The `tool_logs` array is updated using JSON Patch operations:

```typescript
// Add new log (append to array)
{
  "op": "add",
  "path": "/tool_logs/-",  // "-" means append
  "value": { "id": "...", "message": "...", "status": "processing" }
}

// Update log status
{
  "op": "replace",
  "path": "/tool_logs/0/status",  // Index-based path
  "value": "completed"
}

// Replace entire array
{
  "op": "replace",
  "path": "/tool_logs",
  "value": []
}
```

## Code References

### State Synchronization
- `reference_code/open-ag-ui-demo-langgraph-main/frontend/src/app/page.tsx:80-87` - useCoAgent initialization
- `reference_code/CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-coagent.ts:252-268` - setState implementation
- `reference_code/CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-chat.ts:415-426` - State serialization for transmission
- `reference_code/CopilotKit-main/CopilotKit/packages/runtime-client-gql/src/graphql/definitions/mutations.ts:66-75` - AgentStateMessageOutput schema
- `reference_code/open-ag-ui-demo-langgraph-main/agent/main.py:64-111` - Backend state event emission
- `reference_code/ag-ui-main/sdks/typescript/packages/client/src/apply/default.ts:427-493` - State event processing
- `reference_code/CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-chat.ts:623-666` - Frontend state update application

### Tool Call Tracking
- `reference_code/open-ag-ui-demo-langgraph-main/agent/main.py:116-139` - Backend tool call event emission
- `reference_code/ag-ui-main/sdks/typescript/packages/client/src/apply/default.ts:205-377` - Frontend tool call event processing
- `reference_code/open-ag-ui-demo-langgraph-main/agent/stock_analysis.py:160-184` - Custom tool_logs state tracking
- `reference_code/open-ag-ui-demo-langgraph-main/agent/stock_analysis.py:246-258` - Tool log status updates
- `reference_code/open-ag-ui-demo-langgraph-main/frontend/src/app/page.tsx:89-92` - useCoAgentStateRender for tool logs
- `reference_code/open-ag-ui-demo-langgraph-main/frontend/src/app/components/tool-logs.tsx:6-46` - ToolLogs component

## Architecture Documentation

### Complete State Synchronization Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React)                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    setState()    ┌──────────────────┐                      │
│  │ useCoAgent  │ ───────────────> │ coagentStatesRef │                      │
│  │   Hook      │ <─────────────── │ (React Context)  │                      │
│  └─────────────┘    state         └──────────────────┘                      │
│        │                                   │                                 │
│        │ On chat/completion                │ Serialized as JSON              │
│        ▼                                   ▼                                 │
│  ┌─────────────────────────────────────────────────────────────┐            │
│  │                    runChatCompletion()                       │            │
│  │  agentStates: [{ agentName, state: JSON.stringify(state) }] │            │
│  └─────────────────────────────────────────────────────────────┘            │
│                                   │                                          │
└───────────────────────────────────┼──────────────────────────────────────────┘
                                    │ GraphQL Mutation (HTTP POST)
                                    │ or Direct SSE POST
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      COPILOTKIT RUNTIME (Optional)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  Proxies requests to backend agent via HttpAgent                            │
│  Can be bypassed by sending directly to backend                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ RunAgentInput { state, messages, tools }
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BACKEND (Python/FastAPI)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  POST /langgraph-agent                                                       │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  input_data: RunAgentInput                                          │     │
│  │    - state: { available_cash, investment_portfolio, ... }          │     │
│  │    - messages: [...]                                                │     │
│  │    - tools: [...]                                                   │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                          │                                                   │
│                          ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  LangGraph Agent Processing                                         │     │
│  │  - Updates state based on agent logic                               │     │
│  │  - Emits SSE events                                                 │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                          │                                                   │
│                          ▼ SSE Stream                                        │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  SSE Events Emitted:                                                │     │
│  │  - StateSnapshotEvent { snapshot: { ... } }                         │     │
│  │  - StateDeltaEvent { delta: [{ op, path, value }] }                 │     │
│  │  - TextMessageContentEvent { ... }                                  │     │
│  │  - ToolCallStartEvent { toolCallId, toolCallName }                  │     │
│  │  - ToolCallArgsEvent { toolCallId, delta }                          │     │
│  │  - ToolCallEndEvent { toolCallId }                                  │     │
│  │  - ToolCallResultEvent { toolCallId, content }                      │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │ SSE Events
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (Event Processing)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  defaultApplyEvents() / AG-UI Event Processor                       │     │
│  │                                                                     │     │
│  │  STATE_SNAPSHOT: state = snapshot                                   │     │
│  │  STATE_DELTA: state = applyPatch(state, delta)                      │     │
│  │  TOOL_CALL_START/ARGS/END: Update messages array with tool calls    │     │
│  │  TEXT_MESSAGE_CONTENT: Append to message content                    │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                          │                                                   │
│                          ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  setCoagentStatesWithRef({ [agentName]: { state, ... } })           │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                          │                                                   │
│                          ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  useCoAgent.state updates → React re-renders                        │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Implementation Without CopilotKit

To implement state synchronization without CopilotKit:

#### 1. Frontend: Send State to Backend

```typescript
interface RunAgentInput {
  threadId: string;
  runId: string;
  state: Record<string, any>;  // Your state object
  messages: Message[];
  tools: Tool[];
}

async function sendToAgent(state: YourState) {
  const response = await fetch('/api/agent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      threadId: 'your-thread-id',
      runId: 'your-run-id',
      state: state,
      messages: messages,
      tools: tools,
    }),
  });

  // Process SSE stream
  const reader = response.body.getReader();
  // ... handle streaming
}
```

#### 2. Backend: Emit State Events (Python)

```python
from ag_ui.core import StateSnapshotEvent, StateDeltaEvent, EventType
from ag_ui.encoder import EventEncoder

# Full state snapshot
yield encoder.encode(
    StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot={"key": "value", ...}
    )
)

# Incremental update (JSON Patch format)
yield encoder.encode(
    StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=[
            {"op": "replace", "path": "/key", "value": "new_value"}
        ]
    )
)
```

#### 3. Frontend: Process State Events

```typescript
import { applyPatch } from 'fast-json-patch';

function processEvent(event: BaseEvent, currentState: State) {
  switch (event.type) {
    case 'STATE_SNAPSHOT':
      return event.snapshot;

    case 'STATE_DELTA':
      const result = applyPatch(currentState, event.delta, true, false);
      return result.newDocument;

    default:
      return currentState;
  }
}
```

### Implementing Tool Call Tracking Without CopilotKit

#### 1. Message-Based Tool Call Tracking (Standard AG-UI)

**Backend: Emit Tool Call Events**
```python
from ag_ui.core import ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, EventType
from ag_ui.encoder import EventEncoder

# When LLM makes a tool call
yield encoder.encode(
    ToolCallStartEvent(
        type=EventType.TOOL_CALL_START,
        tool_call_id="call_abc123",
        toolCallName="get_weather",
        parentMessageId="msg_456"  # Optional: ID of assistant message
    )
)

# Stream tool call arguments (can be chunked)
yield encoder.encode(
    ToolCallArgsEvent(
        type=EventType.TOOL_CALL_ARGS,
        tool_call_id="call_abc123",
        delta='{"city": "San Francisco"}'
    )
)

# Signal tool call is complete
yield encoder.encode(
    ToolCallEndEvent(
        type=EventType.TOOL_CALL_END,
        tool_call_id="call_abc123"
    )
)

# Optionally emit tool result
yield encoder.encode(
    ToolCallResultEvent(
        type=EventType.TOOL_CALL_RESULT,
        messageId="msg_789",
        toolCallId="call_abc123",
        content="Temperature: 72°F",
        role="tool"
    )
)
```

**Frontend: Process Tool Call Events**
```typescript
interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface AssistantMessage {
  id: string;
  role: "assistant";
  toolCalls?: ToolCall[];
}

function processToolCallEvent(event: BaseEvent, messages: Message[]) {
  switch (event.type) {
    case 'TOOL_CALL_START': {
      const { toolCallId, toolCallName, parentMessageId } = event;

      // Find or create assistant message
      let message = messages.find(m => m.id === parentMessageId);
      if (!message) {
        message = {
          id: parentMessageId || toolCallId,
          role: "assistant",
          toolCalls: []
        };
        messages.push(message);
      }

      // Add tool call
      message.toolCalls = message.toolCalls || [];
      message.toolCalls.push({
        id: toolCallId,
        type: "function",
        function: { name: toolCallName, arguments: "" }
      });
      break;
    }

    case 'TOOL_CALL_ARGS': {
      const { toolCallId, delta } = event;

      // Find message with this tool call
      const message = messages.find(m =>
        m.toolCalls?.some(tc => tc.id === toolCallId)
      );

      if (message) {
        const toolCall = message.toolCalls.find(tc => tc.id === toolCallId);
        toolCall.function.arguments += delta;
      }
      break;
    }

    case 'TOOL_CALL_END': {
      // Tool call is complete - can now parse arguments
      const { toolCallId } = event;
      const message = messages.find(m =>
        m.toolCalls?.some(tc => tc.id === toolCallId)
      );

      if (message) {
        const toolCall = message.toolCalls.find(tc => tc.id === toolCallId);
        const args = JSON.parse(toolCall.function.arguments);
        console.log('Tool call completed:', toolCall.function.name, args);
      }
      break;
    }
  }

  return messages;
}
```

#### 2. Custom State-Based Tool Tracking (UI Progress Display)

**Backend: Track Tool Execution Status**
```python
import uuid
from ag_ui.core import StateDeltaEvent, EventType

# Start tool execution
tool_log_id = str(uuid.uuid4())
state["tool_logs"].append({
    "id": tool_log_id,
    "message": "Fetching weather data...",
    "status": "processing",
})

yield encoder.encode(
    StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=[{
            "op": "add",
            "path": "/tool_logs/-",
            "value": {
                "id": tool_log_id,
                "message": "Fetching weather data...",
                "status": "processing"
            }
        }]
    )
)

# ... execute tool ...

# Update to completed
index = len(state["tool_logs"]) - 1
yield encoder.encode(
    StateDeltaEvent(
        type=EventType.STATE_DELTA,
        delta=[{
            "op": "replace",
            "path": f"/tool_logs/{index}/status",
            "value": "completed"
        }]
    )
)
```

**Frontend: Display Tool Progress**
```typescript
interface ToolLog {
  id: string;
  message: string;
  status: "processing" | "completed" | "error";
}

function ToolLogsDisplay({ logs }: { logs: ToolLog[] }) {
  return (
    <div>
      {logs.map(log => (
        <div key={log.id} className={`tool-log ${log.status}`}>
          {log.status === "processing" && <Spinner />}
          {log.status === "completed" && <CheckIcon />}
          {log.status === "error" && <ErrorIcon />}
          <span>{log.message}</span>
        </div>
      ))}
    </div>
  );
}

// In your state processor
function processStateEvents(event: BaseEvent, currentState: State) {
  if (event.type === 'STATE_DELTA') {
    const result = applyPatch(currentState, event.delta, true, false);
    return result.newDocument;
  }
  return currentState;
}

// Render in React
function ChatInterface() {
  const [agentState, setAgentState] = useState({ tool_logs: [] });

  return (
    <div>
      <ToolLogsDisplay logs={agentState.tool_logs} />
      {/* ... chat messages ... */}
    </div>
  );
}
```

### Key Dependencies

For implementing without CopilotKit:
- **Frontend**: `fast-json-patch` for applying JSON Patch operations
- **Backend**: `ag-ui-core` Python package for event types and encoding
- **SSE Parsing**: Standard EventSource or fetch with ReadableStream

## Related Research

- `thoughts/shared/plans/2025-12-30-minimal-agui-example.md` - Plan for minimal AG-UI implementation

## CopilotKit React-Core Call Stack

The following traces the complete call stack from user message to state update in CopilotKit:

### 1. User Sends Message

```
User clicks "Send" button
    │
    ▼
CopilotChat component calls `sendMessage()`
    │
    └─► uses `useCopilotChat()` hook (react-core/src/hooks/use-copilot-chat.ts)
        │
        └─► calls `append()` from `useChat()` (react-core/src/hooks/use-chat.ts:949-964)
            │
            └─► calls `runChatCompletionAndHandleFunctionCall()` (line 898)
                │
                └─► calls `runChatCompletion()` (line 306)
```

### 2. Chat Completion Flow

**File**: `react-core/src/hooks/use-chat.ts:306-893`

```
runChatCompletion(previousMessages)
    │
    ├─► 1. Create abort controller (line 333)
    │
    ├─► 2. Build request data (lines 337-433)
    │   ├── messages: convertMessagesToGqlInput(messages)
    │   ├── agentStates: serialized from coagentStatesRef (lines 415-426)
    │   ├── frontend: { actions, url }
    │   ├── threadId, runId, extensions
    │   └── metaEvents (for LangGraph interrupts)
    │
    ├─► 3. Call runtimeClient.generateCopilotResponse() (lines 377-433)
    │   │
    │   └─► CopilotRuntimeClient.generateCopilotResponse()
    │       (runtime-client-gql/src/client/CopilotRuntimeClient.ts:106-122)
    │       │
    │       └─► GraphQL mutation over HTTP with streaming
    │
    ├─► 4. Convert to ReadableStream via runtimeClient.asStream() (line 377)
    │   │
    │   └─► CopilotRuntimeClient.asStream()
    │       (runtime-client-gql/src/client/CopilotRuntimeClient.ts:124-174)
    │
    └─► 5. Process stream in while loop (lines 448-674)
        │
        ├─► Read from stream (lines 451-457)
        │
        ├─► Process runId and extensions (lines 470-480)
        │
        ├─► Convert messages: convertGqlOutputToMessages() (line 508)
        │   (runtime-client-gql/src/client/conversion.ts:112-170)
        │
        ├─► Handle AgentStateMessages (lines 623-666)
        │   │
        │   ├─► Extract synced messages if present (lines 627-635)
        │   │   └── loadMessagesFromJsonRepresentation()
        │   │
        │   └─► Update coagent states (lines 636-666)
        │       └── setCoagentStatesWithRef({
        │             [agentName]: {
        │               name, state, running, active,
        │               threadId, nodeName, runId, config
        │             }
        │           })
        │
        └─► Update messages state (lines 670-673)
            └── setMessages([...previousMessages, ...newMessages])
```

### 3. Message Type Conversion

**File**: `runtime-client-gql/src/client/conversion.ts`

```
GraphQL Output → Internal Message Types

AgentStateMessageOutput → AgentStateMessage (lines 143-155)
    │
    ├─► id, role, agentName, nodeName, runId
    ├─► threadId, running, active
    └─► state: parseJson(message.state, {})

TextMessageOutput → TextMessage (lines 116-124)
    │
    └─► content: message.content.join("")

ActionExecutionMessageOutput → ActionExecutionMessage (lines 125-133)
    │
    └─► arguments: getPartialArguments(message.arguments)
        (handles streaming JSON with untruncate-json)

ResultMessageOutput → ResultMessage (lines 134-142)
```

### 4. CoAgent State Access

**File**: `react-core/src/hooks/use-coagent.ts`

```
useCoAgent({ name: "agentName", initialState: {...} })
    │
    ├─► Accesses coagentStates from CopilotContext (line 235)
    │
    ├─► Returns (lines 356-369):
    │   {
    │     name,
    │     nodeName,        // Current LangGraph node
    │     threadId,        // Agent thread ID
    │     running,         // Is agent executing?
    │     state,           // Current state object ← UPDATES REACTIVELY
    │     setState,        // Update state (syncs back to agent)
    │     start,           // Start agent execution
    │     stop,            // Stop agent execution
    │     run              // Re-run agent with optional hint
    │   }
    │
    └─► React re-renders when coagentStates[name] changes
```

### 5. Frontend → Backend State Flow

```
User modifies state via setState()
    │
    ▼
setCoagentStatesWithRef() updates React state
(react-core/src/hooks/use-coagent.ts:252-268)
    │
    ▼
On next chat message, state is serialized:
(react-core/src/hooks/use-chat.ts:415-426)
    │
    agentStates: Object.values(coagentStatesRef.current!).map((state) => ({
      agentName: state.name,
      state: JSON.stringify(state.state),
      config: state.config ? JSON.stringify(state.config) : undefined
    }))
    │
    ▼
Sent as part of generateCopilotResponse mutation
    │
    ▼
Backend receives in RunAgentInput.state
```

### 6. Backend → Frontend State Flow (SSE Events)

```
Backend emits StateSnapshotEvent or StateDeltaEvent
    │
    ▼
SSE event received by frontend
    │
    ▼
GraphQL subscription yields AgentStateMessageOutput
    │
    ▼
convertGqlOutputToMessages() creates AgentStateMessage
(runtime-client-gql/src/client/conversion.ts:143-155)
    │
    ▼
runChatCompletion() processes AgentStateMessage
(react-core/src/hooks/use-chat.ts:601-667)
    │
    ├─► Updates syncedMessages from state.messages
    │
    └─► Calls setCoagentStatesWithRef() with new state
        │
        ▼
    React state update triggers re-render
        │
        ▼
    useCoAgent() consumers receive updated `state`
```

## Event Class Definitions

**File**: `ag-ui-main/sdks/python/ag_ui/core/events.py`

| Event Class | Line | Key Fields |
|-------------|------|------------|
| `TextMessageStartEvent` | 57-63 | message_id, role |
| `TextMessageContentEvent` | 66-72 | message_id, delta |
| `TextMessageEndEvent` | 75-80 | message_id |
| `TextMessageChunkEvent` | 82-89 | message_id?, role?, delta? |
| `ToolCallStartEvent` | 110-117 | tool_call_id, tool_call_name, parent_message_id? |
| `ToolCallArgsEvent` | 120-126 | tool_call_id, delta |
| `ToolCallEndEvent` | 129-134 | tool_call_id |
| `ToolCallChunkEvent` | 136-144 | tool_call_id?, tool_call_name?, delta? |
| `ToolCallResultEvent` | 146-154 | message_id, tool_call_id, content, role? |
| `StateSnapshotEvent` | 169-174 | snapshot: State |
| `StateDeltaEvent` | 177-182 | delta: List[Any] (JSON Patch RFC 6902) |
| `MessagesSnapshotEvent` | 185-190 | messages: List[Message] |
| `RunStartedEvent` | 230-238 | thread_id, run_id, parent_run_id?, input? |
| `RunFinishedEvent` | 241-248 | thread_id, run_id, result? |
| `RunErrorEvent` | 251-257 | message, code? |
| `StepStartedEvent` | 260-265 | step_name |
| `StepFinishedEvent` | 268-273 | step_name |
| `ThinkingStartEvent` | 156-161 | title? |
| `ThinkingEndEvent` | 163-167 | (none) |
| `ActivitySnapshotEvent` | 193-200 | message_id, activity_type, content, replace |
| `ActivityDeltaEvent` | 203-209 | message_id, activity_type, patch |
| `RawEvent` | 212-218 | event, source? |
| `CustomEvent` | 221-227 | name, value |

## Open Questions

### State Synchronization
1. How does CopilotKit handle reconnection and state recovery on network failures?
2. What is the exact format of the SSE events (event name, data format)?
3. How does the `fast-json-patch` library handle conflicting patches?
4. Is there a mechanism for optimistic updates with rollback on failure?

### Tool Call Tracking
5. How are tool call results from backend tools displayed differently from frontend tools?
6. What happens if a tool call fails or times out?
7. Can tool calls be cancelled mid-execution?
8. How are parallel tool calls (multiple tools executing simultaneously) tracked and displayed?
9. Is there a standard way to display tool call arguments in the UI before execution?
