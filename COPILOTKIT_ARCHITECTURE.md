# CopilotKit Architecture Deep Dive

This document provides a comprehensive analysis of the CopilotKit architecture, focusing on the backend runtime and the react-core frontend implementation. The goal is to understand the core functionality to implement a minimal viable product (MVP) without unnecessary complexity.

## Table of Contents

1. [High-Level Architecture Overview](#high-level-architecture-overview)
2. [Backend Runtime Architecture](#backend-runtime-architecture)
3. [Frontend React Implementation](#frontend-react-implementation)
4. [Communication Protocol (AG-UI)](#communication-protocol-ag-ui)
5. [MVP Implementation Requirements](#mvp-implementation-requirements)

---

## High-Level Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (React)                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │  CopilotKit     │  │  useCopilotChat │  │  useCopilotAction           │  │
│  │  Provider       │──│  Hook           │──│  Hook                       │  │
│  │  (Context)      │  │                 │  │  (Frontend Tool Registration)│  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────────────────┘  │
│           │                    │                                             │
│           ▼                    ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │              CopilotRuntimeClient (GraphQL over HTTP)               │    │
│  │                    - SSE Streaming Support                          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTP/SSE (AG-UI Protocol Events)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BACKEND (Runtime)                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                      CopilotRuntime                                 │    │
│  │  - Receives requests from frontend                                  │    │
│  │  - Manages actions (backend + frontend tools)                       │    │
│  │  - Coordinates with LLM service adapters                           │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    Service Adapters                                 │    │
│  │  - OpenAI, Anthropic, Google, etc.                                 │    │
│  │  - Convert to/from provider-specific formats                       │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│           │                                                                  │
│           ▼                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                RuntimeEventSource                                   │    │
│  │  - Streams AG-UI events back to frontend                           │    │
│  │  - Handles text streaming, tool calls, results                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Backend Runtime Architecture

### Core Components

#### 1. CopilotRuntime (`packages/runtime/src/lib/runtime/copilot-runtime.ts`)

The central orchestrator that:
- Receives chat requests from the frontend
- Manages the list of available actions (both backend and frontend)
- Coordinates with LLM service adapters
- Handles the streaming response back to the frontend

**Key Methods:**
```typescript
class CopilotRuntime {
  // Process incoming chat request
  async process(request: CopilotRuntimeRequest): Promise<RuntimeEventSource>

  // Register backend actions
  actions: Action[]

  // Service adapter for LLM communication
  serviceAdapter: CopilotServiceAdapter
}
```

**Simplified Flow:**
1. Receive request with messages + frontend tools
2. Merge frontend tools with backend actions
3. Send to LLM via service adapter
4. Stream response events back via RuntimeEventSource

#### 2. RuntimeEventSource (`packages/runtime/src/service-adapters/events.ts`)

Manages the streaming of events back to the frontend using RxJS.

**Event Types (RuntimeEventTypes):**
```typescript
enum RuntimeEventTypes {
  TextMessageStart = "TextMessageStart",
  TextMessageContent = "TextMessageContent",
  TextMessageEnd = "TextMessageEnd",
  ActionExecutionStart = "ActionExecutionStart",
  ActionExecutionArgs = "ActionExecutionArgs",
  ActionExecutionEnd = "ActionExecutionEnd",
  ActionExecutionResult = "ActionExecutionResult",
  AgentStateMessage = "AgentStateMessage",
  MetaEvent = "MetaEvent",
  RunError = "RunError",
}
```

**RuntimeEventSubject Methods:**
```typescript
class RuntimeEventSubject extends ReplaySubject<RuntimeEvent> {
  sendTextMessageStart({ messageId, parentMessageId })
  sendTextMessageContent({ messageId, content })
  sendTextMessageEnd({ messageId })
  sendActionExecutionStart({ actionExecutionId, actionName, parentMessageId })
  sendActionExecutionArgs({ actionExecutionId, args })
  sendActionExecutionEnd({ actionExecutionId })
  sendActionExecutionResult({ actionExecutionId, actionName, result, error })
  sendAgentStateMessage({ threadId, agentName, nodeName, runId, active, role, state, running })
}
```

#### 3. Service Adapters

Abstract the differences between LLM providers (OpenAI, Anthropic, Google, etc.):

```typescript
interface CopilotServiceAdapter {
  stream(
    messages: Message[],
    actions: Action[],
    options: StreamOptions
  ): AsyncIterable<RuntimeEvent>
}
```

#### 4. Action Execution Flow

**Backend Actions:**
1. LLM decides to call an action → `ActionExecutionStart` event
2. Arguments streamed → `ActionExecutionArgs` event
3. Action call complete → `ActionExecutionEnd` event
4. Backend executes the action handler
5. Result sent → `ActionExecutionResult` event

**Frontend Actions:**
1. Same as backend: `ActionExecutionStart` → `ActionExecutionArgs` → `ActionExecutionEnd`
2. **NO `ActionExecutionResult`** from backend - frontend executes and handles result locally

### Key Insight: Frontend vs Backend Actions

The backend distinguishes actions by their `available` property:
- `available: "backend"` → Execute on server, return result
- `available: "frontend"` → Stream call info only, client executes

```typescript
// In processRuntimeEvents
if (eventWithState.callActionServerSide) {
  // Execute action on server
  executeAction(...)
  // Send result event
  toolCallEventStream$.sendActionExecutionResult(...)
} else {
  // Just forward the event, frontend will handle
  return of(eventWithState.event!)
}
```

---

## Frontend React Implementation

### Core Components

#### 1. CopilotContext (`packages/react-core/src/context/copilot-context.tsx`)

The central React context that holds all CopilotKit state:

```typescript
interface CopilotContextParams {
  // Actions/Tools
  actions: Record<string, FrontendAction<any>>
  setAction: (id: string, action: FrontendAction<any>) => void
  removeAction: (id: string) => void

  // Context (for providing app context to LLM)
  addContext: (context: string, parentId?, categories?) => TreeNodeId
  removeContext: (id: TreeNodeId) => void
  getContextString: (documents, categories) => string

  // Chat state
  isLoading: boolean
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>

  // API configuration
  copilotApiConfig: CopilotApiConfig

  // Thread/Run management
  threadId: string
  runId: string | null

  // Function call handling
  getFunctionCallHandler: (customEntryPoints?) => FunctionCallHandler

  // Runtime client
  runtimeClient: CopilotRuntimeClient
}
```

#### 2. useCopilotChat Hook (`packages/react-core/src/hooks/use-copilot-chat.ts`)

The main hook for chat interactions:

```typescript
interface UseCopilotChatReturn {
  // Messages
  messages: Message[]
  visibleMessages: DeprecatedGqlMessage[]

  // Actions
  sendMessage: (message: Message, options?) => Promise<void>
  appendMessage: (message: Message, options?) => Promise<void>
  setMessages: (messages: Message[]) => void
  deleteMessage: (messageId: string) => void
  reloadMessages: (messageId: string) => Promise<void>

  // Controls
  stopGeneration: () => void
  reset: () => void
  isLoading: boolean

  // Advanced
  runChatCompletion: () => Promise<Message[]>
}
```

**Simplified Implementation:**
```typescript
function useCopilotChat(options) {
  const context = useCopilotContext()
  const { messages, setMessages } = useCopilotMessagesContext()

  // Core chat logic via useChat hook
  const { append, reload, stop, runChatCompletion } = useChat({
    actions: Object.values(context.actions),
    copilotConfig: context.copilotApiConfig,
    onFunctionCall: context.getFunctionCallHandler(),
    messages,
    setMessages,
    // ... other options
  })

  return {
    messages,
    sendMessage: append,
    stopGeneration: stop,
    // ...
  }
}
```

#### 3. useChat Hook (`packages/react-core/src/hooks/use-chat.ts`)

The low-level hook that handles:
- Making requests to the backend
- Processing SSE stream responses
- Executing frontend actions
- Managing message state

**Key Flow in runChatCompletion:**
```typescript
async function runChatCompletion(previousMessages) {
  // 1. Create abort controller
  chatAbortControllerRef.current = new AbortController()

  // 2. Make streaming request via runtime client
  const stream = runtimeClient.asStream(
    runtimeClient.generateCopilotResponse({
      data: {
        frontend: { actions: processActionsForRuntimeRequest(actions) },
        messages: convertMessagesToGqlInput(messagesWithContext),
        threadId,
        runId,
        // ...
      }
    })
  )

  // 3. Process stream events
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    // Convert response to messages
    messages = convertGqlOutputToMessages(value.generateCopilotResponse.messages)
    setMessages([...previousMessages, ...messages])
  }

  // 4. Execute frontend actions
  for (const message of finalMessages) {
    if (message.isActionExecutionMessage()) {
      const action = actions.find(a => a.name === message.name)
      if (action && action.available === "frontend") {
        // Execute frontend action
        const result = await onFunctionCall({
          name: message.name,
          args: message.arguments,
        })
        // Add result message
        finalMessages.push(new ResultMessage({ result, actionExecutionId: message.id }))
      }
    }
  }

  // 5. If action was executed, run completion again (for follow-up)
  if (didExecuteAction && followUp !== false) {
    return await runChatCompletion(finalMessages)
  }
}
```

#### 4. useCopilotAction Hook (`packages/react-core/src/hooks/use-copilot-action.ts`)

Registers frontend actions that the LLM can call:

```typescript
useCopilotAction({
  name: "greet",
  description: "Greet a person",
  parameters: [
    { name: "name", type: "string", description: "Person's name" }
  ],
  handler: async ({ name }) => {
    alert(`Hello, ${name}!`)
    return `Greeted ${name}`
  }
})
```

**Implementation:**
```typescript
function useCopilotAction(action, dependencies?) {
  const { setAction, removeAction, actions } = useCopilotContext()
  const idRef = useRef(randomId())

  useEffect(() => {
    setAction(idRef.current, action)
    return () => removeAction(idRef.current)
  }, [action.name, action.description, JSON.stringify(action.parameters), ...dependencies])
}
```

#### 5. CopilotRuntimeClient (`packages/runtime-client-gql/src/client/CopilotRuntimeClient.ts`)

Handles communication with the backend:

```typescript
class CopilotRuntimeClient {
  client: Client  // urql GraphQL client

  generateCopilotResponse({ data, properties, signal }) {
    // Makes GraphQL mutation with streaming response
    return this.client.mutation(generateCopilotResponseMutation, { data, properties })
  }

  asStream(source) {
    // Converts urql subscription to ReadableStream
    return new ReadableStream({
      start(controller) {
        source.subscribe(({ data, hasNext, error }) => {
          if (error) controller.error(error)
          else {
            controller.enqueue(data)
            if (!hasNext) controller.close()
          }
        })
      }
    })
  }
}
```

---

## Communication Protocol (AG-UI)

### Event Flow Diagram

```
Frontend                              Backend                              LLM
   │                                     │                                  │
   │ ─── POST /graphql ────────────────► │                                  │
   │     (messages, actions, context)    │                                  │
   │                                     │ ─── Stream Request ────────────► │
   │                                     │                                  │
   │                                     │ ◄─── TextMessageStart ────────── │
   │ ◄─── SSE: TextMessageStart ──────── │                                  │
   │                                     │                                  │
   │                                     │ ◄─── TextMessageContent ──────── │
   │ ◄─── SSE: TextMessageContent ────── │     (token by token)             │
   │     (update UI progressively)       │                                  │
   │                                     │                                  │
   │                                     │ ◄─── TextMessageEnd ───────────  │
   │ ◄─── SSE: TextMessageEnd ────────── │                                  │
   │                                     │                                  │
   │                                     │ ◄─── ActionExecutionStart ────── │
   │ ◄─── SSE: ActionExecutionStart ──── │     (tool_call)                  │
   │                                     │                                  │
   │                                     │ ◄─── ActionExecutionArgs ─────── │
   │ ◄─── SSE: ActionExecutionArgs ───── │     (arguments JSON)             │
   │                                     │                                  │
   │                                     │ ◄─── ActionExecutionEnd ──────── │
   │ ◄─── SSE: ActionExecutionEnd ────── │                                  │
   │                                     │                                  │
   │  [If Backend Action]                │                                  │
   │                                     │ ─── Execute Handler ───────────► │
   │                                     │ ◄─── Result ────────────────────  │
   │ ◄─── SSE: ActionExecutionResult ─── │                                  │
   │                                     │                                  │
   │  [If Frontend Action]               │                                  │
   │  Execute locally                    │                                  │
   │  (no result from backend)           │                                  │
   │                                     │                                  │
   │ ◄─── SSE: RUN_FINISHED ───────────  │                                  │
```

### Event Type Mapping

| CopilotKit Internal | AG-UI Protocol | Description |
|---------------------|----------------|-------------|
| TextMessageStart | TEXT_MESSAGE_START | Start of assistant text message |
| TextMessageContent | TEXT_MESSAGE_CONTENT | Text content delta (streaming) |
| TextMessageEnd | TEXT_MESSAGE_END | End of text message |
| ActionExecutionStart | TOOL_CALL_START | Start of tool/action call |
| ActionExecutionArgs | TOOL_CALL_ARGS | Tool arguments (streaming) |
| ActionExecutionEnd | TOOL_CALL_END | End of tool call definition |
| ActionExecutionResult | TOOL_CALL_RESULT | Result of backend tool execution |
| AgentStateMessage | STATE_SNAPSHOT | Agent state update (CoAgents) |
| MetaEvent | CUSTOM | Custom meta events (interrupts, etc.) |
| RunError | RUN_ERROR | Error during execution |

---

## MVP Implementation Requirements

### Essential Components for MVP

#### Backend (Python/FastAPI)

1. **HTTP Endpoint** (`/chat` or `/graphql`)
   - Accept POST requests with messages and frontend tools
   - Return SSE stream

2. **LLM Integration**
   - OpenAI-compatible API (or any provider)
   - Handle tool/function calling

3. **Event Streaming**
   - Implement AG-UI event types:
     - `TEXT_MESSAGE_START/CONTENT/END`
     - `TOOL_CALL_START/ARGS/END`
     - `TOOL_CALL_RESULT` (for backend tools only)
     - `RUN_STARTED/FINISHED`

4. **Tool Handling**
   - Receive frontend tool definitions from request
   - Execute backend tools and return results
   - For frontend tools: stream call info only, no execution

#### Frontend (React)

1. **Context Provider**
   - Store actions, messages, loading state
   - API configuration

2. **useChat Hook**
   - Send messages to backend
   - Process SSE stream
   - Update messages state
   - Execute frontend actions

3. **useAction Hook**
   - Register frontend-executable tools
   - Provide to backend as available tools

4. **Chat UI Components**
   - Message list
   - Input area
   - Loading indicators

### What to Skip (Bloat)

1. **GraphQL Layer** - Use simple REST + SSE instead
2. **CoAgents/LangGraph Integration** - Complex agent orchestration
3. **Cloud Features** - Guardrails, analytics, etc.
4. **MCP (Model Context Protocol)** - External tool servers
5. **Multiple Service Adapters** - Start with one LLM provider
6. **Complex Error Handling** - Start simple
7. **Telemetry/Analytics** - Not needed for MVP
8. **Document Context** - Text context is enough
9. **Suggestions System** - Nice to have, not essential
10. **renderAndWait** - HITL patterns can be added later

### Minimal Data Structures

```typescript
// Message Types
interface Message {
  id: string
  role: "user" | "assistant" | "tool"
  content: string
}

interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

interface ToolResult {
  toolCallId: string
  result: string
}

// Action/Tool Definition
interface Tool {
  name: string
  description: string
  parameters: JSONSchema
  handler?: (args: any) => Promise<string>  // Only for frontend tools
}

// AG-UI Events
interface AGUIEvent {
  type: EventType
  // Event-specific fields
}

enum EventType {
  RUN_STARTED = "RUN_STARTED",
  RUN_FINISHED = "RUN_FINISHED",
  TEXT_MESSAGE_START = "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END = "TEXT_MESSAGE_END",
  TOOL_CALL_START = "TOOL_CALL_START",
  TOOL_CALL_ARGS = "TOOL_CALL_ARGS",
  TOOL_CALL_END = "TOOL_CALL_END",
  TOOL_CALL_RESULT = "TOOL_CALL_RESULT",
}
```

### Simplified Architecture for MVP

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React)                         │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │  ChatContext │    │  useChat     │    │  useAction       │   │
│  │  - messages  │◄───│  - send      │    │  - register tool │   │
│  │  - actions   │    │  - stream    │    │  - execute tool  │   │
│  │  - loading   │    │  - execute   │    │                  │   │
│  └──────────────┘    └──────────────┘    └──────────────────┘   │
│         │                   │                                    │
│         ▼                   ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    fetch() + EventSource                  │   │
│  │                    (SSE Streaming)                        │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ POST /chat (SSE response)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND (FastAPI)                           │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    /chat endpoint                         │   │
│  │  1. Parse request (messages, tools)                       │   │
│  │  2. Call LLM with tools                                   │   │
│  │  3. Stream AG-UI events                                   │   │
│  │  4. Execute backend tools, return results                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              OpenRouter / OpenAI API                      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Summary

### Core Concepts to Implement

1. **SSE Streaming** with AG-UI event types
2. **Frontend vs Backend Tool Distinction**
   - Frontend: Stream call info, execute locally
   - Backend: Execute on server, return result
3. **Message State Management** in React context
4. **Tool Registration** via hooks
5. **Automatic Follow-up** after tool execution

### Key Files to Study

| Component | File |
|-----------|------|
| Backend Runtime | `packages/runtime/src/lib/runtime/copilot-runtime.ts` |
| Event Types | `packages/runtime/src/service-adapters/events.ts` |
| Frontend Context | `packages/react-core/src/context/copilot-context.tsx` |
| Chat Hook | `packages/react-core/src/hooks/use-chat.ts` |
| Action Hook | `packages/react-core/src/hooks/use-copilot-action.ts` |
| Runtime Client | `packages/runtime-client-gql/src/client/CopilotRuntimeClient.ts` |

This architecture document should provide a solid foundation for implementing an MVP that captures the essential functionality of CopilotKit without the enterprise complexity.
