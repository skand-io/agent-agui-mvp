---
date: 2025-12-28T00:00:00-08:00
researcher: Claude
git_commit: 9904d784866659a54325dda02361a0ee16e832bd
branch: feat/integrate-fe-and-be-tool-coordination
repository: minimal-chat
topic: "PostHog HogAI UI Thoughts/Reasoning Display"
tags: [research, codebase, ui, streaming, reasoning, posthog]
status: complete
last_updated: 2025-12-28
last_updated_by: Claude
---

# Research: PostHog HogAI UI Thoughts/Reasoning Display

**Date**: 2025-12-28
**Researcher**: Claude
**Git Commit**: 9904d784866659a54325dda02361a0ee16e832bd
**Branch**: feat/integrate-fe-and-be-tool-coordination
**Repository**: minimal-chat

## Research Question

How does PostHog's HogAI show in the UI what its thoughts are?

## Summary

PostHog displays AI thoughts through a multi-layered system:

1. **Thinking Messages**: Playful random verbs ("Booping...", "Pondering...") during loading, plus actual LLM reasoning from `message.meta.thinking`
2. **Update Events**: Real-time streaming of tool progress via `UpdateAction` → `AssistantUpdateEvent`
3. **Visual Components**: `ReasoningAnswer` (brain icon, collapsible) and `AssistantActionComponent` (shimmer animation, substeps)
4. **Status Tracking**: `pending → in_progress → completed/failed` with visual indicators

## Detailed Findings

### 1. Thinking Message Types

**File**: `frontend/src/queries/schema/schema-assistant-messages.ts:121-142`

Thinking is stored in the `meta.thinking` array of `AssistantMessage`:

```typescript
interface AssistantMessageMetadata {
    form?: AssistantForm
    thinking?: Record<string, unknown>[]  // Array of thinking blocks
}

interface AssistantMessage extends BaseAssistantMessage {
    type: AssistantMessageType.Assistant  // 'ai', NOT 'ai/reasoning'
    content: string
    meta?: AssistantMessageMetadata
    tool_calls?: AssistantToolCall[]
}
```

Two thinking formats supported:
- `{ type: 'thinking', thinking: string }` - Direct thinking text
- `{ type: 'reasoning', summary: Array<{text: string}> }` - Reasoning model output

### 2. Random Thinking Messages (Loading State)

**File**: `frontend/src/scenes/max/utils/thinkingMessages.ts:1-112`

90+ playful verb phrases for loading states:

```typescript
const THINKING_VERBS = [
    "Booping", "Crunching", "Digging", "Fetching", "Inferring",
    "Pondering", "Spelunking", "Grokking", "Musing", "Noodling"...
]

export function getRandomThinkingMessage(): string {
    return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)] + "..."
}
```

**Usage** (`maxThreadLogic.tsx:715-758`):
```typescript
if (threadLoading && shouldAddThinkingMessage) {
    const thinkingMessage: AssistantMessage = {
        type: AssistantMessageType.Assistant,
        content: '',
        id: 'loader',
        meta: {
            thinking: [{
                type: 'thinking',
                thinking: getRandomThinkingMessage(),  // "Pondering..."
            }],
        },
    }
    processedThread.push(thinkingMessage)
}
```

### 3. Backend Streaming Architecture

**File**: `ee/hogai/utils/dispatcher.py:78-80`

Tools emit progress via the dispatcher:

```python
def update(self, content: str):
    """Dispatch a transient update message to the stream."""
    self.dispatch(UpdateAction(content=content))
```

**File**: `ee/hogai/chat_agent/stream_processor.py:205-224`

Updates are bound to tool calls:

```python
def _handle_update_message(self, event, action: UpdateAction) -> AssistantUpdateEvent | None:
    # Find the closest tool call id to the update
    parent_path = next((path for path in reversed(event.node_path) if path.tool_call_id), None)

    return AssistantUpdateEvent(
        id=message_id,
        tool_call_id=tool_call_id,
        content=action.content
    )
```

**Constraint**: Reasoning messages limited to 200 characters (`ee/hogai/utils/state.py:86-94`).

### 4. Frontend Event Handling

**File**: `frontend/src/scenes/max/maxThreadLogic.tsx:1011-1017`

Update events accumulate in a map:

```typescript
// Event types
enum AssistantEventType {
    Status = 'status',
    Message = 'message',
    Update = 'update'  // ← Progress updates
}

// Handling
setToolCallUpdate: (toolCallId: string, content: string) => {
    const existingUpdates = values.toolCallUpdateMap.get(toolCallId) || []
    if (!existingUpdates.includes(content)) {
        existingUpdates.push(content)
        values.toolCallUpdateMap.set(toolCallId, existingUpdates)
    }
}
```

### 5. Visual Components

#### ReasoningAnswer (Brain Icon)

**File**: `frontend/src/scenes/max/Thread.tsx:907-933`

```typescript
function ReasoningAnswer({ content, completed, id, animate }: ReasoningAnswerProps) {
    return (
        <AssistantActionComponent
            id={id}
            content={completed ? 'Thought' : content}  // Collapsed label vs full text
            substeps={completed ? [content] : []}       // Expandable when done
            state={completed ? ExecutionStatus.Completed : ExecutionStatus.InProgress}
            icon={<IconBrain />}
            animate={animate}
        />
    )
}
```

