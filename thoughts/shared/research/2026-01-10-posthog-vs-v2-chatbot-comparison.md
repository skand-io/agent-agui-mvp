---
date: 2026-01-10T08:38:25Z
researcher: Claude
git_commit: b4f56abe26c18b62a28dc888f10abef24e3d5111
branch: claude/compare-chatbot-implementations-2uHkO
repository: agent-agui-mvp
topic: "PostHog Max AI vs frontend_v2/backend_v2 Chatbot Implementation Comparison"
tags: [research, codebase, chatbot, posthog, ag-ui, langgraph]
status: complete
last_updated: 2026-01-10
last_updated_by: Claude
---

# Research: PostHog Max AI vs frontend_v2/backend_v2 Chatbot Implementation Comparison

**Date**: 2026-01-10T08:38:25Z
**Researcher**: Claude
**Git Commit**: b4f56abe26c18b62a28dc888f10abef24e3d5111
**Branch**: claude/compare-chatbot-implementations-2uHkO
**Repository**: agent-agui-mvp

## Research Question

Create a summary of the differences between PostHog's implementation of their chatbot (Max AI) and the one defined in frontend_v2 and backend_v2.

## Summary

PostHog's Max AI is a production-grade, enterprise-scale chatbot with ~50+ files, deep product integration, and a custom event streaming protocol. The v2 implementation is a minimal AG-UI protocol demonstration with a handful of files focused on showcasing core agent patterns. The key architectural differences are:

1. **State Management**: PostHog uses Kea.js (a Redux-like library) with complex logic modules; v2 uses React hooks with simple useState
2. **Protocol**: PostHog uses custom SSE events (Conversation, Message, Status, Update); v2 uses AG-UI protocol events (21 event types)
3. **Tool Execution**: PostHog executes all tools backend-side with UI payload callbacks; v2 supports both backend tools and frontend tools via LangGraph interrupt/resume
4. **Backend Architecture**: PostHog has domain-specific subgraphs (funnels, insights, SQL, etc.); v2 has simple sub-agent tools (haiku_poet, calculator_agent_tool)
5. **Persistence**: PostHog uses Django models with checkpointing; v2 uses in-memory state only

## Detailed Findings

### Architecture Comparison

| Aspect | PostHog Max AI | frontend_v2/backend_v2 |
|--------|---------------|------------------------|
| **Frontend Framework** | React + Kea.js state management | React + useState hooks |
| **Backend Framework** | Django + LangGraph | FastAPI + LangGraph |
| **Streaming Protocol** | Custom SSE (Conversation, Message, Status, Update) | AG-UI Protocol (21 event types) |
| **Persistence** | PostgreSQL via Django ORM | In-memory only |
| **Tool Types** | Backend-only with UI callbacks | Backend + Frontend tools |
| **Sub-agents** | Domain-specific graphs (insights, funnels, SQL, etc.) | Generic sub-agent tools |

### Frontend Implementation

#### PostHog Max AI (`reference_code/posthog-master/frontend/src/scenes/max/`)

**State Management - Kea.js Logic Modules:**
- `maxLogic.tsx:64-495` - Main state logic with actions, reducers, selectors
- `maxThreadLogic.tsx:86-1127` - Thread-specific state with streaming handling
- `maxGlobalLogic.tsx` - Global conversation state and tool registration

**Key State Structures:**
```typescript
// ThreadMessage with status tracking
type ThreadMessage = RootAssistantMessage & {
    status: MessageStatus  // 'loading' | 'completed' | 'error'
}

// Complex tool registration
interface ToolRegistration {
    identifier: string
    name: string
    description: string
    context: Record<string, any>
    callback?: (result: any, conversationId: string) => Promise<void>
    suggestions?: SuggestionItem[]
}
```

**Event Parsing (`maxThreadLogic.tsx:984-1100`):**
```typescript
// Custom event types
if (event === AssistantEventType.Conversation) { ... }
else if (event === AssistantEventType.Update) { ... }
else if (event === AssistantEventType.Message) { ... }
else if (event === AssistantEventType.Status) { ... }
```

**Tool Display:**
- `components/ToolsDisplay.tsx` - Shows active tools with descriptions
- `MaxTool.tsx` - UI wrapper for tool-enabled components
- `useMaxTool.ts` - Hook for registering contextual tools

#### frontend_v2 (`frontend_v2/src/`)

