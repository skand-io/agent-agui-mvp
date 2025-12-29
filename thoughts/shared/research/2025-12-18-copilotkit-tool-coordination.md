---
date: 2025-12-18T00:00:00-08:00
researcher: Claude
git_commit: 9904d784866659a54325dda02361a0ee16e832bd
branch: feat/integrate-speckit
repository: agent-agui-mvp
topic: "CopilotKit Tool Use and FE/BE Coordination"
tags: [research, codebase, copilotkit, tools, frontend-backend, ag-ui, streaming]
status: complete
last_updated: 2025-12-18
last_updated_by: Claude
---

# Research: CopilotKit Tool Use and FE/BE Coordination

**Date**: 2025-12-18
**Researcher**: Claude
**Git Commit**: 9904d784866659a54325dda02361a0ee16e832bd
**Branch**: feat/integrate-speckit
**Repository**: agent-agui-mvp

## Research Question

How does CopilotKit (in reference_code/CopilotKit-main) handle tool use and coordinate between frontend and backend?

## Summary

CopilotKit implements a sophisticated tool coordination system with:

1. **Two Tool Types**: Frontend tools (executed client-side) and Backend tools (executed server-side)
2. **Streaming Protocol**: SSE-based event streaming via GraphQL with distinct events for tool lifecycle
3. **Action Registration**: React hooks (`useCopilotAction`, `useFrontendTool`) register tools in context
4. **Smart Routing**: Backend detects tool type and either executes + returns result OR streams call info for frontend execution
5. **Result Handling**: Backend tools send `ActionExecutionResult`, frontend tools generate results client-side

## Detailed Findings

### 1. Tool Type System

**File:** `CopilotKit-main/CopilotKit/packages/react-core/src/types/frontend-action.ts`

CopilotKit distinguishes tools via the `available` property:

| Value | Execution Location | Result Source |
|-------|-------------------|---------------|
| `"frontend"` | Client-only | Client generates result |
| `"enabled"` | Backend (default) | Server returns result |
| `"remote"` | Backend (coagents) | Server returns result |
| `"disabled"` | Not available | N/A |

**Key Type Definition (lines 132-166):**
```typescript
interface FrontendAction<T> {
  name: string;
  description: string;
  parameters: Parameter[];
  handler?: (args: T) => Promise<any> | any;
  available?: "disabled" | "enabled" | "remote" | "frontend";
  render?: RenderFunction;
  renderAndWaitForResponse?: RenderAndWaitFunction;
}
```

### 2. Frontend Tool Registration

**File:** `CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-copilot-action.ts`

Tools are registered via React hooks that store them in CopilotContext:

```typescript
// Component usage
useCopilotAction({
  name: "greet",
  description: "Greet the user",
  parameters: [{ name: "name", type: "string" }],
  handler: async ({ name }) => `Hello, ${name}!`,
});
```

**Registration Flow (lines 307-333):**
1. Generate unique ID for action instance
2. Call `setAction(id, action)` to register in context
3. Store render function in `chatComponentsCache`
4. On unmount: call `removeAction(id)` for cleanup

**Frontend-Only Shorthand:**
```typescript
// File: use-frontend-tool.ts (lines 12-18)
useFrontendTool<T>() // Sets available="frontend" automatically
```

### 3. Backend Tool Processing

**File:** `CopilotKit-main/CopilotKit/packages/runtime/src/lib/runtime/copilot-runtime.ts`

The backend receives tools via GraphQL and routes execution:

**Step 1 - Receive Actions (lines 614-620):**
```typescript
const actionInputs = flattenToolCallsNoDuplicates([
  ...serverSideActionsInput,  // Backend-defined tools
  ...clientSideActionsInput.filter(
    (action) => action.available !== ActionInputAvailability.remote
  ),
]);
```

**Step 2 - Send to LLM (lines 630-640):**
All tools sent to LLM for decision-making, regardless of execution location.