#### AssistantActionComponent (Base Progress Display)

**File**: `frontend/src/scenes/max/Thread.tsx:793-905`

```typescript
interface Props {
    content: string
    substeps: string[]
    state: 'pending' | 'in_progress' | 'completed' | 'failed'
    icon: ReactNode
    animate?: boolean
}

// Visual states:
// - Pending: muted text, no icon
// - In Progress: shimmering icon, "..." appended, auto-expanded
// - Completed: green checkmark, collapsed
// - Failed: red X icon, collapsed
```

#### ShimmeringContent (Animation)

**File**: `frontend/src/scenes/max/Thread.tsx:753-782`

```typescript
function ShimmeringContent({ children }) {
    return (
        <span style={{
            backgroundImage: 'linear-gradient(in oklch 90deg, var(--text-3000), var(--muted-3000), var(--trace-3000), var(--muted-3000), var(--text-3000))',
            backgroundSize: '200% 100%',
            animation: 'shimmer 3s linear infinite',
            WebkitBackgroundClip: 'text',
            color: 'transparent',
        }}>
            {children}
        </span>
    )
}
```

### 6. Tool Progress with Substeps

**File**: `frontend/src/scenes/max/Thread.tsx:935-1036`

Tool calls display with streaming substeps:

```typescript
function ToolCallsAnswer({ toolCalls, threadLoading }) {
    return toolCalls.map(toolCall => (
        <AssistantActionComponent
            content={getToolDescription(toolCall)}
            substeps={toolCall.updates || []}  // Streamed from UpdateEvents
            state={toolCall.status}
            icon={toolDefinition.icon}
        />
    ))
}
```

Substeps render with staggered animation:

```typescript
{substeps.map((substep, idx) => (
    <div
        key={idx}
        className="animate-fade-in"
        style={{ animationDelay: `${idx * 50}ms` }}
    >
        {substep}
    </div>
))}
```

### 7. Planning Progress (Task List)

**File**: `frontend/src/scenes/max/Thread.tsx:672-751`

```typescript
function PlanningAnswer({ steps }) {
    const completed = steps.filter(s => s.status === 'completed').length
    const total = steps.length

    return (
        <div>
            <span>Planning ({completed}/{total})</span>
            {steps.map(step => (
                <div>
                    <Checkbox checked={step.status === 'completed'} />
                    {step.description}
                    {step.status === 'in_progress' && <span>in progress</span>}
                </div>
            ))}
        </div>
    )
}
```

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ BACKEND                                                         │
│                                                                 │
│  Tool Execution                                                 │
│       │                                                         │
│       ▼                                                         │
│  dispatcher.update("Analyzing data...")  ──────────────────┐   │
│       │                                                     │   │
│       ▼                                                     ▼   │
│  UpdateAction(content="Analyzing data...")  →  Redis Stream    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ SSE
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                        │
│                                                                 │
│  eventsource-parser                                             │
│       │                                                         │
│       ▼                                                         │
│  AssistantEventType.Update                                      │
│       │                                                         │
│       ▼                                                         │
│  toolCallUpdateMap.set(toolCallId, [...updates, newContent])   │
│       │                                                         │
│       ▼                                                         │
│  AssistantActionComponent                                       │
│  ├─ content: "Searching recordings"                             │
│  ├─ substeps: ["Analyzing data...", "Found 15 matches"]        │
│  ├─ state: "in_progress"                                        │
│  └─ icon: <ShimmeringContent><IconSearch /></ShimmeringContent> │
└─────────────────────────────────────────────────────────────────┘
```

## Code References

- `frontend/src/scenes/max/utils/thinkingMessages.ts:1-112` - Random thinking verbs
- `frontend/src/scenes/max/Thread.tsx:907-933` - ReasoningAnswer component
- `frontend/src/scenes/max/Thread.tsx:793-905` - AssistantActionComponent
- `frontend/src/scenes/max/Thread.tsx:753-782` - ShimmeringContent animation
- `frontend/src/scenes/max/maxThreadLogic.tsx:715-758` - Thinking message injection
- `frontend/src/scenes/max/maxThreadLogic.tsx:1011-1017` - Update event handling
- `frontend/src/queries/schema/schema-assistant-messages.ts:121-142` - Message schema
- `ee/hogai/utils/dispatcher.py:78-80` - Backend update dispatch
- `ee/hogai/chat_agent/stream_processor.py:205-224` - Update → Event conversion
- `ee/hogai/utils/state.py:86-94` - 200 char limit on reasoning

## Key Implementation Patterns

1. **Thinking is metadata, not a message type**: Stored in `message.meta.thinking`, not as separate `ReasoningMessage`

2. **Updates are tool-bound**: Each `UpdateEvent` has a `tool_call_id` linking it to the executing tool

3. **Substeps accumulate**: `Map<tool_call_id, string[]>` grows with each update, preventing duplicates

4. **Status is computed client-side**: Derived from message completion state, not sent from backend

5. **Animations are CSS-based**: Shimmer gradient + fade-in with staggered delays

6. **Graceful degradation**: Random "Pondering..." shown if no actual thinking content available

## Open Questions

1. How are thinking messages cleared when a new response starts?
2. Is there rate limiting on UpdateEvents to prevent UI thrashing?
3. How do reasoning models (o1, etc.) integrate their native thinking output?