**State Management - React Hooks:**
- `useChat.ts:30-412` - Single hook with all chat logic
- Simple useState for messages, agentState, activity

**Key State Structures:**
```typescript
// Simple message array
const [messages, setMessages] = useState<Message[]>([])

// Tool logs for UI progress (Tier 2)
const [agentState, setAgentState] = useState<AgentState>({ tool_logs: [] })
```

**Event Parsing (`useChat.ts:55-326`):**
- Handles all 21 AG-UI protocol events
- Includes special handling for frontend tool execution via `frontend_tool_required` custom event

**Frontend Tool Execution:**
```typescript
// In handleEvent for EventType.CUSTOM
if (event.name === 'frontend_tool_required') {
    const { tool_call_id, tool_name, args } = event.value
    const handler = FRONTEND_TOOLS[tool_name]
    const result = handler(args)
    // Resume graph with result
    await fetch('http://localhost:8000/chat', {
        method: 'POST',
        body: JSON.stringify({
            thread_id: threadId,
            resume_value: result,
            message: '',
        }),
    })
}
```

### Backend Implementation

#### PostHog Max AI (`reference_code/posthog-master/ee/hogai/`)

**Graph Architecture:**
- `chat_agent/graph.py:20-133` - Main AssistantGraph with modular composition
- `chat_agent/loop_graph/graph.py:11-44` - Base chat agent loop
- `chat_agent/runner.py:55-156` - Stream execution runner

**Graph Composition Pattern:**
```python
def compile_full_graph(self, checkpointer: DjangoCheckpointer | None = None):
    return (
        self.add_title_generator()
        .add_slash_command_handler()
        .add_memory_onboarding()
        .add_memory_collector()
        .add_memory_collector_tools()
        .add_root()
        .compile(checkpointer=checkpointer)
    )
```

**Domain-Specific Subgraphs:**
- `chat_agent/funnels/` - Funnel analysis
- `chat_agent/insights/` - General insights
- `chat_agent/retention/` - Retention analysis
- `chat_agent/query_executor/` - Query execution
- `chat_agent/schema_generator/` - Schema generation
- `chat_agent/rag/` - RAG-based documentation search

**Streaming Processor:**
```python
STREAMING_NODES: set = {
    AssistantNodeName.ROOT,
    AssistantNodeName.INKEEP_DOCS,
    AssistantNodeName.MEMORY_ONBOARDING,
    AssistantNodeName.DASHBOARD_CREATION,
}
```

**Persistence:**
- `DjangoCheckpointer` for graph state persistence
- `Conversation` Django model for conversation history
- Messages stored in database with full audit trail

#### backend_v2 (`backend_v2/`)

**Graph Architecture:**
- `server_langgraph.py:286-307` - Single StateGraph with agent and tool_handler nodes

**Simple Graph Structure:**
```python
workflow = StateGraph(AgentState)
workflow.add_node("agent", call_model)
workflow.add_node("tool_handler", tool_handler)
workflow.add_edge(START, "agent")
workflow.add_conditional_edges("agent", route_tools, {"end": END})
workflow.add_conditional_edges("tool_handler", route_after_tool, {"agent": "agent"})
```

**Tool Types (`tools/definitions.py:9-73`):**
```python
FRONTEND_TOOLS = {"greet"}  # Execute on frontend via interrupt
BACKEND_TOOLS = {"get_weather", "haiku_poet", "calculator_agent_tool"}  # Execute on backend
```

**Frontend Tool Handling (`server_langgraph.py:246-263`):**
```python
if tool_name in FRONTEND_TOOLS:
    # Use LangGraph interrupt() to pause for client execution
    frontend_result = interrupt({
        "type": "frontend_tool_call",
        "tool_call_id": tool_call["id"],
        "tool_name": tool_name,
        "args": tool_call["args"],
    })
    return {"messages": [ToolMessage(content=str(frontend_result), tool_call_id=tool_call["id"])]}
```

**Sub-agent Tools:**
- `tools/haiku_poet/__init__.py` - Simple sub-agent for generating haikus
- `tools/calculator_agent_tool/__init__.py` - Sub-agent with internal math tools

**Persistence:**
- `InMemorySaver` only - no persistent storage

### Tool Execution Flow Comparison

#### PostHog Approach

