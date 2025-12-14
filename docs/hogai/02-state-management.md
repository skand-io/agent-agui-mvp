# PostHog HogAI State Management System

## Overview

The PostHog HogAI state management system is built on top of LangGraph's state graph architecture. It provides a sophisticated, type-safe way to manage conversation state across a complex multi-agent system. The system uses **merge-by-ID** message management, custom reducers, and field annotations to enable both incremental updates and complete state replacements.

This document provides sufficient detail to reimplement the entire state management system from scratch.

---

## Table of Contents

1. [Core Architecture](#core-architecture)
2. [State Class Hierarchy](#state-class-hierarchy)
3. [Message Merging Strategy](#message-merging-strategy)
4. [ReplaceMessages Wrapper](#replacemessages-wrapper)
5. [Field Annotations](#field-annotations)
6. [State Fields Reference](#state-fields-reference)
7. [State Update Patterns](#state-update-patterns)
8. [Implementation Examples](#implementation-examples)

---

## Core Architecture

The state management system follows a **dual-state pattern**:

- **`AssistantState`**: The complete state with custom reducers for merging updates
- **`PartialAssistantState`**: The update state returned by nodes (partial updates)

When a node returns a `PartialAssistantState`, LangGraph applies the defined reducers to merge it into the full `AssistantState`.

### Key Principles

1. **Append-only messages by default**: New messages are appended to the conversation
2. **Merge-by-ID for updates**: Messages with matching IDs replace existing messages
3. **Explicit replacement**: The `ReplaceMessages` wrapper bypasses merge logic for conversation compaction
4. **Field-level control**: Annotations (`replace`, `append`) control how individual fields merge

---

## State Class Hierarchy

### 1. BaseState

The foundation class providing reset functionality:

```python
from pydantic import BaseModel
from typing import Self

class BaseState(BaseModel):
    """Base state class with reset functionality."""

    @classmethod
    def get_reset_state(cls) -> Self:
        """Returns a new instance with all fields reset to their default values."""
        return cls(**{k: v.default for k, v in cls.model_fields.items()})
```

**Purpose**: Provides a method to reset all fields to defaults. Useful for clearing state between conversations or debugging.

**Usage**:
```python
reset_state = PartialAssistantState.get_reset_state()
# Returns PartialAssistantState with all fields set to defaults
```

---

### 2. BaseStateWithMessages

Adds message handling and conversation metadata:

```python
from pydantic import Field
from datetime import datetime
from typing import Optional, Literal, Sequence
from posthog.schema import AssistantMessageUnion, AgentMode

class BaseStateWithMessages(BaseState):
    start_id: Optional[str] = Field(default=None)
    """
    The ID of the message from which the conversation started.
    """

    start_dt: Optional[datetime] = Field(default=None)
    """
    The datetime of the start of the conversation. Use this datetime to keep the cache.
    """

    graph_status: Optional[Literal["resumed", "interrupted", ""]] = Field(default=None)
    """
    Whether the graph was interrupted or resumed.
    """

    messages: Sequence[AssistantMessageUnion] = Field(default=[])
    """
    Messages exposed to the user.
    """

    agent_mode: AgentMode | None = Field(default=None)
    """
    The mode of the agent.
    """

    @field_validator("messages", mode="after")
    @classmethod
    def convert_visualization_messages_to_artifacts(
        cls, messages: Sequence[AssistantMessageUnion] | ReplaceMessages[AssistantMessageUnion]
    ) -> Sequence[AssistantMessageUnion] | ReplaceMessages[AssistantMessageUnion]:
        """
        Convert legacy VisualizationMessage to ArtifactRefMessage with State source.
        The original VisualizationMessage is kept in state for content lookup.
        The ArtifactRefMessage's artifact_id references the VisualizationMessage's id.
        """
        # Collect existing ArtifactRefMessage artifact_ids to avoid duplicates
        existing_artifact_ids = {msg.artifact_id for msg in messages if isinstance(msg, ArtifactRefMessage)}

        converted: list[AssistantMessageUnion] = []
        for message in messages:
            converted.append(message)

            if message.id and isinstance(message, VisualizationMessage):
                # Only create ArtifactRefMessage if one doesn't already exist
                if message.id not in existing_artifact_ids:
                    converted.append(
                        ArtifactRefMessage(
                            id=str(uuid.uuid4()),  # Unique ID to avoid deduplication
                            content_type=ArtifactContentType.VISUALIZATION,
                            artifact_id=message.id,  # References the VisualizationMessage ID
                            source=ArtifactSource.STATE,
                        )
                    )

        # Preserve the ReplaceMessages wrapper if present
        if isinstance(messages, ReplaceMessages):
            return ReplaceMessages(converted)

        return converted

    @property
    def agent_mode_or_default(self) -> AgentMode:
        return self.agent_mode or AgentMode.PRODUCT_ANALYTICS
```

**Key Features**:
- **Conversation tracking**: `start_id` and `start_dt` track conversation lifecycle
- **Graph status**: Enables resumption after interruptions
- **Message validation**: Automatically converts legacy message types on assignment
- **ReplaceMessages preservation**: Validator preserves the wrapper type through transformations

---

### 3. BaseStateWithIntermediateSteps

Adds support for agent planning steps:

```python
from langchain_core.agents import AgentAction
from typing import Optional

# Type alias for intermediate steps
IntermediateStep = tuple[AgentAction, Optional[str]]

class BaseStateWithIntermediateSteps(BaseState):
    intermediate_steps: Optional[list[IntermediateStep]] = Field(default=None)
    """
    Actions taken by the query planner agent.
    """
```

**Purpose**: Tracks the reasoning steps of agents (e.g., which tools were considered, validation errors).

**Example**:
```python
# Agent records intermediate steps
state.intermediate_steps = [
    (AgentAction(tool="calculator", tool_input="2+2", log=""), "4"),
    (AgentAction(tool="validator", tool_input="4", log=""), "valid"),
]
```

---

### 4. _SharedAssistantState

The internal shared state class containing all domain-specific fields:

```python
from typing import Annotated

def replace(_: Any | None, right: Any | None) -> Any | None:
    """Reducer that replaces the left value with the right value."""
    return right

def merge_retry_counts(left: int, right: int) -> int:
    """Merges two retry counts by taking the maximum value."""
    return max(left, right)

class _SharedAssistantState(BaseStateWithMessages, BaseStateWithIntermediateSteps):
    """
    The state of the root node.
    """

    plan: Optional[str] = Field(default=None)
    """The insight generation plan."""

    query_planner_previous_response_id: Optional[str] = Field(default=None)
    """The ID of the previous OpenAI Responses API response made by the query planner."""

    query_planner_intermediate_messages: Optional[Sequence[LangchainBaseMessage]] = Field(default=None)
    """The intermediate messages from the query planner agent."""

    onboarding_question: Optional[str] = Field(default=None)
    """A clarifying question asked during the onboarding process."""

    memory_collection_messages: Annotated[Optional[Sequence[LangchainBaseMessage]], replace] = Field(default=None)
    """The messages with tool calls to collect memory in the `MemoryCollectorToolsNode`."""

    root_conversation_start_id: Optional[str] = Field(default=None)
    """The ID of the message to start from to keep the message window short enough."""

    root_tool_call_id: Annotated[Optional[str], replace] = Field(default=None)
    """The ID of the tool call from the root node."""

    root_tool_insight_plan: Optional[str] = Field(default=None)
    """The insight plan to generate."""

    root_tool_insight_type: Optional[str] = Field(default=None)
    """The type of insight to generate."""

    root_tool_calls_count: Annotated[Optional[int], replace] = Field(default=None)
    """Tracks the number of tool calls made by the root node to terminate the loop."""

    rag_context: Optional[str] = Field(default=None)
    """The context for taxonomy agent."""

    query_generation_retry_count: Annotated[int, merge_retry_counts] = Field(default=0)
    """Tracks the number of times the query generation has been retried."""

    search_insights_query: Optional[str] = Field(default=None)
    """The user's search query for finding existing insights."""

    session_summarization_query: Optional[str] = Field(default=None)
    """The user's query for summarizing sessions."""

    specific_session_ids_to_summarize: Optional[list[str]] = Field(default=None)
    """List of specific session IDs (UUIDs) to summarize."""

    should_use_current_filters: Optional[bool] = Field(default=None)
    """Whether to use current filters from user's UI to find relevant sessions."""

    summary_title: Optional[str] = Field(default=None)
    """The name of the summary to generate."""

    notebook_short_id: Optional[str] = Field(default=None)
    """The short ID of the notebook being used."""

    dashboard_name: Optional[str] = Field(default=None)
    """The name of the dashboard to be created."""

    selected_insight_ids: Optional[list[int]] = Field(default=None)
    """The selected insights to be included in the dashboard."""

    search_insights_queries: Optional[list[InsightQuery]] = Field(default=None)
    """The user's queries to search for insights."""

    dashboard_id: Optional[int] = Field(default=None)
    """The ID of the dashboard to be edited."""

    visualization_title: Optional[str] = Field(default=None)
    """The title of the visualization to be created."""
```

**Important Notes**:
- Fields without `Annotated` use **default merging** (right value overwrites left if not None)
- Fields with `Annotated[T, replace]` **always replace** regardless of None values
- Custom reducers like `merge_retry_counts` provide specialized merge logic

---

### 5. AssistantState (Full State)

The complete state class used by the LangGraph graph:

```python
class AssistantState(_SharedAssistantState):
    messages: Annotated[Sequence[AssistantMessageUnion], add_and_merge_messages] = Field(default=[])
    """
    Messages exposed to the user.
    """
```

**Key Difference**: The `messages` field uses the **`add_and_merge_messages` reducer** instead of simple replacement.

**Usage**: This is the state type passed to the LangGraph `StateGraph`:
```python
from langgraph.graph import StateGraph

graph = StateGraph(AssistantState)
```

---

### 6. PartialAssistantState (Update State)

The partial state class returned by nodes:

```python
class PartialAssistantState(_SharedAssistantState):
    # This must be kept here, so we don't lose type annotation for the ReplaceMessages type.
    messages: ReplaceMessages[AssistantMessageUnion] | list[AssistantMessageUnion] = Field(default=[])
```

**Key Difference**: The `messages` field accepts both regular lists **and** `ReplaceMessages` wrapper.

**Usage**: Nodes return this type:
```python
async def my_node(state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    return PartialAssistantState(
        messages=[AssistantMessage(content="Hello")],
        plan="Generated plan"
    )
```

---

## Message Merging Strategy

### The `add_and_merge_messages` Reducer

This is the core of the message management system. It implements **merge-by-ID** logic:

```python
import uuid
from collections.abc import Sequence

def add_and_merge_messages(
    left_value: Sequence[AssistantMessageUnion], right_value: Sequence[AssistantMessageUnion]
) -> Sequence[AssistantMessageUnion]:
    """Merges two lists of messages, updating existing messages by ID.

    By default, this ensures the state is "append-only", unless the
    new message has the same ID as an existing message.

    Args:
        left_value: The base list of messages (current state).
        right_value: The list of messages to merge into the base list (node update).

    Returns:
        A new list of messages with the messages from `right` merged into `left`.
        If a message in `right` has the same ID as a message in `left`, the
        message from `right` will replace the message from `left`.
    """
    # Coerce to list
    left = list(left_value)
    right = list(right_value)

    # Assign missing IDs
    for m in left:
        if m.id is None:
            m.id = str(uuid.uuid4())
    for m in right:
        if m.id is None:
            m.id = str(uuid.uuid4())

    # Special case: ReplaceMessages bypasses merge logic
    if isinstance(right_value, ReplaceMessages):
        return right

    # Build index of left messages by ID
    left_idx_by_id = {m.id: i for i, m in enumerate(left)}

    # Merge messages
    merged = left.copy()
    for m in right:
        if (existing_idx := left_idx_by_id.get(m.id)) is not None:
            # Replace existing message at same position
            merged[existing_idx] = m
        else:
            # Append new message
            merged.append(m)

    return merged
```

### Merge-by-ID Algorithm

**Step 1: Auto-assign IDs**
- All messages without IDs get a UUID
- This ensures messages can be tracked across updates

**Step 2: Check for ReplaceMessages**
- If `right_value` is a `ReplaceMessages` instance, return `right` immediately
- This bypasses all merge logic

**Step 3: Build ID index**
- Create a map from message ID to position in the left list
- Enables O(1) lookup during merge

**Step 4: Merge logic**
- For each message in `right`:
  - If ID exists in left: **replace** at same position (preserves order)
  - If ID is new: **append** to end of list

### Merge Behavior Examples

#### Example 1: Append new messages

```python
left = [
    AssistantMessage(id="1", content="Hello"),
    AssistantMessage(id="2", content="How are you?"),
]

right = [
    AssistantMessage(id="3", content="I'm doing well"),
]

result = add_and_merge_messages(left, right)
# Result: [
#   AssistantMessage(id="1", content="Hello"),
#   AssistantMessage(id="2", content="How are you?"),
#   AssistantMessage(id="3", content="I'm doing well"),  # Appended
# ]
```

#### Example 2: Update existing message

```python
left = [
    AssistantMessage(id="1", content="Hello"),
    AssistantMessage(id="2", content="Thinking..."),
]

right = [
    AssistantMessage(id="2", content="The answer is 42"),  # Same ID as left[1]
]

result = add_and_merge_messages(left, right)
# Result: [
#   AssistantMessage(id="1", content="Hello"),
#   AssistantMessage(id="2", content="The answer is 42"),  # Replaced
# ]
```

#### Example 3: Mixed append and update

```python
left = [
    AssistantMessage(id="1", content="Hello"),
    AssistantMessage(id="2", content="Thinking..."),
]

right = [
    AssistantMessage(id="2", content="Updated content"),  # Replace
    AssistantMessage(id="3", content="New message"),      # Append
]

result = add_and_merge_messages(left, right)
# Result: [
#   AssistantMessage(id="1", content="Hello"),
#   AssistantMessage(id="2", content="Updated content"),  # Replaced
#   AssistantMessage(id="3", content="New message"),      # Appended
# ]
```

#### Example 4: Auto-assign missing IDs

```python
left = [
    AssistantMessage(content="Message without ID"),
]

right = [
    AssistantMessage(content="Another message without ID"),
]

result = add_and_merge_messages(left, right)
# Result: [
#   AssistantMessage(id="<uuid-1>", content="Message without ID"),
#   AssistantMessage(id="<uuid-2>", content="Another message without ID"),
# ]
# Two messages because IDs are auto-generated and different
```

---

## ReplaceMessages Wrapper

### Purpose

The `ReplaceMessages` wrapper is used to **completely replace** the message list, bypassing the merge-by-ID logic. This is critical for **conversation compaction** (summarization).

### Implementation

```python
from typing import Generic, TypeVar, Any
from pydantic import GetCoreSchemaHandler
from pydantic_core import CoreSchema, core_schema

T = TypeVar("T")

class ReplaceMessages(Generic[T], list[T]):
    """
    Replaces the existing messages with the new messages.
    """

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: GetCoreSchemaHandler) -> CoreSchema:
        def validate_replace_messages(value: Any) -> "ReplaceMessages[T]":
            if isinstance(value, ReplaceMessages):
                return value
            # Don't accept plain lists - let the union fall through to Sequence
            raise ValueError(f"Expected ReplaceMessages, got {type(value)}")

        return core_schema.no_info_plain_validator_function(
            validate_replace_messages,
            serialization=core_schema.plain_serializer_function_ser_schema(list, info_arg=False),
        )
```

**Key Design Decisions**:
1. **Extends `list[T]`**: Can be used like a regular list
2. **Pydantic integration**: Custom validator ensures type preservation
3. **Serializes as list**: JSON output is a plain array
4. **Type safety**: Rejects plain lists in validation (must be explicitly wrapped)

### Use Cases

#### Use Case 1: Conversation Summarization

When the conversation becomes too long (exceeds token limit), summarize old messages and replace the message list:

```python
# Original messages
original_messages = [
    HumanMessage(id="1", content="Tell me about Python"),
    AssistantMessage(id="2", content="Python is..."),
    HumanMessage(id="3", content="What about Django?"),
    AssistantMessage(id="4", content="Django is..."),
    # ... many more messages
]

# Summarize old messages
summary = await summarizer.summarize(original_messages[:-1])

# Replace with summary + last message
summary_message = ContextMessage(
    id=str(uuid4()),
    content=f"Previous conversation summary: {summary}"
)

new_messages = ReplaceMessages([
    summary_message,
    original_messages[-1],  # Keep last message
    # New messages will be appended
])

return PartialAssistantState(messages=new_messages)
```

#### Use Case 2: Reordering Messages

```python
# Reorder messages without triggering merge logic
reordered = ReplaceMessages([
    messages[2],  # New order
    messages[0],
    messages[1],
])

return PartialAssistantState(messages=reordered)
```

### How It Works with the Reducer

```python
def add_and_merge_messages(left_value, right_value):
    # ... ID assignment code ...

    # THIS IS THE KEY CHECK
    if isinstance(right_value, ReplaceMessages):
        return right  # Bypass all merge logic

    # ... merge logic ...
```

The reducer checks the **type** of `right_value`:
- **Plain list**: Apply merge-by-ID logic
- **ReplaceMessages**: Return it directly (complete replacement)

---

## Field Annotations

LangGraph uses Pydantic's `Annotated` type to attach **reducers** to fields. This controls how partial state updates merge into the full state.

### The `replace` Reducer

```python
def replace(_: Any | None, right: Any | None) -> Any | None:
    """Replaces the left value with the right value."""
    return right
```

**Behavior**: Always uses the right value, even if `None`.

**Usage**:
```python
from typing import Annotated

root_tool_call_id: Annotated[Optional[str], replace] = Field(default=None)
```

**Example**:
```python
# State has: root_tool_call_id = "abc-123"
# Node returns: PartialAssistantState(root_tool_call_id=None)
# Result: root_tool_call_id = None  (replaced, not preserved)
```

### The `append` Reducer

```python
def append(left: Sequence, right: Sequence) -> Sequence:
    """Appends the right value to the state field."""
    return [*left, *right]
```

**Behavior**: Concatenates lists.

**Usage**:
```python
task_results: Annotated[list[TaskResult], append] = Field(default=[])
```

**Example**:
```python
# State has: task_results = [result1, result2]
# Node returns: PartialAssistantState(task_results=[result3])
# Result: task_results = [result1, result2, result3]  (appended)
```

### Custom Reducers

You can define custom merge logic:

```python
def merge_retry_counts(left: int, right: int) -> int:
    """Merges two retry counts by taking the maximum value."""
    return max(left, right)

query_generation_retry_count: Annotated[int, merge_retry_counts] = Field(default=0)
```

**Example**:
```python
# State has: query_generation_retry_count = 3
# Node returns: PartialAssistantState(query_generation_retry_count=2)
# Result: query_generation_retry_count = 3  (max of 3 and 2)
```

### Default Merging (No Annotation)

Fields without `Annotated` use LangGraph's default merge behavior:

**Rule**: Right value overwrites left if right is **not None**.

```python
plan: Optional[str] = Field(default=None)
```

**Example**:
```python
# State has: plan = "old plan"
# Node returns: PartialAssistantState(plan="new plan")
# Result: plan = "new plan"  (overwritten)

# State has: plan = "old plan"
# Node returns: PartialAssistantState()  (plan not set, defaults to None)
# Result: plan = "old plan"  (preserved, because right is None)
```

---

## State Fields Reference

### Conversation Metadata

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `start_id` | `Optional[str]` | `None` | None | ID of the message from which the conversation started |
| `start_dt` | `Optional[datetime]` | `None` | None | Datetime of conversation start (for caching) |
| `graph_status` | `Optional[Literal["resumed", "interrupted", ""]]` | `None` | None | Whether the graph was interrupted or resumed |
| `agent_mode` | `AgentMode \| None` | `None` | None | The mode of the agent (e.g., PRODUCT_ANALYTICS) |

### Messages

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `messages` | `Sequence[AssistantMessageUnion]` | `[]` | `add_and_merge_messages` (AssistantState only) | Messages exposed to the user |

### Agent Planning

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `intermediate_steps` | `Optional[list[IntermediateStep]]` | `None` | None | Actions taken by the query planner agent |
| `plan` | `Optional[str]` | `None` | None | The insight generation plan |

### Tool Call Tracking

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `root_tool_call_id` | `Optional[str]` | `None` | `replace` | The ID of the tool call from the root node |
| `root_tool_calls_count` | `Optional[int]` | `None` | `replace` | Number of tool calls made by the root node |
| `root_tool_insight_plan` | `Optional[str]` | `None` | None | The insight plan to generate |
| `root_tool_insight_type` | `Optional[str]` | `None` | None | The type of insight to generate |

### Query Planning

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `query_planner_previous_response_id` | `Optional[str]` | `None` | None | ID of previous OpenAI Responses API response |
| `query_planner_intermediate_messages` | `Optional[Sequence[LangchainBaseMessage]]` | `None` | None | Intermediate messages from query planner |
| `query_generation_retry_count` | `int` | `0` | `merge_retry_counts` | Number of query generation retries |

### Memory & Context

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `memory_collection_messages` | `Optional[Sequence[LangchainBaseMessage]]` | `None` | `replace` | Messages with tool calls to collect memory |
| `onboarding_question` | `Optional[str]` | `None` | None | Clarifying question during onboarding |
| `rag_context` | `Optional[str]` | `None` | None | Context for taxonomy agent |

### Conversation Window Management

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `root_conversation_start_id` | `Optional[str]` | `None` | None | Message ID to start from (for windowing) |

### Insights & Search

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `search_insights_query` | `Optional[str]` | `None` | None | User's search query for insights |
| `search_insights_queries` | `Optional[list[InsightQuery]]` | `None` | None | Multiple user queries for insights |
| `selected_insight_ids` | `Optional[list[int]]` | `None` | None | Insights to include in dashboard |

### Session Summarization

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `session_summarization_query` | `Optional[str]` | `None` | None | User's query for summarizing sessions |
| `specific_session_ids_to_summarize` | `Optional[list[str]]` | `None` | None | Specific session IDs to summarize |
| `should_use_current_filters` | `Optional[bool]` | `None` | None | Whether to use current UI filters |
| `summary_title` | `Optional[str]` | `None` | None | Name of the summary to generate |

### Dashboard & Notebook

| Field | Type | Default | Annotation | Description |
|-------|------|---------|------------|-------------|
| `notebook_short_id` | `Optional[str]` | `None` | None | Short ID of the notebook |
| `dashboard_name` | `Optional[str]` | `None` | None | Name of dashboard to create |
| `dashboard_id` | `Optional[int]` | `None` | None | ID of dashboard to edit |
| `visualization_title` | `Optional[str]` | `None` | None | Title of visualization to create |

---

## State Update Patterns

### Pattern 1: Append New Message

The most common pattern - add a new message to the conversation:

```python
async def my_node(state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    # Generate a response
    response = await model.ainvoke(state.messages)

    # Return partial state with new message
    return PartialAssistantState(
        messages=[AssistantMessage(
            id=str(uuid4()),
            content=response.content
        )]
    )
```

**Result**: Message is appended to `state.messages` via `add_and_merge_messages`.

---

### Pattern 2: Update Existing Message

Update a message that's already in the conversation (e.g., streaming):

```python
async def my_node(state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    # Find the message to update
    message_id = "abc-123"

    # Update its content
    return PartialAssistantState(
        messages=[AssistantMessage(
            id=message_id,  # Same ID as existing message
            content="Updated content"
        )]
    )
```

**Result**: Message with `id="abc-123"` is replaced in-place via `add_and_merge_messages`.

---

### Pattern 3: Replace Message List (Summarization)

Replace the entire message list when compacting the conversation:

```python
async def my_node(state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    # Summarize old messages
    summary = await summarizer.summarize(state.messages[:-1])

    summary_message = ContextMessage(
        id=str(uuid4()),
        content=f"Summary: {summary}"
    )

    # Replace entire message list
    return PartialAssistantState(
        messages=ReplaceMessages([
            summary_message,
            state.messages[-1],  # Keep last user message
        ])
    )
```

**Result**: `state.messages` is completely replaced (no merging).

---

### Pattern 4: Update Multiple Fields

Update both messages and other state fields:

```python
async def my_node(state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    # Generate plan and response
    plan = await planner.generate_plan(state.messages)
    response = await model.ainvoke(state.messages)

    return PartialAssistantState(
        messages=[AssistantMessage(content=response.content)],
        plan=plan,
        root_tool_calls_count=(state.root_tool_calls_count or 0) + 1
    )
```

**Result**:
- `messages`: New message appended
- `plan`: Overwritten
- `root_tool_calls_count`: Replaced (due to `replace` annotation)

---

### Pattern 5: Conditional Field Updates

Only update fields when certain conditions are met:

```python
async def my_node(state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    response = await model.ainvoke(state.messages)

    # Base update
    update = PartialAssistantState(
        messages=[AssistantMessage(content=response.content)]
    )

    # Conditionally update tool call count
    if response.tool_calls:
        update.root_tool_calls_count = (state.root_tool_calls_count or 0) + 1

    return update
```

**Result**: Tool call count only updates if tool calls are present.

---

### Pattern 6: Reset State Fields

Use `replace` annotation to explicitly clear fields:

```python
async def my_node(state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    return PartialAssistantState(
        root_tool_call_id=None,  # Explicitly clear (due to replace annotation)
        memory_collection_messages=None,  # Explicitly clear (due to replace annotation)
    )
```

**Result**: Fields are set to `None` even though they had values.

---

## Implementation Examples

### Example 1: Complete Node Implementation

```python
from langchain_core.runnables import RunnableConfig
from ee.hogai.utils.types import AssistantState, PartialAssistantState
from posthog.schema import AssistantMessage
from uuid import uuid4

class MyAgentNode:
    async def arun(self, state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
        # 1. Access current state
        conversation_history = state.messages
        current_plan = state.plan

        # 2. Generate response using LLM
        model = self._get_model()
        response = await model.ainvoke(conversation_history)

        # 3. Create new message
        assistant_message = AssistantMessage(
            id=str(uuid4()),
            content=response.content,
            tool_calls=response.tool_calls if hasattr(response, 'tool_calls') else None
        )

        # 4. Return partial state update
        return PartialAssistantState(
            messages=[assistant_message],
            root_tool_calls_count=(state.root_tool_calls_count or 0) + 1 if assistant_message.tool_calls else None
        )
```

---

### Example 2: Conversation Summarization Node

```python
from ee.hogai.utils.types import ReplaceMessages
from posthog.schema import ContextMessage
from ee.hogai.utils.conversation_summarizer import AnthropicConversationSummarizer

class SummarizationNode:
    async def arun(self, state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
        # 1. Check if summarization is needed
        token_count = await self._calculate_tokens(state.messages)
        if token_count < 100_000:
            return PartialAssistantState()  # No update needed

        # 2. Summarize old messages (exclude last user message)
        summarizer = AnthropicConversationSummarizer(self._team, self._user)
        summary = await summarizer.summarize(state.messages[:-1])

        # 3. Create summary message
        summary_message = ContextMessage(
            id=str(uuid4()),
            content=f"Previous conversation summary:\n{summary}"
        )

        # 4. Replace message list with summary + last message
        new_messages = ReplaceMessages([
            summary_message,
            state.messages[-1],  # Keep last user message
        ])

        # 5. Update conversation window start ID
        return PartialAssistantState(
            messages=new_messages,
            root_conversation_start_id=summary_message.id
        )
```

---

### Example 3: Tool Execution Node

```python
class ToolExecutionNode:
    async def arun(self, state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
        # 1. Get the last message (should be AssistantMessage with tool calls)
        last_message = state.messages[-1]
        if not isinstance(last_message, AssistantMessage) or not last_message.tool_calls:
            return PartialAssistantState()

        # 2. Execute each tool call
        tool_results = []
        for tool_call in last_message.tool_calls:
            result = await self._execute_tool(tool_call)
            tool_results.append(ToolMessage(
                id=str(uuid4()),
                tool_call_id=tool_call.id,
                content=result
            ))

        # 3. Return tool results as new messages
        return PartialAssistantState(
            messages=tool_results
        )
```

---

### Example 4: LangGraph Integration

```python
from langgraph.graph import StateGraph, END, START
from ee.hogai.utils.types import AssistantState, PartialAssistantState

# 1. Create graph with AssistantState
graph = StateGraph(AssistantState)

# 2. Add nodes (they return PartialAssistantState)
graph.add_node("agent", agent_node.arun)
graph.add_node("tools", tool_node.arun)
graph.add_node("summarizer", summarizer_node.arun)

# 3. Add edges
graph.add_edge(START, "agent")
graph.add_conditional_edges(
    "agent",
    lambda state: "tools" if state.messages[-1].tool_calls else END
)
graph.add_edge("tools", "agent")

# 4. Compile
compiled_graph = graph.compile()

# 5. Execute
result = await compiled_graph.ainvoke({
    "messages": [HumanMessage(content="Hello")],
    "start_dt": datetime.now()
})

# result is AssistantState with all updates merged
```

---

### Example 5: Testing State Merging

```python
import pytest
from ee.hogai.utils.types import AssistantState, PartialAssistantState, add_and_merge_messages
from posthog.schema import AssistantMessage

class TestStateMerging:
    def test_append_new_message(self):
        left = [AssistantMessage(id="1", content="Hello")]
        right = [AssistantMessage(id="2", content="World")]

        result = add_and_merge_messages(left, right)

        assert len(result) == 2
        assert result[0].id == "1"
        assert result[1].id == "2"

    def test_update_existing_message(self):
        left = [AssistantMessage(id="1", content="Old content")]
        right = [AssistantMessage(id="1", content="New content")]

        result = add_and_merge_messages(left, right)

        assert len(result) == 1
        assert result[0].content == "New content"

    def test_replace_messages(self):
        from ee.hogai.utils.types import ReplaceMessages

        left = [
            AssistantMessage(id="1", content="Message 1"),
            AssistantMessage(id="2", content="Message 2"),
        ]
        right = ReplaceMessages([
            AssistantMessage(id="3", content="Only this message"),
        ])

        result = add_and_merge_messages(left, right)

        assert len(result) == 1
        assert result[0].id == "3"

    async def test_graph_state_merging(self):
        from langgraph.graph import StateGraph, START, END

        graph = StateGraph(AssistantState)
        graph.add_node(
            "node",
            lambda state: PartialAssistantState(
                messages=[AssistantMessage(id="2", content="Response")],
                plan="New plan"
            )
        )
        graph.add_edge(START, "node")
        graph.add_edge("node", END)

        compiled = graph.compile()
        result = await compiled.ainvoke({
            "messages": [AssistantMessage(id="1", content="Question")],
        })

        # Messages should be merged
        assert len(result["messages"]) == 2
        assert result["messages"][0].id == "1"
        assert result["messages"][1].id == "2"

        # Plan should be updated
        assert result["plan"] == "New plan"
```

---

## Summary

The PostHog HogAI state management system provides:

1. **Type-safe state management** via Pydantic models
2. **Flexible message merging** with merge-by-ID and complete replacement
3. **Field-level control** through annotations (`replace`, `append`, custom reducers)
4. **Conversation compaction** via `ReplaceMessages` wrapper
5. **Clean separation** between full state (`AssistantState`) and updates (`PartialAssistantState`)

### Key Takeaways

- **Nodes return `PartialAssistantState`** with only the fields they want to update
- **`add_and_merge_messages`** implements merge-by-ID for incremental updates
- **`ReplaceMessages`** bypasses merge logic for complete replacement (summarization)
- **`Annotated[T, replace]`** forces replacement even for None values
- **`Annotated[T, append]`** concatenates lists
- **Default merging** overwrites left with right if right is not None

This architecture enables complex multi-agent conversations with precise control over state updates, message history management, and conversation compaction.
