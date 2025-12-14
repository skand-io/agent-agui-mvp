# Research: Multi-Agent Chatbot with Dynamic Mode Selection

**Feature**: 001-multi-agent-chatbot
**Date**: 2025-12-14
**Status**: Complete

## Research Areas

This document captures research findings and architectural decisions for implementing the multi-agent chatbot system.

---

## 1. AG-UI Protocol Event Types

### Decision
Use the standard AG-UI protocol events as defined in pydantic-ai-slim[ag-ui] with extensions for mode switching and context injection.

### Rationale
- The existing codebase already implements AG-UI protocol via SSE
- AG-UI provides standardized events: `RUN_STARTED`, `RUN_FINISHED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_RESULT`
- Extension approach maintains backwards compatibility

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| Custom WebSocket protocol | Adds complexity, existing SSE works well |
| GraphQL subscriptions | Over-engineering for current requirements |

### Implementation Notes
- Extend `TOOL_CALL_RESULT` to include `ui_payload` for frontend artifacts
- Add `MODE_SWITCHED` event type for mode change notifications
- Add `CONTEXT_INJECTED` event for context updates

---

## 2. Tool System Architecture

### Decision
Implement a tool base class (`MaxTool`) with auto-registration, following HogAI patterns with simplifications for this MVP.

### Rationale
- HogAI's `MaxTool` pattern provides proven structure for tool definition
- Auto-registration via `__init_subclass__` reduces boilerplate
- Factory method pattern enables dynamic tool configuration
- Return type `tuple[str, Any]` supports both LLM content and UI artifacts

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| LangChain BaseTool directly | Missing artifact support, no auto-registration |
| Simple function registry | Less type-safe, harder to maintain |
| OpenAI function_call spec only | Doesn't support execution location routing |

### Implementation Notes
```python
class MaxTool(ABC):
    name: str
    description: str
    args_schema: type[BaseModel]
    execution_location: Literal["backend", "frontend"]

    @abstractmethod
    async def execute(self, **kwargs) -> tuple[str, Any]:
        """Returns (content_for_llm, artifact_for_ui)"""
        pass
```

---

## 3. Frontend vs Backend Tool Routing

### Decision
Use `execution_location` field on tool definition to determine routing. Backend tools return `TOOL_CALL_RESULT` with result. Frontend tools emit `TOOL_CALL_*` events without waiting for result.

### Rationale
- Clean separation at definition time, not runtime
- Frontend receives all tool call information in standard events
- Backend executes and returns result inline
- Maintains FR-007: "System MUST NOT wait for frontend tool results"

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| Runtime detection based on tool name prefix | Implicit, error-prone |
| All tools backend with UI updates | Defeats purpose of frontend tools |
| Separate endpoints for frontend/backend tools | Complicates streaming |

### Implementation Notes
- Backend flow: `TOOL_CALL_START` → `TOOL_CALL_ARGS` → execute → `TOOL_CALL_RESULT` → `TOOL_CALL_END`
- Frontend flow: `TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` (no `TOOL_CALL_RESULT` from server)
- Frontend handler receives args and executes locally

---

## 4. Agent Mode System

### Decision
Implement `AgentModeDefinition` dataclass with `AgentModeManager` for lazy node instantiation and cache invalidation on mode switch.

### Rationale
- HogAI pattern provides proven mode management approach
- Lazy instantiation defers expensive setup until needed
- Cache invalidation ensures clean mode transitions
- Mode registry maps mode names to definitions cleanly

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| Single agent with all tools always available | Tool overload confuses LLM |
| Separate agent instances per mode | Complex state synchronization |
| LLM self-selecting tools without modes | Unreliable for specialized tasks |

### Implementation Notes
```python
@dataclass
class AgentModeDefinition:
    mode: str
    description: str
    toolkit_class: type[AgentToolkit]

class AgentModeManager:
    def __init__(self, mode_registry: dict[str, AgentModeDefinition]):
        self._registry = mode_registry
        self._current_mode = "default"
        self._cached_tools = None

    def switch_mode(self, new_mode: str) -> None:
        self._current_mode = new_mode
        self._cached_tools = None  # Invalidate cache
```

---

## 5. Mode Switch Detection

### Decision
Provide a `switch_mode` tool that the LLM can call to change modes. Detection happens in the response processing loop.

### Rationale
- Explicit tool call is clear and traceable
- LLM learns when to switch through tool description
- Processing loop can update mode before next iteration
- Maintains conversation context across switch

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| Keywords in user message | Unreliable, poor UX |
| Classifier model | Added latency, complexity |
| Always ask user | Friction, poor automation |