**Step 3 - Route Execution (events.ts lines 313-320):**
```typescript
if (event.type === RuntimeEventTypes.ActionExecutionStart) {
  acc.callActionServerSide =
    serverSideActions.find((a) => a.name === event.actionName) !== undefined;
}
```

### 4. Streaming Event Protocol

**File:** `CopilotKit-main/CopilotKit/packages/runtime/src/service-adapters/events.ts`

Tool calls use a 4-event lifecycle:

```
ActionExecutionStart   → Announces tool call beginning
ActionExecutionArgs    → Streams JSON arguments (chunked)
ActionExecutionEnd     → Marks arguments complete
ActionExecutionResult  → Returns result (BACKEND TOOLS ONLY)
```

**Event Types Enum (lines 31-42):**
```typescript
enum RuntimeEventTypes {
  TextMessageStart,
  TextMessageContent,
  TextMessageEnd,
  ActionExecutionStart,
  ActionExecutionArgs,
  ActionExecutionEnd,
  ActionExecutionResult,  // Only for backend tools
  AgentStateMessage,
  MetaEvent,
  RunError,
}
```

### 5. Backend vs Frontend Execution Flow

#### Backend Tool Flow:
```
LLM → ActionExecutionStart → Args → End
           ↓
Backend detects tool in serverSideActions
           ↓
executeAction() calls action.handler()
           ↓
ActionExecutionResult sent to frontend
           ↓
Frontend updates UI with result
```

#### Frontend Tool Flow:
```
LLM → ActionExecutionStart → Args → End
           ↓
Backend detects tool NOT in serverSideActions
           ↓
NO ActionExecutionResult sent
           ↓
Frontend receives ActionExecutionMessage
           ↓
Frontend calls onFunctionCall handler
           ↓
Frontend creates ResultMessage locally
```

### 6. GraphQL Protocol

**File:** `CopilotKit-main/CopilotKit/packages/runtime-client-gql/`

CopilotKit uses GraphQL with streaming extensions:

**Main Mutation:**
```graphql
mutation generateCopilotResponse($data: GenerateCopilotResponseInput!) {
  generateCopilotResponse(data: $data) {
    threadId
    runId
    messages @stream { ... }  # Streaming directive
    metaEvents @stream { ... }
  }
}
```

**Message Types:**
- `TextMessageOutput` - Text content with role
- `ActionExecutionMessageOutput` - Tool call with streamed args
- `ResultMessageOutput` - Tool result (backend or frontend)
- `AgentStateMessageOutput` - Coagent state updates

**Conversion Functions:**
- `aguiToGQL()` - Frontend messages → GraphQL format
- `gqlToAGUI()` - GraphQL messages → Frontend format

### 7. Context and Provider Architecture

**File:** `CopilotKit-main/CopilotKit/packages/react-core/src/components/copilot-provider/copilotkit.tsx`

The CopilotKit provider manages:

```typescript
// State (lines 86-94)
const [actions, setActions] = useState<Record<string, FrontendAction<any>>>({});
const chatComponentsCache = useRef<ChatComponentsCache>({
  actions: {},
  coAgentStateRenders: {},
});
```

**Function Call Handler (lines 577-601):**
```typescript
function entryPointsToFunctionCallHandler(actions: FrontendAction[]) {
  const actionsByName = Object.fromEntries(actions.map(a => [a.name, a]));
  return async ({ name, args }) => {
    const action = actionsByName[name];
    const result = await action.handler?.(args);
    return result;
  };
}
```

### 8. Action Filtering for Backend

**File:** `CopilotKit-main/CopilotKit/packages/react-core/src/types/frontend-action.ts` (lines 175-202)

Before sending to backend, actions are filtered:

