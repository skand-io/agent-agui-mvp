---
date: 2025-12-18T00:00:00-08:00
researcher: Claude
git_commit: 9904d784866659a54325dda02361a0ee16e832bd
branch: feat/integrate-speckit
repository: minimal-chat
topic: "Tool Call System Race Conditions and Enhancement Strategy"
tags: [research, codebase, tools, race-conditions, ag-ui, sse]
status: complete
last_updated: 2025-12-18
last_updated_by: Claude
---

# Research: Tool Call System Race Conditions and Enhancement Strategy

**Date**: 2025-12-18
**Researcher**: Claude
**Git Commit**: 9904d784866659a54325dda02361a0ee16e832bd
**Branch**: feat/integrate-speckit
**Repository**: minimal-chat

## Research Question

How does the existing tool call system work, and how can we enhance it such that it can do both FE and BE tool calls and have them wait on each other without race conditions?

## Summary

The current implementation has a **fundamental architectural race condition**: the backend does NOT wait for frontend tool execution results before completing the run. Additionally, there are several secondary race conditions in the frontend event processing loop related to state management and async tool execution. The system uses a recursive follow-up mechanism to chain tool calls, but this approach has limitations when mixing FE and BE tools.

**Key Findings:**
1. Backend executes tools AFTER LLM streaming completes (sequential, correct)
2. Frontend tools execute synchronously in the SSE event handler (blocks stream processing)
3. No mechanism exists for frontend to POST tool results back to backend
4. Follow-up mechanism uses auto-recursive calls rather than proper synchronization
5. Comprehensive race condition documentation exists at `docs/FE_BE_TOOL_RACE_CONDITION.md`

## Detailed Findings

### 1. Backend Tool Execution Flow

**Location: `backend/server.py:962-1018`**

The backend executes tools in a sequential loop AFTER all LLM streaming completes:

```
Stream Flow:
1. RUN_STARTED event (line 813)
2. STEP_STARTED: "llm_inference" (line 820)
3. [LLM STREAMING] - TEXT and TOOL_CALL events (lines 825-954)
4. STEP_FINISHED: "llm_inference" (line 957)
5. [BACKEND TOOLS EXECUTE] - Sequential loop (lines 971-1008)
   - TOOL_CALL_END (line 976)
   - handler(**args) execution (line 985)
   - TOOL_CALL_RESULT (line 993)
6. RUN_FINISHED event (line 1030)
```

**Critical Gap** (`server.py:1009-1011`):
```python
else:
    # Frontend tools: no result from server (client executes them)
    logger.info(f"Frontend tool: {tool_name} (client will execute)")
```

Frontend tools are logged but the backend **does not wait** for results.

### 2. Frontend Tool Execution Flow

**Location: `frontend/src/hooks/useChat.ts:510-623`**

Frontend tools execute in the `TOOL_CALL_END` event handler:

```typescript
// Line 510-526: TOOL_CALL_END case
case EventType.TOOL_CALL_END: {
  if (!event.toolCallId) break;
  const toolCall = toolCalls[event.toolCallId];

  // Line 529-530: Lookup registered actions
  const contextAction = actions.get(toolCall.name);
  const staticTool = FRONTEND_TOOLS[toolCall.name];

  // Line 535: Execute and await handler
  const result = await Promise.resolve(contextAction.handler(args));

  // Line 554-555: Return execution indicator
  return { frontendToolExecuted: true, ... };
}
```

**Issue**: Frontend tool handlers are awaited inside the SSE event processing loop, blocking all subsequent event processing until the handler completes.

### 3. Follow-Up Mechanism (Auto-Recursive)

**Location: `frontend/src/hooks/useChat.ts:73-183`**

The follow-up system uses recursive calls to `sendMessageInternal`:

```typescript
// Line 174-179: Trigger condition
const shouldFollowUp =
  (frontendToolExecuted && toolAction && !toolAction.disableFollowUp) ||
  backendToolExecuted;

if (shouldFollowUp) {
  return sendMessageInternal(updatedMessages, depth + 1);
}
```

- **Depth limiting**: `MAX_FOLLOW_UP_DEPTH = 5` (line 19)
- **Message accumulation**: All previous messages passed to follow-up (line 179)
- **Flag tracking**: `frontendToolExecuted` and `backendToolExecuted` flags (lines 119-120)

### 4. Critical Race Conditions Identified

#### Race Condition #1: Backend Doesn't Wait for Frontend Results

**Severity: CRITICAL**
**Location**: `backend/server.py:1009-1011`

The backend emits `RUN_FINISHED` immediately after emitting `TOOL_CALL_END` for frontend tools, without waiting for execution results. This means:
- Frontend tool results are LOST
- LLM cannot incorporate frontend tool output
- Chained tool calls break when mixing FE/BE tools

#### Race Condition #2: Stale Closure on `updatedMessages`

**Severity: HIGH**
**Location**: `frontend/src/hooks/useChat.ts:118, 152-156`

```typescript
let updatedMessages = [...currentMessages]; // Line 118

// Callback captures updatedMessages in closure (line 152-156)
(newMsgs) => {
  updatedMessages = newMsgs;
  setMessages(newMsgs);
},
```

If multiple `TOOL_CALL_END` events fire quickly, they reference the same stale `updatedMessages` value.

#### Race Condition #3: Frontend Tool Blocks Event Loop

**Severity: HIGH**
**Location**: `frontend/src/hooks/useChat.ts:535`

```typescript
const result = await Promise.resolve(contextAction.handler(args));
```

While awaiting, network chunks continue arriving but are NOT processed until await completes. This can cause:
- Event ordering issues
- Buffered events piling up
- Message state inconsistencies

#### Race Condition #4: Static Tool Handlers Not Awaited

