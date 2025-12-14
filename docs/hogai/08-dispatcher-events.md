# HogAI Dispatcher & Event System

**Document Version:** 1.0
**Source:** `posthog-master/ee/hogai/utils/dispatcher.py`, `posthog-master/ee/hogai/utils/types/base.py`, `posthog-master/ee/hogai/core/mixins.py`

## Overview

The HogAI Dispatcher & Event System provides a clean separation of concerns for emitting events from graph nodes to a streaming pipeline. The dispatcher **dispatches** actions to the stream, while downstream processors (like `ChatAgentStreamProcessor`) **reduce** those actions into client-facing messages.

**Key Principles:**
- Dispatcher emits actions to LangGraph's custom stream
- Dispatcher does NOT update state - it just emits events
- Non-blocking error handling ensures resilient execution
- Lazy initialization pattern via mixin for easy integration

---

## 1. AssistantDispatcher Class

The core dispatcher class that emits actions to the LangGraph custom stream.

### Constructor

```python
class AssistantDispatcher:
    def __init__(
        self,
        writer: StreamWriter | Callable[[Any], None],
        node_path: tuple[NodePath, ...],
        node_name: str,
        node_run_id: str,
    ):
        """
        Create a dispatcher for a specific node.

        Args:
            writer: The stream writer from LangGraph or a custom writer function
            node_path: The path from root to this node in the graph
            node_name: The name of the node dispatching actions (for attribution)
            node_run_id: The unique ID of this node execution (from langgraph_checkpoint_ns)
        """
        self._writer = writer
        self._node_path = node_path
        self._node_name = node_name
        self._node_run_id = node_run_id
```

**Parameters Explained:**
- `writer`: Either a LangGraph `StreamWriter` or any callable that accepts events. This is where dispatched events are sent.
- `node_path`: A tuple of `NodePath` objects representing the hierarchical path from the root graph to the current node. Used for tracking nested subgraphs.
- `node_name`: String identifier of the node (e.g., "trends_generator", "root"). Used for debugging and event attribution.
- `node_run_id`: Unique identifier for this specific node execution, typically from LangGraph's `langgraph_checkpoint_ns` metadata. Allows tracking concurrent node executions.

### Core Methods

#### `dispatch(action: AssistantActionUnion) -> None`

The primary method that emits actions to the stream.

```python
def dispatch(self, action: AssistantActionUnion) -> None:
    """
    Emit action to custom stream. Does NOT update state.

    The action is forwarded to BaseAssistant._reduce_action() which:
    1. Calls aupdate_state() to persist the change
    2. Yields the message to the client

    Args:
        action: Action dict with "type" and "payload" keys
    """
    try:
        self._writer(
            AssistantDispatcherEvent(
                action=action,
                node_path=self._node_path,
                node_name=self._node_name,
                node_run_id=self._node_run_id
            )
        )
    except Exception as e:
        # Log error but don't crash node execution
        # The dispatcher should be resilient to writer failures
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to dispatch action: {e}", exc_info=True)
```

**Implementation Details:**
1. Wraps the action in an `AssistantDispatcherEvent` with metadata
2. Calls the writer to emit the event to the stream
3. Catches ALL exceptions to prevent node crashes
4. Logs errors with full stack traces for debugging

#### `message(message: AssistantMessageUnion) -> None`

Convenience method for dispatching messages.

```python
def message(self, message: AssistantMessageUnion) -> None:
    """
    Dispatch a message to the stream.
    """
    self.dispatch(MessageAction(message=message))
```

**Usage:**
```python
from posthog.schema import AssistantMessage

dispatcher.message(AssistantMessage(content="Processing your query..."))
```

#### `update(content: str) -> None`

Convenience method for dispatching transient update messages.

```python
def update(self, content: str):
    """
    Dispatch a transient update message to the stream that will be
    associated with a tool call in the UI.
    """
    self.dispatch(UpdateAction(content=content))
```

**Usage:**
```python
dispatcher.update("Analyzing event properties...")
dispatcher.update("Generating visualization...")
```

**Note:** Updates are transient status messages shown during tool execution, not persisted in the message history.