```typescript
function processActionsForRuntimeRequest(actions) {
  return actions
    .filter(action =>
      action.available !== "disabled" &&
      action.available !== "frontend" &&  // Exclude frontend-only
      action.name !== "*" &&              // Exclude catch-all
      !action.pairedAction                // Exclude paired actions
    )
    .map(action => ({
      name: action.name,
      description: action.description,
      jsonSchema: actionParametersToJsonSchema(action.parameters),
      available: mapAvailability(action.available),
    }));
}
```

### 9. Human-in-the-Loop (HITL) Actions

**File:** `CopilotKit-main/CopilotKit/packages/react-core/src/hooks/use-copilot-action.ts` (lines 172-272)

Special actions that wait for user input:

```typescript
useCopilotAction({
  name: "confirm",
  renderAndWaitForResponse: ({ args, respond }) => (
    <ConfirmDialog
      message={args.message}
      onConfirm={() => respond(true)}
      onCancel={() => respond(false)}
    />
  ),
});
```

Flow:
1. Action renders interactive UI
2. `respond()` callback resolves promise
3. Result returned to conversation

### 10. Result Message Encoding

**File:** `CopilotKit-main/CopilotKit/packages/runtime/src/graphql/types/converted/index.ts` (lines 59-130)

Results use consistent encoding for success/error:

```typescript
class ResultMessage {
  static encodeResult(result: any, error?: { code, message }): string {
    return JSON.stringify({ result, error });
  }

  static decodeResult(result: string): { result, error? } {
    return JSON.parse(result);
  }
}
```

## Code References

### Frontend (React)
- `packages/react-core/src/hooks/use-copilot-action.ts:155-334` - Action registration hook
- `packages/react-core/src/hooks/use-frontend-tool.ts:12-18` - Frontend tool shorthand
- `packages/react-core/src/hooks/use-chat.ts:733-813` - Action execution loop
- `packages/react-core/src/types/frontend-action.ts:130-202` - Type definitions
- `packages/react-core/src/components/copilot-provider/copilotkit.tsx:577-601` - Handler creation

### Backend (Runtime)
- `packages/runtime/src/lib/runtime/copilot-runtime.ts:497-816` - Request processing
- `packages/runtime/src/service-adapters/events.ts:31-107` - Event types
- `packages/runtime/src/service-adapters/events.ts:277-518` - Event processing
- `packages/runtime/src/graphql/resolvers/copilot.resolver.ts:465-694` - GraphQL streaming

### GraphQL Protocol
- `packages/runtime-client-gql/src/graphql/definitions/mutations.ts:3-130` - Mutations
- `packages/runtime-client-gql/src/message-conversion/agui-to-gql.ts` - AGUI→GQL
- `packages/runtime-client-gql/src/message-conversion/gql-to-agui.ts` - GQL→AGUI

## Architecture Insights

### Design Patterns

1. **Separation of Concerns**: Tools define what they do, system decides where they run
2. **Streaming-First**: All events streamed incrementally for responsiveness
3. **Type Safety**: Full TypeScript types from React to GraphQL
4. **Composable**: Actions can be paired, chained, or rendered

### Key Architectural Decisions

1. **Tool availability as metadata**: Rather than separate registrations, single registration with `available` property
2. **No result for frontend tools**: Backend doesn't wait - just streams call info
3. **GraphQL with streaming**: Uses `@stream` directive for incremental delivery
4. **RxJS on backend**: Reactive event processing enables complex flows
5. **Promise-based HITL**: `renderAndWaitForResponse` elegantly handles user interaction

### Comparison to Our Implementation

| Aspect | CopilotKit | Our MVP |
|--------|------------|---------|
| Protocol | GraphQL + SSE | Pure SSE |
| Tool Types | frontend/enabled/remote/disabled | frontend/backend |
| Streaming | @stream directive | event-stream |
| State | React Context | React hooks |
| Result Encoding | JSON with error wrapper | Simple string |

## Open Questions

1. How does CopilotKit handle tool timeout/cancellation?
2. What happens when frontend tool execution fails mid-stream?
3. How are coagent tools different from regular remote tools?
4. What's the retry strategy for failed tool executions?
