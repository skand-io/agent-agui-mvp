# PostHog vs CopilotKit: Context Implementation Comparison

## Overview

Both PostHog (ee/hogai) and CopilotKit provide mechanisms to give the LLM context about application state, but they take fundamentally different approaches.

---

## CopilotKit Context Implementation

### Architecture: **Client-Side Tree Structure**

```
useCopilotReadable() → Tree (useTree) → printTree() → System Message → LLM
```

### Key Files
- `packages/react-core/src/hooks/use-copilot-readable.ts`
- `packages/react-core/src/hooks/use-tree.ts`
- `packages/react-core/src/components/copilot-provider/copilotkit.tsx`

### How It Works

1. **Simple Hook API**:
```typescript
useCopilotReadable({
  description: "The list of employees",
  value: employees,
  parentId?: string,        // For hierarchy
  categories?: string[],    // For filtering
  available?: "enabled" | "disabled"
});
```

2. **Tree Data Structure**: Uses `useReducer` to maintain a tree of context nodes
```typescript
interface TreeNode {
  id: string;
  value: string;
  children: TreeNode[];
  parentId?: string;
  categories: Set<string>;
}
```

3. **Hierarchical Formatting**: `printTree()` outputs:
```
1. Top-level context
   A. Child context
      a. Grandchild context
2. Another top-level
```

4. **System Message Injection**: Context is embedded in the system prompt:
```typescript
`The user has provided you with the following context:
\`\`\`
${contextString}
\`\`\`
`
```

### Strengths
- Simple React hook API
- Automatic cleanup on unmount
- Hierarchical parent-child relationships
- Category-based filtering
- Client-side only (no backend changes needed)

### Limitations
- All context goes into one system message
- No server-side context enrichment
- No RAG/semantic search
- Static text format only

---

## PostHog (ee/hogai) Context Implementation

### Architecture: **Multi-Layer Server-Side Context Manager**

```
UI Context + RAG + Tool Context + Mode Context → AssistantContextManager → Message Injection → LLM
```

### Key Files
- `ee/hogai/context/context.py` - Core `AssistantContextManager`
- `ee/hogai/context/prompts.py` - Context prompt templates
- `ee/hogai/chat_agent/rag/nodes.py` - RAG context node
- `ee/hogai/tool.py` - Tool context injection

### How It Works

1. **Multiple Context Sources**:

| Layer | Source | Purpose |
|-------|--------|---------|
| UI Context | Client-provided dashboards, insights, events | Current page state |
| RAG Context | Vector search on actions | Semantically relevant data |
| Tool Context | Per-tool configuration | Guide tool usage decisions |
| Mode Context | Agent mode (analytics, replay, etc.) | Behavior steering |
| Billing Context | Subscription info | Feature gating |

2. **Context Manager Class**:
```python
class AssistantContextManager:
    async def get_state_messages_with_context(self, state):
        context_prompts = await self._get_context_messages(state)
        return self._inject_context_messages(state, context_prompts)
```

3. **XML-Structured Formatting**:
```xml
<attached_context>
  <dashboard_context>
    Insight: Monthly Active Users
    Query schema: {...}
    Results: {...}
  </dashboard_context>
  <event_context>
    Event names the user is referring to: "user_signed_up", "page_view"
  </event_context>
</attached_context>
```

4. **Message Injection Strategy**: Context is inserted as separate messages BEFORE the user's first message (not in system prompt)
```python
def _inject_context_messages(self, state, context_messages):
    return insert_messages_before_start(state.messages, context_messages)
```

5. **RAG Integration**: Vector search for semantically relevant actions
```python
class InsightRagContextNode:
    async def arun(self, state):
        # Vector search for relevant actions
        chain = (
            RunnableLambda(self._get_embedding)
            | RunnableLambda(self._search_actions)
            | RunnableLambda(self._retrieve_actions)
        )
```

6. **Tool-Specific Context**: Tools can inject their own context
```python
class MaxTool(BaseTool):
    context_prompt_template: str | None = None

    def format_context_prompt_injection(self, context):
        return self.context_prompt_template.format(**context)
```

### Strengths
- Multi-source context aggregation
- RAG for semantic relevance
- Parallel async execution for performance
- XML structure for clear delineation
- Per-tool context injection
- Mode-aware context switching
- Context deduplication

### Limitations
- More complex architecture
- Requires backend infrastructure
- Heavier server-side processing

---

## Key Differences

| Aspect | CopilotKit | PostHog |
|--------|------------|---------|
| **Location** | Client-side only | Server-side |
| **Storage** | React state (useTree) | Message stream injection |
| **Format** | Hierarchical text (`1. A. a.`) | Structured XML tags |
| **Injection Point** | System message | Separate context messages before user message |
| **Context Sources** | Single (app state) | Multiple (UI, RAG, tools, mode, billing) |
| **RAG Support** | No | Yes (vector search) |
| **Tool Integration** | No | Yes (per-tool context) |
| **Async Processing** | No | Yes (parallel insight execution) |
| **Caching Strategy** | None | Insert before start for prompt caching |
| **Categories** | Yes (filtering) | No (uses XML tags instead) |
| **Hierarchy** | Parent-child tree | Flat with structured XML |

---

## Context Flow Comparison

### CopilotKit Flow
```
Component renders
    ↓
useCopilotReadable({ description, value })
    ↓
addContext() → Tree node created
    ↓
On chat request: getContextString()
    ↓
printTree() formats hierarchically
    ↓
Embedded in system message
    ↓
Sent to LLM in single request
```

### PostHog Flow
```
User sends message
    ↓
AssistantContextManager extracts UI context from message
    ↓
RAG node fetches semantically relevant actions (async)
    ↓
Tool contexts gathered from config
    ↓
Mode context determined from agent state
    ↓
All contexts formatted as XML
    ↓
Context messages injected BEFORE user's first message
    ↓
LangChain graph executes with enriched messages
```

---

## When to Use Each Approach

### Use CopilotKit Style When:
- Building a simple chat assistant
- Context is primarily React component state
- No need for server-side enrichment
- Want quick integration with minimal backend changes

### Use PostHog Style When:
- Building a complex agentic system
- Need RAG for semantic context retrieval
- Have multiple context sources (DB, analytics, etc.)
- Want fine-grained control over context per tool
- Need async parallel context fetching for performance
- Building multi-mode agents with different behaviors

---

## Implementation Recommendations for minimal-chat

The current `useCopilotReadable` implementation follows CopilotKit's pattern. To add PostHog-style features:

1. **Add XML formatting** for clearer context structure
2. **Move context injection to backend** for server-side enrichment
3. **Add per-tool context** via tool definitions
4. **Consider RAG** if you have a large action/event catalog

Current implementation is suitable for the MVP. PostHog's approach is better for enterprise-scale with complex data requirements.