---

## 2. Action Types

All action types are defined in `ee/hogai/utils/types/base.py` and use Pydantic models with discriminated unions.

### MessageAction

Dispatches a complete message to be persisted and shown to the user.

```python
class MessageAction(BaseModel):
    type: Literal["MESSAGE"] = "MESSAGE"
    message: AssistantMessageUnion
```

**Fields:**
- `type`: Discriminator field, always `"MESSAGE"`
- `message`: Any message type from `AssistantMessageUnion` (AssistantMessage, VisualizationMessage, FailureMessage, etc.)

**Purpose:** Send complete messages that should be added to the conversation history and displayed to the user.

**Example:**
```python
from posthog.schema import AssistantMessage

action = MessageAction(
    message=AssistantMessage(
        id="msg_123",
        content="I found 3 insights matching your query."
    )
)
dispatcher.dispatch(action)
```

### MessageChunkAction

Dispatches streaming chunks of a message being generated in real-time.

```python
class MessageChunkAction(BaseModel):
    type: Literal["MESSAGE_CHUNK"] = "MESSAGE_CHUNK"
    message: AIMessageChunk
```

**Fields:**
- `type`: Discriminator field, always `"MESSAGE_CHUNK"`
- `message`: A LangChain `AIMessageChunk` containing partial content

**Purpose:** Enable streaming responses where tokens are sent as they're generated, providing real-time feedback.

**Example:**
```python
from langchain_core.messages import AIMessageChunk

# Generated by LLM streaming
chunk = AIMessageChunk(content="I'm analyzing")
dispatcher.dispatch(MessageChunkAction(message=chunk))

chunk = AIMessageChunk(content=" your data...")
dispatcher.dispatch(MessageChunkAction(message=chunk))
```

**Note:** The stream processor merges chunks by `node_run_id` to reconstruct the full message.

### NodeStartAction

Signals the start of a node's execution.

```python
class NodeStartAction(BaseModel):
    type: Literal["NODE_START"] = "NODE_START"
```

**Fields:**
- `type`: Discriminator field, always `"NODE_START"`

**Purpose:** Initialize tracking for a node execution. The stream processor uses this to:
1. Create a message chunk tracker for this node run
2. Send an ACK (acknowledgment) to the client
3. Start timing the node execution

**Example (from BaseAssistantNode):**
```python
async def __call__(self, state: StateType, config: RunnableConfig):
    # Reset dispatcher state
    self._dispatcher = None
    self._config = config

    # Signal node start
    self.dispatcher.dispatch(NodeStartAction())

    # Execute node logic
    new_state = await self._execute(state, config)

    return new_state
```

### NodeEndAction

Signals the end of a node's execution and optionally returns updated state.

```python
class NodeEndAction(BaseModel, Generic[PartialStateType]):
    type: Literal["NODE_END"] = "NODE_END"
    state: PartialStateType | None = None
```

**Fields:**
- `type`: Discriminator field, always `"NODE_END"`
- `state`: Optional partial state update produced by the node

**Purpose:** Finalize a node execution. The stream processor uses this to:
1. Clean up message chunk tracking
2. Process any messages from the final state
3. Remove the node from active execution tracking

**Example (from BaseAssistantNode):**
```python
async def __call__(self, state: StateType, config: RunnableConfig):
    self.dispatcher.dispatch(NodeStartAction())

    new_state = await self._execute(state, config)

    # Signal node end with state update
    self.dispatcher.dispatch(NodeEndAction(state=new_state))

    return new_state
```

**Implementation Note:** The generic `PartialStateType` allows type-safe state updates for different node types.

### UpdateAction

Dispatches a transient status update message.

```python
class UpdateAction(BaseModel):
    type: Literal["UPDATE"] = "UPDATE"
    content: str
```

**Fields:**
- `type`: Discriminator field, always `"UPDATE"`
- `content`: The status message to display

**Purpose:** Provide real-time status updates during long-running operations. These are NOT persisted in message history but shown transiently in the UI (usually associated with a tool call).

**Example:**
```python
dispatcher.update("Exploring event properties...")
dispatcher.update("Analyzing 250 sessions...")
dispatcher.update("Generating query...")
```

