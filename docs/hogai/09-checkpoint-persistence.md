# PostHog HogAI Checkpoint & Persistence System

## Overview

The PostHog HogAI checkpoint and persistence system provides a Django ORM-backed implementation of LangGraph's checkpoint mechanism. It enables stateful, resumable agent conversations with support for interrupts, subgraph isolation, and efficient state management.

**Key Features:**
- Full LangGraph BaseCheckpointSaver implementation using Django ORM
- Postgres-backed persistence with optimized queries
- Support for subgraph namespaces and nested graph execution
- NodeInterrupt-based pausing mechanism for user interaction
- Efficient serialization with msgpack and JSON
- Singleton global checkpointer pattern

---

## 1. DjangoCheckpointer Class

The `DjangoCheckpointer` implements LangGraph's `BaseCheckpointSaver[str]` interface, providing full async support for checkpoint operations.

### Core Implementation

```python
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

class DjangoCheckpointer(BaseCheckpointSaver[str]):
    jsonplus_serde = JsonPlusSerializer()

    # Main async methods:
    async def aget_tuple(self, config: RunnableConfig) -> Optional[CheckpointTuple]
    async def alist(self, config, *, filter=None, before=None, limit=None) -> AsyncIterator[CheckpointTuple]
    async def aput(self, config, checkpoint, metadata, new_versions) -> RunnableConfig
    async def aput_writes(self, config, writes, task_id, task_path="") -> None
```

### Key Methods

#### `aget_tuple()` - Retrieve Latest Checkpoint

Retrieves the most recent checkpoint for a given thread and optional checkpoint ID.

```python
async def aget_tuple(self, config: RunnableConfig) -> Optional[CheckpointTuple]:
    """Get a checkpoint tuple from the database.

    Args:
        config: Must contain configurable.thread_id and optional checkpoint_id

    Returns:
        CheckpointTuple with full state, or None if not found
    """
    return await anext(self.alist(config), None)
```

**Usage Example:**
```python
config = {
    "configurable": {
        "thread_id": conversation.id,
        "checkpoint_ns": "",  # Root namespace
        "checkpoint_id": "01933e7c-8000-7000-8000-000000000000"  # Optional
    }
}
checkpoint_tuple = await checkpointer.aget_tuple(config)
```

#### `alist()` - Query Checkpoints

Lists checkpoints with filtering, pagination, and relationship loading.

```python
async def alist(
    self,
    config: Optional[RunnableConfig],
    *,
    filter: Optional[dict[str, Any]] = None,
    before: Optional[RunnableConfig] = None,
    limit: Optional[int] = None,
) -> AsyncIterator[CheckpointTuple]:
    """List checkpoints from the database.

    Args:
        config: Thread ID and namespace filter
        filter: Metadata filter (e.g., {"source": "input", "step": 2})
        before: Return only checkpoints before this checkpoint ID
        limit: Maximum number of results

    Yields:
        CheckpointTuple objects ordered by ID descending (newest first)
    """
```

**Advanced Filtering:**
```python
# Filter by metadata
results = [
    r async for r in checkpointer.alist(
        config,
        filter={"source": "loop", "step": 5}
    )
]

# Get checkpoints before a specific point
results = [
    r async for r in checkpointer.alist(
        config,
        before={"configurable": {"checkpoint_id": previous_id}}
    )
]
```

#### `aput()` - Save Checkpoint

Saves a new checkpoint with state and metadata.

```python
async def aput(
    self,
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    new_versions: ChannelVersions,
) -> RunnableConfig:
    """Save a checkpoint to the database.

    Args:
        config: Thread configuration
        checkpoint: Complete checkpoint state (without channel_values)
        metadata: Arbitrary metadata dict
        new_versions: Channel version mapping for this checkpoint

    Returns:
        Updated config with new checkpoint_id
    """
```

**Internal Flow:**
1. Extracts `thread_id` and `checkpoint_ns` from config
2. Removes `channel_values` from checkpoint (stored separately as blobs)
3. Creates or updates `ConversationCheckpoint` record
4. Bulk creates `ConversationCheckpointBlob` records for each channel version
5. Returns updated config with new checkpoint ID

#### `aput_writes()` - Save Pending Writes

Stores intermediate writes linked to a checkpoint (e.g., from parallel node execution).