**Severity: MEDIUM**
**Location**: `frontend/src/hooks/useChat.ts:577-599`

```typescript
const result = staticTool.handler(args); // NOT awaited!
```

Static tool handlers are called WITHOUT `await Promise.resolve()`. If handler is async, result is a Promise, not the actual value.

#### Race Condition #5: `lastAssistantMessageId` Persistence

**Severity: MEDIUM**
**Location**: `frontend/src/hooks/useChat.ts:116, 150`

```typescript
let lastAssistantMessageId: string | null = null; // Persists across events
```

If multiple `TEXT_MESSAGE_START` events arrive (reordering), tool calls might attach to the wrong assistant message.

### 5. Existing Documentation

A comprehensive race condition analysis exists at:
**`docs/FE_BE_TOOL_RACE_CONDITION.md`** (524 lines)

This document includes:
- Sequence diagrams showing broken vs. correct flow
- CopilotKit architecture analysis (uses RxJS observables)
- Known CopilotKit GitHub issues (#1499, #2011, #2587, #2684)
- Implementation plan for fix

## Code References

| Component | File | Lines | Description |
|-----------|------|-------|-------------|
| Backend tool execution | `backend/server.py` | 979-1008 | Sequential tool execution after LLM stream |
| Frontend tool gap | `backend/server.py` | 1009-1011 | No wait for frontend tool results |
| Tool definitions | `backend/server.py` | 543-606 | BACKEND_TOOLS dictionary |
| Event handler | `frontend/src/hooks/useChat.ts` | 433-736 | handleEventWithContext function |
| TOOL_CALL_END | `frontend/src/hooks/useChat.ts` | 510-623 | Frontend tool execution |
| Follow-up mechanism | `frontend/src/hooks/useChat.ts` | 173-179 | Auto-recursive follow-up |
| Message attachment | `frontend/src/hooks/useChat.ts` | 262-327 | attachToolCallToAssistant function |
| Todo list tracking | `frontend/src/hooks/useChat.ts` | 373-425 | getCurrentTodoList and related |
| Action registration | `frontend/src/hooks/useCopilotAction.ts` | 13-44 | Dynamic action registration |
| Context provider | `frontend/src/context/CopilotContext.tsx` | 14-87 | Action registry management |

## Architecture Insights

### Current Architecture (Problematic)

```
User Message
    │
    ▼
┌───────────────────┐
│  Backend Server   │
│  (server.py)      │
├───────────────────┤
│ 1. LLM Streaming  │◄── TEXT_MESSAGE, TOOL_CALL_START/ARGS events
│ 2. Backend Tools  │◄── TOOL_CALL_END, TOOL_CALL_RESULT for BE tools
│ 3. Frontend Tools │◄── TOOL_CALL_END only, NO WAIT for result
│ 4. RUN_FINISHED   │◄── Completes immediately
└───────────────────┘
    │
    ▼
┌───────────────────┐
│  Frontend Client  │
│  (useChat.ts)     │
├───────────────────┤
│ 1. Parse SSE      │
│ 2. Execute FE tool│◄── Result generated but nowhere to send!
│ 3. Auto follow-up │◄── New request, but FE result lost
└───────────────────┘
```

### Proposed Architecture (From docs/FE_BE_TOOL_RACE_CONDITION.md)

```
User Message
    │
    ▼
┌───────────────────┐           ┌───────────────────┐
│  Backend Server   │           │  Frontend Client  │
├───────────────────┤           ├───────────────────┤
│ 1. LLM Streaming  │──events──▶│ 1. Parse SSE      │
│ 2. Backend Tools  │           │                   │
│ 3. TOOL_CALL_END  │──────────▶│ 2. Execute FE tool│
│    (for FE tool)  │           │    │              │
│ 4. WAIT with      │◄──POST────│ 3. POST /tool_result
│    asyncio.Event  │           │                   │
│ 5. Continue       │──events──▶│ 4. Receive more   │
│ 6. RUN_FINISHED   │           │                   │
└───────────────────┘           └───────────────────┘
```

Key changes:
1. Add `/tool_result` POST endpoint to backend
2. Backend tracks pending tool calls with `asyncio.Event`
3. Backend waits (with timeout) for frontend result
4. Frontend POSTs results after execution
5. Remove auto-follow-up; let backend continue the stream

### CopilotKit Patterns (Reference)

CopilotKit uses:
- **RxJS observables** for event streaming (not async/await)
- **`concatMap()`** for sequential backend tool execution
- **HTTP POST callback** for frontend tool results
- **Known limitations** documented in multiple GitHub issues

## Open Questions

1. **Timeout Strategy**: What happens when frontend tool takes too long? (10s timeout proposed)
2. **Error Handling**: How to handle frontend tool execution errors?
3. **Parallelism**: Should multiple frontend tools execute in parallel or sequentially?
4. **State Recovery**: If backend times out, how does frontend recover?
5. **Testing**: How to test race conditions reliably in E2E tests?

## Related Research

- `docs/FE_BE_TOOL_RACE_CONDITION.md` - Comprehensive analysis and implementation plan
- `docs/copilotkit-vs-posthog.md` - Architecture comparison documentation
- CopilotKit GitHub Issues: #1499, #2011, #2587, #2684, #2567

## Recommended Next Steps

1. **Implement `/tool_result` endpoint** in `backend/server.py`
2. **Add pending tool tracking** with `asyncio.Event` per tool call
3. **Modify frontend** to POST results after tool execution
4. **Remove auto-follow-up** mechanism; let backend drive continuation
5. **Add proper timeout handling** with RUN_ERROR on timeout
6. **Fix secondary race conditions** in `useChat.ts`:
   - Use functional state updates instead of closures
   - Extract frontend tool execution outside event loop
   - Add event ordering validation