**Stream Processing:** Updates are converted to `AssistantUpdateEvent` objects with the associated tool call ID extracted from the node path.

### AssistantActionUnion

The discriminated union of all action types.

```python
AssistantActionUnion = (
    MessageAction
    | MessageChunkAction
    | NodeStartAction
    | NodeEndAction
    | UpdateAction
)
```

**Usage:** Type hint for the dispatcher's `dispatch()` method to ensure type safety.

---

## 3. Non-blocking Error Handling

The dispatcher implements defensive error handling to ensure node execution never crashes due to streaming issues.

### Error Handling Strategy

```python
def dispatch(self, action: AssistantActionUnion) -> None:
    try:
        self._writer(
            AssistantDispatcherEvent(
                action=action,
                node_path=self._node_path,
                node_name=self._node_name,
                node_run_id=self._node_run_id
            )
        )
    except Exception as e:
        # Log error but don't crash node execution
        # The dispatcher should be resilient to writer failures
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to dispatch action: {e}", exc_info=True)
```

**Key Points:**
1. **Broad Exception Catching:** Catches `Exception` (not `BaseException`) to handle all non-system errors
2. **Logging:** Errors are logged with full stack trace (`exc_info=True`) for debugging
3. **Resilience:** Node execution continues even if the stream writer fails
4. **No Re-raising:** Errors are swallowed to prevent cascading failures

### Why This Matters

**Scenario 1: Stream Writer Failure**
```python
# Writer might fail if the client disconnects
def failing_writer(event):
    raise RuntimeError("Client disconnected!")

dispatcher = AssistantDispatcher(
    writer=failing_writer,
    node_path=path,
    node_name="trends_generator",
    node_run_id="run_123"
)

# Node execution continues despite writer failure
dispatcher.message(AssistantMessage(content="Hello"))
# Error logged, no exception raised
```

**Scenario 2: Serialization Error**
```python
# Event might fail to serialize
dispatcher.message(some_malformed_message)
# Error logged, node continues
```

**Design Rationale:**
- The dispatcher's job is to emit events on a "best effort" basis
- Node logic should not fail because of streaming infrastructure issues
- Errors are logged for observability and debugging
- Client-side failures should not crash server-side processing

---

## 4. Stream Writer Integration

The dispatcher integrates with LangGraph's custom stream via the `StreamWriter` type.

### StreamWriter Type

```python
from langgraph.types import StreamWriter

# StreamWriter is defined by LangGraph as:
# StreamWriter = Callable[[Any], None]
```

**Purpose:** A function that accepts events and writes them to the LangGraph stream.

### Getting the Stream Writer

```python
from langgraph.config import get_stream_writer

try:
    writer = get_stream_writer()
except RuntimeError:
    # Not in streaming context (e.g., testing)
    def noop(*_args, **_kwargs):
        pass
    writer = noop
```

**How It Works:**
1. `get_stream_writer()` retrieves the current stream writer from LangGraph context
2. Raises `RuntimeError` if called outside a streaming context
3. Fallback to noop writer in tests or non-streaming scenarios

### Event Flow

```
┌─────────────────┐
│  Node Execution │
└────────┬────────┘
         │
         │ dispatcher.message(msg)
         ▼
┌─────────────────────────┐
│  AssistantDispatcher    │
│  - Wraps in Event       │
│  - Adds metadata        │
└────────┬────────────────┘
         │
         │ writer(event)
         ▼
┌─────────────────────────┐
│  LangGraph Stream       │
│  - Custom stream        │
└────────┬────────────────┘
         │
         │ AsyncIterator
         ▼
┌─────────────────────────┐
│  ChatAgentStreamProcessor│
│  - Reduces to messages  │
└────────┬────────────────┘
         │
         │ Yields results
         ▼
┌─────────────────────────┐
│  Client (SSE/WebSocket) │
└─────────────────────────┘
```

### Integration Example