```python
async def aput_writes(
    self,
    config: RunnableConfig,
    writes: Sequence[tuple[str, Any]],
    task_id: str,
    task_path: str = "",
) -> None:
    """Store intermediate writes linked to a checkpoint.

    Args:
        config: Thread configuration
        writes: List of (channel, value) tuples
        task_id: UUID identifying the task creating writes
        task_path: Optional path for nested tasks
    """
```

**Race Condition Handling:**
- Uses `get_or_create()` to ensure checkpoint exists before writes
- Supports concurrent `put()` and `put_writes()` calls
- Handles conflicts with `bulk_create(update_conflicts=True)`

### Serialization Strategy

The checkpointer uses two serialization mechanisms:

**1. JsonPlusSerializer (for checkpoints and metadata):**
```python
jsonplus_serde = JsonPlusSerializer()

def _dump_json(self, obj: Any) -> dict[str, Any]:
    serialized_metadata = self.jsonplus_serde.dumps(obj)
    # Remove null characters for JSON storage
    nulls_removed = serialized_metadata.decode().replace("\\u0000", "")
    return json.loads(nulls_removed)

def _load_json(self, obj: Any):
    return self.jsonplus_serde.loads(self.jsonplus_serde.dumps(obj))
```

**2. Inherited serde (msgpack for channel values and writes):**
```python
# Saving
type, blob = self.serde.dumps_typed(value)
# blob is binary msgpack data

# Loading
value = self.serde.loads_typed((type, blob))
```

**Serialization Types:**
- `"msgpack"`: Binary msgpack encoding (most efficient)
- `"json"`: JSON encoding for simple types
- `"null"`: None values
- `"empty"`: Empty/deleted channels

---

## 2. Checkpoint Structure

### Core Checkpoint Fields

A checkpoint represents a complete snapshot of graph state at a point in time:

```python
checkpoint: Checkpoint = {
    "v": 1,  # Schema version
    "id": "01933e7c-8000-7000-8000-000000000000",  # UUID v6
    "ts": "2024-07-31T20:14:19.804150+00:00",  # ISO timestamp
    "channel_versions": {
        "__start__": 2,
        "messages": 3,
        "start:node": 3,
        "node": 3,
    },
    "channel_values": {  # Stored separately as blobs
        "messages": [...],
        "node": {...}
    },
    "versions_seen": {
        "__input__": {},
        "__start__": {"__start__": 1},
        "node": {"start:node": 2},
    },
    "pending_sends": []  # Messages to send to other nodes
}
```

### Database Schema

**ConversationCheckpoint:**
```python
class ConversationCheckpoint(UUIDTModel):
    id = UUIDField(primary_key=True)  # Checkpoint ID
    thread = ForeignKey(Conversation)  # Parent conversation
    checkpoint_ns = TextField(default="")  # Namespace path
    parent_checkpoint = ForeignKey('self', null=True)  # Previous checkpoint
    checkpoint = JSONField(null=True)  # Serialized checkpoint data
    metadata = JSONField(null=True)  # User-defined metadata

    # Unique constraint on (id, checkpoint_ns, thread)
```

**ConversationCheckpointBlob:**
```python
class ConversationCheckpointBlob(UUIDTModel):
    checkpoint = ForeignKey(ConversationCheckpoint)  # Creating checkpoint
    thread = ForeignKey(Conversation)  # For querying
    checkpoint_ns = TextField(default="")  # Namespace
    channel = TextField()  # Channel name (e.g., "messages", "node")
    version = TextField()  # Monotonic version string
    type = TextField(null=True)  # Serialization type
    blob = BinaryField(null=True)  # Binary data

    # Unique constraint on (thread_id, checkpoint_ns, channel, version)
```

**ConversationCheckpointWrite:**
```python
class ConversationCheckpointWrite(UUIDTModel):
    checkpoint = ForeignKey(ConversationCheckpoint)
    task_id = UUIDField()  # Task creating the write
    idx = IntegerField()  # Write index (negative for special cases)
    channel = TextField()  # Target channel
    type = TextField(null=True)  # Serialization type
    blob = BinaryField(null=True)  # Binary data

    # Unique constraint on (checkpoint_id, task_id, idx)
```

### Channel Versioning

Channels use monotonic version strings with random hash for uniqueness:

```python
def get_next_version(self, current: Optional[str | int], channel: ChannelProtocol) -> str:
    if current is None:
        current_v = 0
    elif isinstance(current, int):
        current_v = current
    else:
        current_v = int(current.split(".")[0])
    next_v = current_v + 1
    next_h = random.random()
    return f"{next_v:032}.{next_h:016}"
    # Example: "00000000000000000000000000000003.0.7234567890123456"
```

**Why Version + Hash?**
- Monotonic integer prefix for ordering
- Random hash suffix prevents conflicts in distributed systems
- Enables efficient queries by version range

### Metadata Storage

Metadata is arbitrary JSON stored alongside checkpoints:

```python
metadata: CheckpointMetadata = {
    "source": "input",  # Where checkpoint was created
    "step": 2,  # Step number in graph execution
    "writes": {"foo": "bar"},  # Custom data
    "score": 1.5,  # Numeric values allowed
    "parent_ns": "child|grandchild"  # Namespace tracking
}
```

**Common Metadata Patterns:**
- `source`: `"input"`, `"loop"`, `"update"`, `"fork"`
- `step`: Sequential execution step number
- `writes`: Pending writes summary
- Custom fields for application-specific tracking

---

## 3. Namespace Support

Namespaces enable checkpoint isolation for subgraphs, preventing state collisions between nested graph executions.

### Namespace Path Format

Namespaces use pipe-delimited paths:

```python
checkpoint_ns = "child|grandchild|great_grandchild"
# Root namespace: "" (empty string)
# First level subgraph: "child"
# Nested subgraph: "child|grandchild"
```

### Namespace in Config

```python
config: RunnableConfig = {
    "configurable": {
        "thread_id": "conversation-123",
        "checkpoint_ns": "memory_graph|search_node",  # Subgraph path
        "checkpoint_id": "01933e7c-..."  # Optional specific checkpoint
    }
}
```

### Query Behavior

**With namespace specified:**
```python
# Returns only checkpoints in "child" namespace
config = {"configurable": {"thread_id": thread_id, "checkpoint_ns": "child"}}
checkpoints = [c async for c in checkpointer.alist(config)]
```

**Without namespace (default):**
```python
# Returns checkpoints from ALL namespaces for this thread
config = {"configurable": {"thread_id": thread_id}}
checkpoints = [c async for c in checkpointer.alist(config)]
```

### Subgraph Isolation Example

```python
# Root graph checkpoint
root_checkpoint = {
    "configurable": {
        "thread_id": "conv-123",
        "checkpoint_ns": "",
        "checkpoint_id": "checkpoint-root"
    }
}

# Subgraph checkpoint (isolated)
subgraph_checkpoint = {
    "configurable": {
        "thread_id": "conv-123",
        "checkpoint_ns": "search_agent|tool_executor",
        "checkpoint_id": "checkpoint-sub"
    }
}

# Both share thread_id but have isolated state
# Querying root_checkpoint won't return subgraph checkpoints unless namespace filter is removed
```

### Namespace Context Management

The `BaseAssistantGraph` class automatically manages namespace context:

```python
class BaseAssistantGraph:
    def __init__(self, team: Team, user: User):
        self._node_path = (
            *(get_node_path() or ()),
            NodePath(name=self.graph_name.value)
        )

    @with_node_path
    def add_node(self, node, action):
        # Node path context automatically set
        self._graph.add_node(node, action)
```

**Node path context:**
```python
from ee.hogai.core.context import set_node_path, get_node_path

# Set context for subgraph execution
with set_node_path(subgraph_path):
    await subgraph_node.arun(state, config)
```

---

## 4. State Resumption

State resumption allows graphs to continue execution after interrupts, user input, or system restarts.

### Loading from Checkpoint

**Basic Resume Flow:**
```python
async def _init_or_update_state(self):
    config = self._get_config()

    # Load latest checkpoint
    snapshot = await self._graph.aget_state(config)
    saved_state = validate_state_update(snapshot.values, self._state_type)

    # Check if interrupted
    if snapshot.next and self._latest_message and saved_state.graph_status == "interrupted":
        self._state = saved_state
        # Resume from interrupted point
        await self._graph.aupdate_state(config, self.get_resumed_state())
        return None  # Continue from interrupt

    # Otherwise start fresh with initial state
    return self.get_initial_state()
```

### CheckpointTuple Structure

The `aget_tuple()` and `alist()` methods return `CheckpointTuple`:

```python
@dataclass
class CheckpointTuple:
    config: RunnableConfig  # Config used to retrieve this checkpoint
    checkpoint: Checkpoint  # Full checkpoint with channel_values and pending_sends
    metadata: CheckpointMetadata  # User metadata
    parent_config: Optional[RunnableConfig]  # Config of parent checkpoint
    pending_writes: list[PendingWrite]  # Uncommitted writes
```

**PendingWrite Type:**
```python
PendingWrite = tuple[str, str, Any]
# (task_id, channel, value)
```

### Assembling Full State

The `alist()` method constructs full state from database records:

```python
async def alist(self, config, ...) -> AsyncIterator[CheckpointTuple]:
    async for checkpoint in qs:
        # Load checkpoint data
        loaded_checkpoint: Checkpoint = self._load_json(checkpoint.checkpoint)

        # Load pending sends from parent checkpoint
        pending_sends = [
            self.serde.loads_typed((write.type, write.blob))
            async for write in checkpoint.parent_checkpoint.writes.all()
        ] if checkpoint.parent_checkpoint else []

        # Load channel values by version
        channel_values = {
            blob.channel: self.serde.loads_typed((blob.type, blob.blob))
            async for blob in self._get_checkpoint_channel_values(checkpoint)
            if blob.type not in [None, "empty"]
        }

        # Merge into complete checkpoint
        checkpoint_dict = {
            **loaded_checkpoint,
            "pending_sends": pending_sends,
            "channel_values": channel_values,
        }

        # Load pending writes for this checkpoint
        pending_writes = self._load_writes([
            write async for write in checkpoint.writes.all()
        ])

        yield CheckpointTuple(
            config={...},
            checkpoint=checkpoint_dict,
            metadata=self._load_json(checkpoint.metadata),
            parent_config={...} if checkpoint.parent_checkpoint else None,
            pending_writes=pending_writes
        )
```

### Updating State

**Manual State Update:**
```python
# Update state and resume execution
await graph.aupdate_state(
    config,
    {"messages": [new_message], "graph_status": "running"}
)

# Continue execution from updated state
result = await graph.ainvoke(None, config=config)
```

**Automatic Resumption:**
```python
# After NodeInterrupt, state is automatically saved
# Next invocation with same config resumes from interrupt point

# First invocation hits interrupt
await graph.ainvoke(initial_state, config=config)

# User provides input via state update
await graph.aupdate_state(config, {"user_input": "answer"})

# Second invocation continues from interrupt
result = await graph.ainvoke(None, config=config)
```

### Query Efficiency

The checkpointer uses prefetching to avoid N+1 queries:

```python
def _get_checkpoint_qs(self, config, filter, before):
    return (
        ConversationCheckpoint.objects.filter(query)
        .order_by("-id")
        .select_related("parent_checkpoint")  # Prefetch parent
        .prefetch_related(
            Prefetch("writes", queryset=...),  # Prefetch writes
            Prefetch("parent_checkpoint__writes", queryset=...)  # Prefetch parent writes
        )
    )
```

**Query Count for `alist()`:**
- 1 query: Fetch checkpoints with parent
- 1 query: Prefetch writes
- 1 query: Prefetch parent writes
- N queries: Fetch blobs for N checkpoints (one per checkpoint)
- **Total: ~3-7 queries** regardless of result count

---

## 5. NodeInterrupt

`NodeInterrupt` is LangGraph's mechanism for pausing execution and requesting user interaction.

### Basic Interrupt Pattern

**Raising an Interrupt:**
```python
from langgraph.errors import NodeInterrupt

class MyNode(AssistantNode):
    async def arun(self, state, config):
        # Pause execution and send message to user
        raise NodeInterrupt(
            AssistantMessage(
                content="Please confirm: Do you want to proceed?",
                id=str(uuid4())
            )
        )
```

**What Happens:**
1. Node raises `NodeInterrupt` with a value (message, form, etc.)
2. LangGraph saves checkpoint with interrupt info
3. Execution halts, interrupt value returned to client
4. User provides response
5. Graph state updated with user input
6. Execution resumes from same node

### Interrupt Value Types

**1. String Interrupt (Simple):**
```python
raise NodeInterrupt("Please provide your email address")
```

**2. Message Interrupt (Rich):**
```python
raise NodeInterrupt(
    AssistantMessage(
        content="Confirmation required",
        id=str(uuid4())
    )
)
```