1. All tools execute on backend
2. Tool results returned via `AssistantToolCallMessage` with `ui_payload`
3. Frontend receives results and invokes callbacks:
```typescript
for (const [toolName, toolResult] of Object.entries(parsedResponse.ui_payload)) {
    await values.toolMap[toolName]?.callback?.(toolResult, props.conversationId)
}
```
4. UI updates happen synchronously after tool completion

#### v2 Approach

1. Backend tools execute immediately on server
2. Frontend tools use LangGraph `interrupt()`:
   - Graph pauses execution
   - Sends `frontend_tool_required` custom event
   - Client executes tool locally (e.g., `alert()`)
   - Client sends `resume_value` to continue graph
3. Enables true client-side execution for browser APIs

### State Synchronization

#### PostHog - Message-Based

- Stream sends complete `Message` objects
- Client maintains `threadRaw` array
- Message status tracked (`loading` | `completed` | `error`)
- Tool call completion matched via `tool_call_id`

#### v2 - Two-Tier System

1. **Tier 1 (Message-based)**: Standard AG-UI message events
   - `TEXT_MESSAGE_START/CONTENT/END`
   - `TOOL_CALL_START/ARGS/END/RESULT`

2. **Tier 2 (State-based)**: Custom state tracking
   - `STATE_SNAPSHOT` - Full state replacement
   - `STATE_DELTA` - JSON Patch updates (RFC 6902)
   - `tool_logs` array with `processing` | `completed` | `error` status

### Context and Memory

#### PostHog

- `maxContextLogic.ts` - Compiled UI context (dashboards, insights, events, actions)
- `memory/` subgraph for conversation memory
- Core memory settings integration
- `billingContext` for usage tracking

#### v2

- Minimal context passing via request body
- No memory system
- Thread ID for conversation continuity only

### Error Handling

#### PostHog (`maxThreadLogic.tsx:394-490`)

- Retry logic with exponential backoff (up to 15 retries)
- Network error detection and messaging
- API error code handling (400, 402, 409, 429, 500+)
- Graceful degradation with user-friendly messages

#### v2 (`useChat.ts:403-406`)

- Basic try/catch with console.error
- No retry mechanism
- Loading state reset on error

## Code References

| Component | PostHog | v2 |
|-----------|---------|-----|
| Main Logic | `frontend/src/scenes/max/maxLogic.tsx` | `frontend_v2/src/useChat.ts` |
| Thread Logic | `frontend/src/scenes/max/maxThreadLogic.tsx` | (included in useChat.ts) |
| Types | `frontend/src/scenes/max/maxTypes.ts` | `frontend_v2/src/types.ts` |
| Tool Display | `frontend/src/scenes/max/components/ToolsDisplay.tsx` | (inline in App.tsx) |
| Backend Graph | `ee/hogai/chat_agent/graph.py` | `backend_v2/server_langgraph.py` |
| Backend Runner | `ee/hogai/chat_agent/runner.py` | (inline in server_langgraph.py) |
| Sub-agents | `ee/hogai/chat_agent/funnels/`, `insights/`, etc. | `backend_v2/tools/` |

## Key Architectural Differences

### 1. Scale and Complexity
- **PostHog**: Enterprise-grade with ~50+ files, extensive test coverage
- **v2**: Minimal viable implementation with ~8 core files

### 2. Tool Paradigm
- **PostHog**: Backend-centric with UI callbacks
- **v2**: Hybrid with frontend tool execution via interrupt/resume

### 3. State Management
- **PostHog**: Kea.js with complex reducers and selectors
- **v2**: Simple React hooks with two-tier tracking

### 4. Event Protocol
- **PostHog**: Custom 4-event types (Conversation, Message, Status, Update)
- **v2**: AG-UI standard 21-event protocol

### 5. Persistence
- **PostHog**: Full persistence with Django ORM
- **v2**: In-memory only (ephemeral)

### 6. Domain Integration
- **PostHog**: Deep PostHog product integration (insights, funnels, SQL, etc.)
- **v2**: Generic tool examples (weather, greet, calculator)

## Open Questions

1. What specific AG-UI events does PostHog map their custom events to?
2. How would PostHog's tool registration system translate to AG-UI's tool calling?
3. Is there a migration path from PostHog's custom protocol to AG-UI standard?
4. How should frontend tools with side effects (like PostHog's `InsightsSearch`) be handled in AG-UI?