```python
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer
from ee.hogai.utils.dispatcher import AssistantDispatcher
from ee.hogai.utils.types.base import NodePath, AssistantNodeName

async def my_node(state: AssistantState, config: RunnableConfig):
    # Get writer from LangGraph context
    writer = get_stream_writer()

    # Create dispatcher
    node_path = (NodePath(name="assistant_graph"), NodePath(name="root"))
    dispatcher = AssistantDispatcher(
        writer=writer,
        node_path=node_path,
        node_name=AssistantNodeName.ROOT,
        node_run_id=config["metadata"]["langgraph_checkpoint_ns"]
    )

    # Dispatch events
    dispatcher.update("Processing request...")
    result = await process_request(state)
    dispatcher.message(AssistantMessage(content=result))

    return {"messages": [AssistantMessage(content=result)]}
```

---

## 5. AssistantDispatcherMixin

The mixin provides a property-based pattern for lazy dispatcher initialization in nodes.

### Mixin Definition

```python
from abc import ABC, abstractmethod

class AssistantDispatcherMixin(ABC):
    _config: RunnableConfig | None
    _dispatcher: AssistantDispatcher | None = None

    @property
    @abstractmethod
    def node_path(self) -> tuple[NodePath, ...]:
        """Subclass must define the node path"""
        ...

    @property
    @abstractmethod
    def node_name(self) -> str:
        """Subclass must define the node name"""
        ...

    @property
    def tool_call_id(self) -> str:
        """Extract the closest parent tool call ID from the path"""
        parent_tool_call_id = next(
            (path.tool_call_id for path in reversed(self.node_path) if path.tool_call_id),
            None
        )
        if not parent_tool_call_id:
            raise ValueError("No tool call ID found")
        return parent_tool_call_id

    @property
    def dispatcher(self) -> AssistantDispatcher:
        """Create a dispatcher for this node (lazy initialization)"""
        if self._dispatcher:
            return self._dispatcher
        self._dispatcher = create_dispatcher_from_config(
            self._config or {},
            self.node_path
        )
        return self._dispatcher
```

### Pattern Explained

**Lazy Initialization:**
```python
@property
def dispatcher(self) -> AssistantDispatcher:
    if self._dispatcher:
        return self._dispatcher  # Return cached instance
    self._dispatcher = create_dispatcher_from_config(...)  # Create on first access
    return self._dispatcher
```

**Benefits:**
1. Dispatcher created only when first accessed
2. Reused across multiple calls in same node execution
3. Reset at the start of each node execution (see `BaseAssistantNode.__call__`)

### Usage in Nodes

```python
from ee.hogai.core.mixins import AssistantDispatcherMixin
from ee.hogai.utils.types.base import NodePath, AssistantNodeName

class MyCustomNode(AssistantDispatcherMixin):
    def __init__(self, team: Team, user: User):
        self._team = team
        self._user = user
        self._config = None
        self._dispatcher = None

    @property
    def node_path(self) -> tuple[NodePath, ...]:
        return (NodePath(name="assistant_graph"), NodePath(name="my_node"))

    @property
    def node_name(self) -> str:
        return AssistantNodeName.ROOT

    async def __call__(self, state: AssistantState, config: RunnableConfig):
        # Set config for dispatcher creation
        self._config = config

        # Access dispatcher (lazy initialization)
        self.dispatcher.update("Starting processing...")

        result = await self.do_work(state)

        self.dispatcher.message(AssistantMessage(content=result))

        return {"messages": [AssistantMessage(content=result)]}
```

### Dispatcher Reset Pattern

From `BaseAssistantNode`:

```python
async def __call__(self, state: StateType, config: RunnableConfig):
    # Reset the dispatcher on a new run
    self._context_manager = None
    self._dispatcher = None  # ← Forces fresh creation
    self._config = config    # ← New config for this execution

    self.dispatcher.dispatch(NodeStartAction())  # ← Creates new dispatcher
    # ...
```

**Why Reset?**
1. Each node execution gets a fresh dispatcher
2. Prevents state pollution between runs
3. Ensures correct `node_run_id` for tracking

---

## 6. create_dispatcher_from_config()

Factory function that creates a dispatcher from LangGraph's `RunnableConfig`.

### Function Signature