### Implementation Notes
- `switch_mode` tool has dynamic schema with available mode names
- Tool description includes: when to switch, what each mode offers
- After switch, next LLM call includes mode-specific system prompt
- Context message inserted: "Mode switched to {mode}"

---

## 6. Context Injection Mechanism

### Decision
Frontend sends context via `contextual_tools` field in chat request. Context is injected as system messages before the latest user message.

### Rationale
- Existing AG-UI protocol supports `contextual_tools` for tool context
- Extending this pattern for general context is natural
- System message injection is LLM-agnostic approach
- Frontend controls what context is relevant

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| Separate context endpoint | Additional round-trip |
| Embed in user message | Pollutes user intent |
| Tool that fetches context | Reactive, not proactive |

### Implementation Notes
```typescript
// Frontend sends
{
  messages: [...],
  contextual_tools: {
    ui_context: {
      current_page: "/dashboard",
      selected_item: { id: 123, type: "insight" }
    }
  }
}
```
- Backend formats as: `<context>User is viewing: /dashboard, Selected: insight #123</context>`
- Injected before user message in conversation

---

## 7. State Management Pattern

### Decision
Use immutable state with merge-by-ID message handling, following HogAI's `AssistantState` pattern.

### Rationale
- Merge-by-ID allows updating messages in place (for streaming)
- Immutable updates prevent race conditions
- Clear state flow: full state in, partial state out
- Supports conversation summarization via `ReplaceMessages`

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| Mutable state with locks | Complex, error-prone |
| Event sourcing | Overkill for MVP |
| Simple append-only | Can't update streaming messages |

### Implementation Notes
```python
@dataclass
class ConversationState:
    messages: list[Message]
    agent_mode: str
    context: dict[str, Any]

    def merge(self, partial: PartialState) -> ConversationState:
        """Merge partial state, updating messages by ID"""
        pass
```

---

## 8. Conversation Summarization

### Decision
Implement summarization as a future enhancement. MVP uses context window management with message truncation.

### Rationale
- Full summarization requires additional LLM calls (cost, latency)
- Message truncation handles most practical use cases
- Spec assumes "50+ messages without degradation" - achievable with truncation
- Can add summarization in Phase 2 if needed

### Alternatives Considered
| Alternative | Reason Rejected |
|-------------|-----------------|
| Always summarize | Expensive, adds latency |
| No context management | Would fail at scale |
| External memory store | Over-engineering for MVP |

### Implementation Notes
- Keep last N messages (configurable, default 30)
- Preserve: first message, all tool calls/results, last 10 exchanges
- Mode switch context messages always preserved

---

## 9. Error Handling Strategy

### Decision
Implement three error types following HogAI pattern: Fatal, Transient, Retryable.

### Rationale
- Gives LLM actionable information about errors
- Enables intelligent retry behavior
- Clear categorization helps debugging
- User sees appropriate error messages

### Error Types
| Type | Retry Strategy | Example |
|------|----------------|---------|
| Fatal | Never | Missing API key, permissions |
| Transient | Once, same args | Timeout, rate limit |
| Retryable | With adjusted args | Invalid parameters, syntax error |

### Implementation Notes
```python
class ToolFatalError(Exception): pass
class ToolTransientError(Exception): pass
class ToolRetryableError(Exception): pass
```

---

## 10. Testing Strategy

### Decision
Three-tier testing: unit tests for tools/modes/state, integration tests for flows, e2e tests for user journeys.

### Rationale
- Existing test patterns in codebase provide foundation
- Unit tests catch logic errors early
- Integration tests verify component interaction
- E2e tests ensure user-facing behavior works

### Test Coverage Plan
| Layer | Tools | Target |
|-------|-------|--------|
| Unit | pytest, vitest | Tools, modes, state |
| Integration | pytest | Tool execution, mode switching |
| E2E | Playwright | Full chat flows |

---

## Summary of Decisions

| Area | Decision |
|------|----------|
| Protocol | AG-UI via SSE with extensions |
| Tool Base | MaxTool with auto-registration |
| Tool Routing | `execution_location` field |
| Mode System | AgentModeDefinition + Manager |
| Mode Switch | Explicit `switch_mode` tool |
| Context | System message injection |
| State | Immutable with merge-by-ID |
| Summarization | Truncation MVP, full later |
| Errors | Fatal/Transient/Retryable types |
| Testing | Unit + Integration + E2E |