**3. Form Interrupt (Structured Input):**
```python
raise NodeInterrupt(
    AssistantMessage(
        content="Please select an option",
        meta=AssistantMessageMetadata(
            form=AssistantForm(
                options=[
                    AssistantFormOption(value="Yes", variant="primary"),
                    AssistantFormOption(value="No"),
                ]
            )
        ),
        id=str(uuid4())
    )
)
```

**4. None Interrupt (Form-Based Tools):**
```python
# Used by create_form tool - interrupt without displaying message
# Message is constructed separately from tool call info
raise NodeInterrupt(None)
```

### Interrupt Detection and Handling

**In Agent Runner:**
```python
async def astream(self):
    try:
        async for update in generator:
            # Process updates...
            pass

        # Check for interrupts after stream completes
        state = await self._graph.aget_state(config)
        if state.next:  # If there are next nodes, we're interrupted
            interrupt_messages = []
            for task in state.tasks:
                for interrupt in task.interrupts:
                    if interrupt.value is None:
                        continue  # Skip None interrupts (create_form)

                    # Convert interrupt value to message
                    interrupt_message = (
                        AssistantMessage(content=interrupt.value, id=str(uuid4()))
                        if isinstance(interrupt.value, str)
                        else interrupt.value
                    )
                    interrupt_messages.append(interrupt_message)
                    yield AssistantEventType.MESSAGE, interrupt_message

            # Update state with interrupt messages
            await self._graph.aupdate_state(
                config,
                {"messages": interrupt_messages, "graph_status": "interrupted"}
            )
    except GraphRecursionError:
        # Handle max steps exceeded
        pass
```

### Form-Based Interrupt Example (create_form Tool)

**Tool Implementation:**
```python
class CreateFormTool(MaxTool):
    async def _arun_impl(self, questions: list[MultiQuestionFormQuestion]):
        if not questions:
            raise MaxToolRetryableError("At least one question is required.")
        if len(questions) > 4:
            raise MaxToolRetryableError("Do not ask more than 4 questions at a time.")

        # Interrupt with None - form displayed based on tool call
        raise NodeInterrupt(None)
```

**Resume Handler:**
```python
def _get_form_response_message(self, saved_state) -> AssistantToolCallMessage | None:
    """Create tool call response when resuming after create_form interrupt."""
    if not saved_state.messages or not self._latest_message:
        return None

    # Check for form answers in new human message
    if not isinstance(self._latest_message, HumanMessage):
        return None
    if not self._latest_message.ui_context or not self._latest_message.ui_context.form_answers:
        return None

    # Find original create_form tool call
    last_assistant_message = find_last_message_of_type(saved_state.messages, AssistantMessage)
    if not last_assistant_message or not last_assistant_message.tool_calls:
        return None

    create_form_tool_call = next(
        (tc for tc in last_assistant_message.tool_calls if tc.name == "create_form"),
        None
    )
    if not create_form_tool_call:
        return None

    # Create tool call response message with form answers
    answers = self._latest_message.ui_context.form_answers
    return AssistantToolCallMessage(
        content=self._latest_message.content or "",
        id=str(uuid4()),
        tool_call_id=create_form_tool_call.id,
        ui_payload={"create_form": {"answers": answers}}
    )
```

### Memory Onboarding Interrupt Example

**Interrupt Node:**
```python
class MemoryInitializerInterruptNode(AssistantNode):
    """Prompts user to confirm or reject scraped memory."""

    async def arun(self, state, config):
        raise NodeInterrupt(
            AssistantMessage(
                content="I've gathered information about your product. Does this look correct?",
                meta=AssistantMessageMetadata(
                    form=AssistantForm(
                        options=[
                            AssistantFormOption(
                                value="Yes, this looks good",
                                variant="primary"
                            ),
                            AssistantFormOption(value="No, let me clarify"),
                        ]
                    )
                ),
                id=str(uuid4())
            )
        )
```

**Resume Logic:**
```python
# Router determines next step based on user response
async def arouter(self, state) -> Literal["continue", "interrupt"]:
    core_memory, _ = await CoreMemory.objects.aget_or_create(team=self._team)
    if state.onboarding_question and core_memory.answers_left > 0:
        return "interrupt"  # More questions needed
    return "continue"  # Onboarding complete
```

### Interrupt Storage

Interrupts are NOT stored in checkpoints directly - they're ephemeral:

```python
# LangGraph stores interrupt info in StateSnapshot.tasks
snapshot = await graph.aget_state(config)
for task in snapshot.tasks:
    for interrupt in task.interrupts:
        print(interrupt.value)  # The NodeInterrupt value

# Checkpoints only store graph_status
await graph.aupdate_state(
    config,
    {"graph_status": "interrupted"}  # Persisted in checkpoint
)
```

**Why this design?**
- Interrupts are transient - they represent a request for input
- After resumption, interrupts are no longer relevant
- Only the response to the interrupt (updated state) is persisted

---

## 6. Global Checkpointer

PostHog uses a singleton checkpointer pattern for all graph instances.

### Singleton Pattern

```python
# ee/hogai/core/base.py

from ee.hogai.django_checkpoint.checkpointer import DjangoCheckpointer

# Global singleton instance
global_checkpointer = DjangoCheckpointer()
```

### Usage in Graph Compilation

```python
class BaseAssistantGraph:
    def compile(self, checkpointer: DjangoCheckpointer | None | Literal[False] = None):
        if not self._has_start_node:
            raise ValueError("Start node not added to the graph")

        # Three options:
        # 1. None (default) -> use global_checkpointer
        # 2. DjangoCheckpointer instance -> use custom checkpointer
        # 3. False -> no checkpointing
        compiled_graph = self._graph.compile(
            checkpointer=checkpointer if checkpointer is not None else global_checkpointer
        )
        return compiled_graph
```

**Usage Examples:**

```python
# 1. Use global checkpointer (recommended)
graph = MyGraph(team, user)
compiled = graph.compile()  # Uses global_checkpointer

# 2. Use custom checkpointer (testing)
custom_checkpointer = DjangoCheckpointer()
compiled = graph.compile(checkpointer=custom_checkpointer)

# 3. Disable checkpointing (ephemeral graphs)
compiled = graph.compile(checkpointer=False)
```

### When to Use Global vs Custom

**Use Global Checkpointer (default):**
- Production agent execution
- Shared checkpoint pool across all conversations
- Consistent behavior across different graph types
- No special checkpoint requirements

**Use Custom Checkpointer:**
- Testing with isolated database
- Custom serialization requirements
- Special metadata tracking
- Performance testing/benchmarking

**Disable Checkpointing (False):**
- Ephemeral one-off tasks
- Stateless utility graphs
- Testing without database
- Performance-critical paths where persistence isn't needed

### Benefits of Singleton Pattern

**1. Resource Efficiency:**
- Single connection pool for all graphs
- No per-graph checkpoint overhead
- Shared serializer instances

**2. Consistent State:**
- All graphs share same checkpoint view
- Subgraph and parent graph use same checkpointer
- No state synchronization issues

**3. Simplified Configuration:**
- No need to pass checkpointer through layers
- Default behavior works for 99% of cases
- Easy to override when needed

### Thread Safety

The Django ORM handles thread safety:
- Each request runs in its own async context
- Database operations use connection pooling
- No explicit locking needed in most cases

**Race Condition Handling:**
```python
# get_or_create ensures checkpoint exists before writes
with transaction.atomic():
    checkpoint, _ = ConversationCheckpoint.objects.get_or_create(
        id=checkpoint_id,
        thread_id=thread_id,
        checkpoint_ns=checkpoint_ns
    )
    # Now safe to create writes
```

### Testing with Global Checkpointer

```python
class TestMyGraph(NonAtomicBaseTest):
    async def test_checkpoint_persistence(self):
        thread = await Conversation.objects.acreate(user=self.user, team=self.team)

        # Use global checkpointer in tests
        from ee.hogai.core.base import global_checkpointer

        graph = MyGraph(self.team, self.user).compile()
        config = {"configurable": {"thread_id": str(thread.id)}}

        # First run
        await graph.ainvoke(initial_state, config=config)

        # Verify checkpoint created
        checkpoint = await global_checkpointer.aget_tuple(config)
        self.assertIsNotNone(checkpoint)

        # Resume from checkpoint
        result = await graph.ainvoke(None, config=config)
        self.assertEqual(result["messages"][-1].content, "Expected response")
```

---

## Complete Example: Resumable Chat Agent

Here's a full example combining all concepts:

```python
from langgraph.graph.state import StateGraph
from langgraph.errors import NodeInterrupt
from ee.hogai.core.base import BaseAssistantGraph, global_checkpointer
from ee.hogai.django_checkpoint.checkpointer import DjangoCheckpointer

# 1. Define State
class ChatState(TypedDict):
    messages: Annotated[list[str], operator.add]
    user_confirmed: Optional[bool]
    graph_status: str

# 2. Create Nodes
class ConfirmationNode:
    async def __call__(self, state: ChatState):
        if not state.get("user_confirmed"):
            # Interrupt and wait for confirmation
            raise NodeInterrupt(
                AssistantMessage(
                    content="Please confirm you want to continue",
                    meta=AssistantMessageMetadata(
                        form=AssistantForm(
                            options=[
                                AssistantFormOption(value="Confirm", variant="primary"),
                                AssistantFormOption(value="Cancel"),
                            ]
                        )
                    ),
                    id=str(uuid4())
                )
            )
        return {"messages": ["Confirmed!"]}

class ProcessNode:
    async def __call__(self, state: ChatState):
        return {"messages": ["Processing complete"], "graph_status": "done"}

# 3. Build Graph
class ChatGraph(BaseAssistantGraph):
    state_type = ChatState
    graph_name = AssistantGraphName.CHAT

    def __init__(self, team, user):
        super().__init__(team, user)
        self.add_node("confirm", ConfirmationNode())
        self.add_node("process", ProcessNode())
        self.add_edge(START, "confirm")
        self.add_edge("confirm", "process")
        self.add_edge("process", END)

# 4. Execute with Checkpointing
async def run_chat():
    # Create conversation thread
    conversation = await Conversation.objects.acreate(user=user, team=team)

    # Compile with global checkpointer (default)
    graph = ChatGraph(team, user).compile()

    config = {
        "configurable": {
            "thread_id": str(conversation.id),
            "checkpoint_ns": "",
        }
    }

    # First run - hits interrupt
    try:
        await graph.ainvoke({"messages": ["Start"]}, config=config)
    except NodeInterrupt:
        pass  # Expected

    # Check interrupt state
    snapshot = await graph.aget_state(config)
    print(f"Interrupted: {snapshot.next}")  # ['confirm']
    print(f"Interrupt value: {snapshot.tasks[0].interrupts[0].value}")

    # User provides confirmation
    await graph.aupdate_state(
        config,
        {"user_confirmed": True, "messages": ["User confirmed"]}
    )

    # Resume execution
    result = await graph.ainvoke(None, config=config)
    print(f"Final messages: {result['messages']}")
    # ['Start', 'User confirmed', 'Confirmed!', 'Processing complete']

    # Verify checkpoints saved
    checkpoints = [c async for c in global_checkpointer.alist(config)]
    print(f"Total checkpoints: {len(checkpoints)}")  # Multiple checkpoints

    # Load specific checkpoint
    checkpoint_tuple = await global_checkpointer.aget_tuple(config)
    print(f"Latest state: {checkpoint_tuple.checkpoint['channel_values']}")
```

---

## Key Takeaways

1. **DjangoCheckpointer** is a full LangGraph implementation using Django ORM for persistence
2. **Checkpoints** store complete graph state including channel values, versions, and metadata
3. **Namespaces** provide isolation for subgraphs using pipe-delimited paths
4. **State Resumption** enables continuing execution after interrupts or restarts
5. **NodeInterrupt** pauses execution for user interaction with various value types
6. **Global Checkpointer** singleton pattern simplifies configuration and ensures consistency

## Implementation Checklist

To implement from scratch:

- [ ] Create Django models: `ConversationCheckpoint`, `ConversationCheckpointBlob`, `ConversationCheckpointWrite`
- [ ] Implement `BaseCheckpointSaver[str]` with async methods
- [ ] Add serialization layer: `JsonPlusSerializer` for metadata, msgpack for blobs
- [ ] Implement channel versioning with monotonic IDs
- [ ] Add namespace support with pipe-delimited paths
- [ ] Implement efficient querying with `select_related()` and `prefetch_related()`
- [ ] Handle race conditions in `aput_writes()` with `get_or_create()`
- [ ] Add NodeInterrupt detection and handling in graph runner
- [ ] Create global checkpointer singleton
- [ ] Add tests for concurrent operations, resumption, and namespace isolation

---

This documentation provides everything needed to understand and reimplement the PostHog HogAI checkpoint and persistence system from scratch.