```python
def create_dispatcher_from_config(
    config: RunnableConfig,
    node_path: tuple[NodePath, ...]
) -> AssistantDispatcher:
    """Create a dispatcher from a RunnableConfig and node path"""
```

### Implementation

```python
def create_dispatcher_from_config(
    config: RunnableConfig,
    node_path: tuple[NodePath, ...]
) -> AssistantDispatcher:
    # Set writer from LangGraph context
    try:
        writer = get_stream_writer()
    except RuntimeError:
        # Not in streaming context (e.g., testing)
        # Use noop writer
        def noop(*_args, **_kwargs):
            pass
        writer = noop

    metadata = config.get("metadata") or {}
    node_name: str = metadata.get("langgraph_node") or ""
    # `langgraph_checkpoint_ns` contains the nested path to the node,
    # so it's more accurate for streaming.
    node_run_id: str = metadata.get("langgraph_checkpoint_ns") or ""

    return AssistantDispatcher(
        writer,
        node_path=node_path,
        node_run_id=node_run_id,
        node_name=node_name
    )
```

### Parameter Extraction

**From RunnableConfig metadata:**

```python
config = RunnableConfig(
    metadata={
        "langgraph_node": "trends_generator",
        "langgraph_checkpoint_ns": "assistant_graph:root:123:insights:trends:456"
    }
)
```

Extracted:
- `node_name`: `"trends_generator"` - The current node name
- `node_run_id`: `"assistant_graph:root:123:insights:trends:456"` - Unique execution ID

**Why `langgraph_checkpoint_ns`?**
- Contains the full nested path to the node
- Unique for each node execution, even with concurrent runs
- More accurate for tracking than just node name

### Fallback Handling

```python
try:
    writer = get_stream_writer()
except RuntimeError:
    # Not in streaming context
    def noop(*_args, **_kwargs):
        pass
    writer = noop
```

**When does this happen?**
1. **Unit tests:** No LangGraph streaming context
2. **Direct node invocation:** Called outside graph execution
3. **Batch processing:** Non-streaming execution mode

**Noop writer behavior:**
```python
def noop(*_args, **_kwargs):
    pass

# Usage
noop_writer(any_event)  # Does nothing, returns None
```

### Usage Pattern

```python
from langchain_core.runnables import RunnableConfig
from ee.hogai.utils.dispatcher import create_dispatcher_from_config
from ee.hogai.utils.types.base import NodePath

async def my_node(state: AssistantState, config: RunnableConfig):
    # Define node path
    node_path = (
        NodePath(name="assistant_graph"),
        NodePath(name="root", message_id="msg_123", tool_call_id="tc_456"),
        NodePath(name="insights"),
    )

    # Create dispatcher from config
    dispatcher = create_dispatcher_from_config(config, node_path)

    # Use dispatcher
    dispatcher.update("Analyzing data...")
    # ...
```

---

## 7. AssistantDispatcherEvent

The event wrapper that packages actions with metadata for the stream.

### Event Structure

```python
class AssistantDispatcherEvent(BaseModel):
    action: AssistantActionUnion = Field(discriminator="type")
    node_path: tuple[NodePath, ...] | None = None
    node_name: str
    node_run_id: str
```

**Fields:**
- `action`: The action being dispatched (discriminated union)
- `node_path`: The hierarchical path from root to this node
- `node_name`: String identifier of the dispatching node
- `node_run_id`: Unique ID of this node execution

### Discriminated Union

```python
action: AssistantActionUnion = Field(discriminator="type")
```

**What is `discriminator`?**
Pydantic uses the `"type"` field to determine which action class to instantiate when deserializing.

**Example:**
```python
# Serialized JSON
{
    "action": {"type": "MESSAGE", "message": {...}},
    "node_name": "trends_generator",
    "node_run_id": "run_123",
    "node_path": [...]
}

# Pydantic automatically creates MessageAction based on type="MESSAGE"
event = AssistantDispatcherEvent.model_validate(json_data)
assert isinstance(event.action, MessageAction)
```

### NodePath Structure

```python
class NodePath(BaseModel):
    """Defines a vertice of the assistant graph path."""
    name: str
    message_id: str | None = None
    tool_call_id: str | None = None
```

**Example node path:**
```python
node_path = (
    NodePath(name="assistant_graph"),                              # Root graph
    NodePath(name="root", message_id="msg_1", tool_call_id="tc_1"), # Root node with tool call
    NodePath(name="insights_graph"),                               # Subgraph
    NodePath(name="trends_generator"),                             # Generator node
)
```

**Purpose:**
1. Track the execution path through nested graphs
2. Associate messages with their originating tool calls
3. Enable proper event attribution in the UI
4. Support concurrent executions of the same node

### Event Flow Example

```python
# 1. Node dispatches message
dispatcher.message(AssistantMessage(content="Processing..."))

# 2. Dispatcher wraps in event
event = AssistantDispatcherEvent(
    action=MessageAction(message=AssistantMessage(content="Processing...")),
    node_path=(
        NodePath(name="assistant_graph"),
        NodePath(name="root", tool_call_id="tc_123"),
        NodePath(name="insights_graph"),
        NodePath(name="trends_generator"),
    ),
    node_name="trends_generator",
    node_run_id="assistant_graph:root:123:insights:trends:456"
)

# 3. Writer sends to stream
writer(event)

# 4. Stream processor receives event
async def process(event: AssistantDispatcherEvent):
    match event.action:
        case MessageAction(message=msg):
            # Handle message
            return await self._handle_message(event, msg)
        case UpdateAction(content=content):
            # Handle update
            return self._handle_update(event, content)
        # ... other cases
```

---

## 8. Complete Implementation Example

Here's a full example showing how all pieces fit together:

```python
from langchain_core.runnables import RunnableConfig
from posthog.schema import AssistantMessage, AssistantToolCall
from posthog.models import Team, User

from ee.hogai.core.mixins import AssistantDispatcherMixin
from ee.hogai.utils.types.base import (
    AssistantState,
    NodePath,
    AssistantNodeName,
    PartialAssistantState,
)

class TrendsGeneratorNode(AssistantDispatcherMixin):
    """Example node that generates trend insights"""

    def __init__(self, team: Team, user: User):
        self._team = team
        self._user = user
        self._config: RunnableConfig | None = None
        self._dispatcher = None

    @property
    def node_path(self) -> tuple[NodePath, ...]:
        return (
            NodePath(name="assistant_graph"),
            NodePath(name="insights_graph"),
            NodePath(name="trends_generator"),
        )

    @property
    def node_name(self) -> str:
        return AssistantNodeName.TRENDS_GENERATOR

    async def __call__(
        self,
        state: AssistantState,
        config: RunnableConfig
    ) -> PartialAssistantState:
        # Reset dispatcher for this execution
        self._dispatcher = None
        self._config = config

        # Signal node start
        self.dispatcher.dispatch(NodeStartAction())

        try:
            # Execute node logic
            result = await self._execute(state)

            # Signal node end
            self.dispatcher.dispatch(NodeEndAction(state=result))

            return result

        except Exception as e:
            # Handle errors gracefully
            error_msg = AssistantMessage(
                content=f"Failed to generate trends: {str(e)}"
            )
            self.dispatcher.message(error_msg)
            raise

    async def _execute(self, state: AssistantState) -> PartialAssistantState:
        # Step 1: Analyze request
        self.dispatcher.update("Analyzing your request...")
        analysis = await self._analyze_request(state.messages[-1])

        # Step 2: Generate query
        self.dispatcher.update("Generating trends query...")
        query = await self._generate_query(analysis)

        # Step 3: Execute query
        self.dispatcher.update("Executing query...")
        results = await self._execute_query(query)

        # Step 4: Send results
        result_message = AssistantMessage(
            id="msg_result_123",
            content=f"Found {len(results)} trends",
            tool_calls=[
                AssistantToolCall(
                    id="tc_viz_789",
                    name="create_visualization",
                    args={"query": query, "results": results}
                )
            ]
        )
        self.dispatcher.message(result_message)

        # Return state update
        return PartialAssistantState(
            messages=[result_message]
        )

    async def _analyze_request(self, message):
        # Implementation
        pass

    async def _generate_query(self, analysis):
        # Implementation
        pass

    async def _execute_query(self, query):
        # Implementation
        pass
```

**What this demonstrates:**

1. **Mixin integration:** Inherits from `AssistantDispatcherMixin`
2. **Lazy dispatcher:** Created on first access via property
3. **Node lifecycle:** NodeStart → Updates → Message → NodeEnd
4. **Error handling:** Errors logged by dispatcher, then re-raised
5. **State updates:** Returns `PartialAssistantState` with new messages
6. **Progress updates:** Multiple `update()` calls for UI feedback
7. **Tool calls:** Messages can include tool calls for subgraph execution

---

## 9. Testing Patterns

### Unit Testing with Mock Writer

```python
from unittest.mock import MagicMock
from ee.hogai.utils.dispatcher import AssistantDispatcher
from ee.hogai.utils.types.base import NodePath, AssistantNodeName
from posthog.schema import AssistantMessage

def test_dispatcher_sends_messages():
    # Setup
    dispatched_events = []

    def mock_writer(event):
        dispatched_events.append(event)

    node_path = (
        NodePath(name="assistant_graph"),
        NodePath(name="root"),
    )

    dispatcher = AssistantDispatcher(
        writer=mock_writer,
        node_path=node_path,
        node_name=AssistantNodeName.ROOT,
        node_run_id="test_run_123"
    )

    # Execute
    dispatcher.message(AssistantMessage(content="Test message"))

    # Assert
    assert len(dispatched_events) == 1
    event = dispatched_events[0]
    assert isinstance(event.action, MessageAction)
    assert event.action.message.content == "Test message"
    assert event.node_name == AssistantNodeName.ROOT
    assert event.node_run_id == "test_run_123"
```

### Integration Testing with Real Stream

```python
from langchain_core.runnables import RunnableConfig
from unittest.mock import patch
from ee.hogai.utils.dispatcher import create_dispatcher_from_config

def test_dispatcher_from_config():
    # Setup
    config = RunnableConfig(
        metadata={
            "langgraph_node": "trends_generator",
            "langgraph_checkpoint_ns": "run_456"
        }
    )

    node_path = (NodePath(name="assistant_graph"),)

    mock_writer = MagicMock()

    # Mock LangGraph stream writer
    with patch("ee.hogai.utils.dispatcher.get_stream_writer", return_value=mock_writer):
        dispatcher = create_dispatcher_from_config(config, node_path)

        # Execute
        dispatcher.update("Test update")

        # Assert
        assert mock_writer.call_count == 1
        event = mock_writer.call_args[0][0]
        assert isinstance(event.action, UpdateAction)
        assert event.action.content == "Test update"
```

### Testing Error Handling

```python
def test_dispatcher_handles_writer_failure():
    # Setup
    def failing_writer(event):
        raise RuntimeError("Stream failure!")

    dispatcher = AssistantDispatcher(
        writer=failing_writer,
        node_path=(),
        node_name="root",
        node_run_id="run_789"
    )

    # Execute - should not raise exception
    with patch("logging.getLogger") as mock_get_logger:
        mock_logger = MagicMock()
        mock_get_logger.return_value = mock_logger

        dispatcher.message(AssistantMessage(content="Test"))

        # Assert error was logged
        mock_logger.error.assert_called_once()
        args = mock_logger.error.call_args[0]
        assert "Failed to dispatch action" in args[0]
```

---

## 10. Common Patterns & Best Practices

### Pattern 1: Node with Multiple Updates

```python
async def process_long_task(self, state: AssistantState):
    self.dispatcher.update("Step 1: Loading data...")
    data = await load_data()

    self.dispatcher.update("Step 2: Processing 1000 records...")
    processed = await process_data(data)

    self.dispatcher.update("Step 3: Generating visualization...")
    viz = await create_viz(processed)

    self.dispatcher.message(AssistantMessage(content="Analysis complete!"))
```

### Pattern 2: Conditional Messaging

```python
async def smart_processor(self, state: AssistantState):
    self.dispatcher.update("Analyzing request...")

    complexity = analyze_complexity(state.messages[-1])

    if complexity == "simple":
        self.dispatcher.message(AssistantMessage(content="Quick answer: ..."))
    else:
        self.dispatcher.update("Complex query detected, using advanced analysis...")
        result = await advanced_analysis(state)
        self.dispatcher.message(result)
```

### Pattern 3: Error Recovery

```python
async def resilient_processor(self, state: AssistantState):
    self.dispatcher.update("Processing request...")

    try:
        result = await risky_operation()
        self.dispatcher.message(AssistantMessage(content=result))
    except OperationFailed as e:
        # Dispatcher continues to work even if operation fails
        self.dispatcher.message(
            FailureMessage(content=f"Operation failed: {e}")
        )
        # Return fallback state
        return PartialAssistantState(messages=[...])
```

### Pattern 4: Tool Call Chain

```python
async def multi_tool_node(self, state: AssistantState):
    # Message with tool calls
    tool_message = AssistantMessage(
        content="I'll search for insights and create a dashboard",
        tool_calls=[
            AssistantToolCall(id="tc_1", name="search_insights", args={...}),
            AssistantToolCall(id="tc_2", name="create_dashboard", args={...}),
        ]
    )

    self.dispatcher.message(tool_message)

    # Updates will be associated with tool calls via node_path
    # when subgraphs execute
```

### Best Practices

1. **Always reset dispatcher in `__call__`:**
   ```python
   async def __call__(self, state, config):
       self._dispatcher = None  # Reset
       self._config = config     # New config
       # ...
   ```

2. **Use descriptive update messages:**
   ```python
   # Good
   self.dispatcher.update("Analyzing 250 user sessions from last 7 days...")

   # Bad
   self.dispatcher.update("Processing...")
   ```

3. **Emit updates for long operations:**
   ```python
   if estimated_time > 2_seconds:
       self.dispatcher.update(f"Processing {count} items, this may take a moment...")
   ```

4. **Handle message IDs consistently:**
   ```python
   import uuid

   message = AssistantMessage(
       id=str(uuid.uuid4()),  # Always set IDs
       content="Result"
   )
   self.dispatcher.message(message)
   ```

5. **Use NodeStart/NodeEnd in base classes:**
   ```python
   # Let BaseAssistantNode handle these
   # Don't dispatch manually unless you have a good reason
   ```

---

## 11. Debugging & Observability

### Logging

Dispatcher errors are logged automatically:

```python
# dispatcher.py
logger.error(f"Failed to dispatch action: {e}", exc_info=True)
```

**View logs:**
```bash
# In development
tail -f logs/dispatcher.log | grep "Failed to dispatch"

# In production
# Check your logging infrastructure (e.g., Datadog, CloudWatch)
```

### Tracking Events

Add logging to your writer:

```python
def debug_writer(event: AssistantDispatcherEvent):
    print(f"[{event.node_name}] {event.action.type}: {event.action}")
    real_writer(event)
```

### Monitoring Node Performance

```python
import time

async def __call__(self, state, config):
    start = time.time()
    self.dispatcher.dispatch(NodeStartAction())

    result = await self._execute(state, config)

    elapsed = time.time() - start
    logger.info(f"Node {self.node_name} took {elapsed:.2f}s")

    self.dispatcher.dispatch(NodeEndAction(state=result))
    return result
```

---

## Summary

The HogAI Dispatcher & Event System provides:

1. **Clean separation:** Dispatchers emit, processors reduce
2. **Type safety:** Discriminated unions for actions
3. **Resilience:** Non-blocking error handling
4. **Flexibility:** Works in streaming and non-streaming contexts
5. **Observability:** Comprehensive metadata for debugging
6. **Simplicity:** Mixin pattern for easy integration

**To implement from scratch:**

1. Create action types with Pydantic models
2. Implement `AssistantDispatcher` with error handling
3. Create `AssistantDispatcherEvent` wrapper
4. Implement `create_dispatcher_from_config` factory
5. Add `AssistantDispatcherMixin` for node integration
6. Build stream processor to reduce events to messages

This architecture enables scalable, maintainable AI agent systems with excellent developer experience.
