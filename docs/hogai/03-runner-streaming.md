# PostHog HogAI Runner & Streaming Architecture

This document provides a comprehensive guide to the PostHog HogAI Runner and Streaming architecture. It covers the core components with enough detail to reimplement the system from scratch.

## Table of Contents

1. [Overview](#overview)
2. [BaseAgentRunner Class](#baseagentrunner-class)
3. [astream() Generator Pattern](#astream-generator-pattern)
4. [State Initialization](#state-initialization)
5. [Update Processing](#update-processing)
6. [Conversation Locking](#conversation-locking)
7. [Error Handling](#error-handling)
8. [AgentExecutor (Temporal)](#agentexecutor-temporal)
9. [Stream Processor Protocol](#stream-processor-protocol)
10. [Redis Stream Integration](#redis-stream-integration)

---

## Overview

The HogAI Runner & Streaming architecture consists of three main layers:

1. **BaseAgentRunner**: Orchestrates LangGraph execution, state management, and conversation lifecycle
2. **AgentExecutor**: Manages Temporal workflows and Redis stream integration for distributed execution
3. **Stream Processor**: Transforms raw LangGraph events into client-facing messages

### Architecture Flow

```
Client Request
    ↓
BaseAgentRunner.astream()
    ↓
LangGraph.astream() → Stream Processor → AssistantOutput
    ↓
Conversation Lock (IDLE → IN_PROGRESS)
    ↓
Yield events to client
    ↓
Conversation Lock (IN_PROGRESS → IDLE)
```

For distributed execution via Temporal:

```
Client Request
    ↓
AgentExecutor.astream()
    ↓
Start Temporal Workflow → BaseAgentRunner → Redis Stream
    ↓
AgentExecutor reads from Redis Stream
    ↓
Yield events to client
```

---

## BaseAgentRunner Class

The `BaseAgentRunner` is an abstract base class that orchestrates agent execution, state management, and conversation lifecycle.

### Constructor

```python
class BaseAgentRunner(ABC):
    def __init__(
        self,
        team: Team,
        conversation: Conversation,
        *,
        new_message: Optional[HumanMessage] = None,
        user: User,
        graph: CompiledStateGraph,
        state_type: type[AssistantMaxGraphState],
        partial_state_type: type[AssistantMaxPartialGraphState],
        mode: AssistantMode,
        session_id: Optional[str] = None,
        contextual_tools: Optional[dict[str, Any]] = None,
        is_new_conversation: bool = False,
        trace_id: Optional[str | UUID] = None,
        billing_context: Optional[MaxBillingContext] = None,
        initial_state: Optional[AssistantMaxGraphState | AssistantMaxPartialGraphState] = None,
        callback_handler: Optional[BaseCallbackHandler] = None,
        stream_processor: AssistantStreamProcessorProtocol,
        slack_thread_context: Optional["SlackThreadContext"] = None,
    ):
```

### Key Properties

```python
# Core components
_graph: CompiledStateGraph              # LangGraph state graph
_conversation: Conversation             # Database conversation model
_stream_processor: AssistantStreamProcessorProtocol  # Processes events

# State management
_state: Optional[AssistantMaxGraphState]  # Current graph state
_state_type: type[AssistantMaxGraphState]
_partial_state_type: type[AssistantMaxPartialGraphState]
_initial_state: Optional[AssistantMaxGraphState | AssistantMaxPartialGraphState]

# Configuration
_team: Team
_user: User
_mode: AssistantMode  # "assistant", "insights_tool", "deep_research"
_contextual_tools: dict[str, Any]

# Message tracking
_latest_message: Optional[HumanMessage | AssistantToolCallMessage]
_session_id: Optional[str]

# Observability
_callback_handlers: list[BaseCallbackHandler]
_trace_id: Optional[str | UUID]
_billing_context: Optional[MaxBillingContext]
```

### Constructor Implementation Details

```python
# Initialize the latest message with a new ID
self._latest_message = (
    new_message.model_copy(deep=True, update={"id": str(uuid4())})
    if new_message
    else None
)

# Initialize callback handlers for observability
if callback_handler:
    self._callback_handlers.append(callback_handler)
else:
    # Auto-initialize PostHog callback handlers
    def init_handler(client: posthoganalytics.Client):
        callback_properties = {
            "conversation_id": str(self._conversation.id),
            "$ai_session_id": str(self._conversation.id),
            "is_first_conversation": is_new_conversation,
            "$session_id": self._session_id,
            "assistant_mode": mode.value,
            "$groups": event_usage.groups(team=team),
        }
        return CallbackHandler(
            client,
            distinct_id=user.distinct_id if user else None,
            properties=callback_properties,
            trace_id=trace_id,
            privacy_mode=is_privacy_mode_enabled(team),
        )

    # Add regional clients for observability
    if not is_cloud() and (local_client := posthoganalytics.default_client):
        self._callback_handlers.append(init_handler(local_client))
    elif region := get_instance_region():
        self._callback_handlers.append(init_handler(get_client(region)))
        # EU instances also send to US for unified traces
        if region == "EU":
            self._callback_handlers.append(init_handler(get_client("US")))
```

### Abstract Methods

```python
@abstractmethod
def get_initial_state(self) -> AssistantMaxGraphState:
    """The initial state of the graph."""
    pass

@abstractmethod
def get_resumed_state(self) -> AssistantMaxPartialGraphState:
    """The state of the graph after a resume."""
    pass
```

---

## astream() Generator Pattern

The `astream()` method is an async generator that yields `AssistantOutput` tuples to the client.

### Signature

```python
async def astream(
    self,
    stream_message_chunks: bool = True,
    stream_subgraphs: bool = True,
    stream_first_message: bool = True,
    stream_only_assistant_messages: bool = False,
) -> AsyncGenerator[AssistantOutput, None]:
```

### AssistantOutput Type

```python
AssistantOutput = (
    tuple[Literal[AssistantEventType.CONVERSATION], Conversation]
    | tuple[Literal[AssistantEventType.MESSAGE], AssistantStreamedMessageUnion]
    | tuple[Literal[AssistantEventType.STATUS], AssistantGenerationStatusEvent]
    | tuple[Literal[AssistantEventType.UPDATE], AssistantUpdateEvent]
)
```

### Stream Mode Options

LangGraph supports three stream modes:

1. **"values"**: Emits complete state updates after each node execution
2. **"custom"**: Emits custom events dispatched by nodes
3. **"messages"**: Emits AIMessageChunk objects for real-time token streaming

```python
stream_mode: list[StreamMode] = ["values", "custom"]
if stream_message_chunks:
    stream_mode.append("messages")
```

### Subgraphs Parameter

The `subgraphs` parameter controls whether to stream events from nested graphs:

```python
generator: AsyncIterator[Any] = self._graph.astream(
    state,
    config=config,
    stream_mode=stream_mode,
    subgraphs=stream_subgraphs
)
```

### Complete Implementation

```python
async def astream(
    self,
    stream_message_chunks: bool = True,
    stream_subgraphs: bool = True,
    stream_first_message: bool = True,
    stream_only_assistant_messages: bool = False,
) -> AsyncGenerator[AssistantOutput, None]:
    # Initialize or update state
    state = await self._init_or_update_state()
    config = self._get_config()

    # Configure stream modes
    stream_mode: list[StreamMode] = ["values", "custom"]
    if stream_message_chunks:
        stream_mode.append("messages")

    # Create LangGraph generator
    generator: AsyncIterator[Any] = self._graph.astream(
        state, config=config, stream_mode=stream_mode, subgraphs=stream_subgraphs
    )

    # Execute within conversation lock
    async with self._lock_conversation():
        # Yield conversation ID for new conversations
        if not stream_only_assistant_messages and self._is_new_conversation:
            yield AssistantEventType.CONVERSATION, self._conversation

        # Yield the first message (human message with initialized ID)
        if stream_first_message and self._latest_message:
            yield AssistantEventType.MESSAGE, self._latest_message

        try:
            # Process updates from LangGraph
            async for update in generator:
                if messages := await self._process_update(update):
                    for message in messages:
                        # Always yield messages
                        if isinstance(message, get_args(AssistantStreamedMessageUnion)):
                            message = cast(AssistantStreamedMessageUnion, message)
                            yield AssistantEventType.MESSAGE, message

                        # Yield status and update events unless filtered
                        if stream_only_assistant_messages:
                            continue

                        if isinstance(message, AssistantGenerationStatusEvent):
                            yield AssistantEventType.STATUS, message
                        elif isinstance(message, AssistantUpdateEvent):
                            yield AssistantEventType.UPDATE, message

            # Handle interrupts (e.g., create_form tool calls)
            state = await self._graph.aget_state(config)
            if state.next:
                interrupt_messages = []
                for task in state.tasks:
                    for interrupt in task.interrupts:
                        if interrupt.value is None:
                            continue  # Skip None interrupts (used by create_form)

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
                    self._partial_state_type(
                        messages=interrupt_messages,
                        graph_status="interrupted",
                    ),
                )

        except GraphRecursionError:
            # Max recursion depth reached
            yield (
                AssistantEventType.MESSAGE,
                FailureMessage(
                    content="The assistant has reached the maximum number of steps. "
                           "You can explicitly ask to continue.",
                    id=str(uuid4()),
                ),
            )

        except LLM_API_EXCEPTIONS as e:
            # Reset state on LLM provider errors
            await self._graph.aupdate_state(config, self._partial_state_type.get_reset_state())

            provider = type(e).__module__.partition(".")[0] or "unknown_provider"
            LLM_PROVIDER_ERROR_COUNTER.labels(provider=provider).inc()
            logger.exception("llm_provider_error", error=str(e), provider=provider)

            # Capture exception for observability
            posthoganalytics.capture_exception(
                e,
                distinct_id=self._user.distinct_id if self._user else None,
                properties={
                    "error_type": "llm_provider_error",
                    "provider": provider,
                    "tag": "max_ai",
                },
            )

            yield (
                AssistantEventType.MESSAGE,
                FailureMessage(
                    content="I'm unable to respond right now due to a temporary service issue. "
                           "Please try again later.",
                    id=str(uuid4()),
                ),
            )

        except Exception as e:
            # Reset state on unhandled errors
            await self._graph.aupdate_state(config, self._partial_state_type.get_reset_state())

            if not isinstance(e, GenerationCanceled):
                logger.exception("Error in assistant stream", error=e)
                self._capture_exception(e)

                # Check if a failure message was already sent
                snapshot = await self._graph.aget_state(config)
                state_snapshot = validate_state_update(snapshot.values, self._state_type)

                if not state_snapshot.messages or not isinstance(
                    state_snapshot.messages[-1], FailureMessage
                ):
                    yield AssistantEventType.MESSAGE, FailureMessage()
```

### Yielding AssistantOutput Tuples

Each yielded tuple contains:

1. **Event Type**: One of `CONVERSATION`, `MESSAGE`, `STATUS`, or `UPDATE`
2. **Payload**: The associated data object

```python
# Example yields
yield AssistantEventType.CONVERSATION, conversation_obj
yield AssistantEventType.MESSAGE, assistant_message
yield AssistantEventType.STATUS, status_event
yield AssistantEventType.UPDATE, update_event
```

---

## State Initialization

State initialization handles both new conversations and resumptions after interrupts.

### _init_or_update_state() Logic

```python
async def _init_or_update_state(self):
    config = self._get_config()

    # Load checkpoint from LangGraph
    snapshot = await self._graph.aget_state(config)
    saved_state = validate_state_update(snapshot.values, self._state_type)
    last_recorded_dt = saved_state.start_dt

    # When resuming after create_form interrupt, create the tool call response message
    if form_response_message := self._get_form_response_message(saved_state):
        self._latest_message = form_response_message

    # Mark existing message IDs as streamed to prevent duplication
    for message in saved_state.messages:
        if message.id is not None:
            self._stream_processor.mark_id_as_streamed(message.id)

    # Mark latest message ID as streamed
    if self._latest_message and self._latest_message.id is not None:
        self._stream_processor.mark_id_as_streamed(self._latest_message.id)

    # RESUMPTION PATH: Check if graph is interrupted
    if snapshot.next and self._latest_message and saved_state.graph_status == "interrupted":
        self._state = saved_state
        await self._graph.aupdate_state(
            config,
            self.get_resumed_state(),
        )
        # Return None to continue from interrupted point
        return None

    # NEW GENERATION PATH: Initialize fresh state
    initial_state = self.get_initial_state()
    if self._initial_state:
        for key, value in self._initial_state.model_dump(exclude_none=True).items():
            setattr(initial_state, key, value)

    # Reset start_dt if conversation has been running for > 5 minutes
    # This helps keep cache fresh
    if last_recorded_dt is not None:
        if datetime.now() - last_recorded_dt > timedelta(minutes=5):
            initial_state.start_dt = datetime.now()
    else:
        # No recorded start_dt, set to current time
        initial_state.start_dt = datetime.now()

    self._state = initial_state
    return initial_state
```

### Checkpoint Loading

LangGraph checkpoints are loaded via `aget_state()`:

```python
snapshot = await self._graph.aget_state(config)
saved_state = validate_state_update(snapshot.values, self._state_type)
```

The snapshot contains:
- `values`: The state dictionary
- `next`: List of next nodes to execute (empty if graph completed)
- `tasks`: List of current tasks with any interrupts

### Resumption After Interrupts

Interrupts are detected by checking:

```python
if snapshot.next and self._latest_message and saved_state.graph_status == "interrupted":
    # Resume from interruption
    self._state = saved_state
    await self._graph.aupdate_state(config, self.get_resumed_state())
    return None
```

The `get_resumed_state()` method provides the partial state update needed to resume execution.

### start_dt Expiration (5 min)

The `start_dt` field tracks when the conversation began. It's reset after 5 minutes to keep caches fresh:

```python
if last_recorded_dt is not None:
    if datetime.now() - last_recorded_dt > timedelta(minutes=5):
        initial_state.start_dt = datetime.now()
else:
    initial_state.start_dt = datetime.now()
```

### Form Response Message Handling

When resuming after a `create_form` tool call, the human message containing form answers is transformed into an `AssistantToolCallMessage`:

```python
def _get_form_response_message(
    self, saved_state: AssistantMaxGraphState
) -> AssistantToolCallMessage | None:
    """
    When resuming after a create_form tool call (which raises NodeInterrupt(None)),
    create an AssistantToolCallMessage with the user's response content
    and parsed answers in ui_payload.
    """
    if not saved_state.messages or not self._latest_message:
        return None

    # Form responses must come from a HumanMessage
    if not isinstance(self._latest_message, HumanMessage):
        return None

    # Check if we have form answers in the ui_context
    if not self._latest_message.ui_context or not self._latest_message.ui_context.form_answers:
        return None

    # Find the last assistant message with tool calls
    last_assistant_message = find_last_message_of_type(saved_state.messages, AssistantMessage)
    if not last_assistant_message or not last_assistant_message.tool_calls:
        return None

    # Find the create_form tool call
    create_form_tool_call = next(
        (tc for tc in last_assistant_message.tool_calls if tc.name == "create_form"),
        None,
    )
    if not create_form_tool_call:
        return None

    answers = self._latest_message.ui_context.form_answers

    return AssistantToolCallMessage(
        content=self._latest_message.content or "",
        id=str(uuid4()),
        tool_call_id=create_form_tool_call.id,
        ui_payload={"create_form": {"answers": answers}},
    )
```

---

## Update Processing

Update processing transforms raw LangGraph events into client-facing messages.

### _process_update() Delegation

```python
async def _process_update(self, update: Any) -> list[AssistantResultUnion] | None:
    update = extract_stream_update(update)

    if not isinstance(update, AssistantDispatcherEvent):
        # LangGraph update event (state changes, message chunks)
        if updates := await self._stream_processor.process_langgraph_update(
            LangGraphUpdateEvent(update=update)
        ):
            return updates
    elif new_message := await self._stream_processor.process(update):
        # Custom dispatcher event
        return new_message

    return None
```

### AssistantDispatcherEvent Handling

Dispatcher events are custom events emitted by nodes:

```python
class AssistantDispatcherEvent(BaseModel):
    action: AssistantActionUnion = Field(discriminator="type")
    node_path: tuple[NodePath, ...] | None = None
    node_name: str
    node_run_id: str
```

Action types:

```python
AssistantActionUnion = (
    MessageAction          # Complete message
    | MessageChunkAction   # Streaming token chunk
    | NodeStartAction      # Node execution started
    | NodeEndAction        # Node execution ended
    | UpdateAction         # Tool execution update
)
```

Example dispatcher event processing:

```python
async def process(self, event: AssistantDispatcherEvent) -> list[AssistantResultUnion] | None:
    action = event.action

    if isinstance(action, NodeStartAction):
        # Initialize chunk buffer for streaming
        self._chunks[event.node_run_id] = AIMessageChunk(content="")
        return [AssistantGenerationStatusEvent(type=AssistantGenerationStatusType.ACK)]

    if isinstance(action, NodeEndAction):
        # Clean up chunk buffer
        if event.node_run_id in self._chunks:
            del self._chunks[event.node_run_id]
        return await self._handle_node_end(event, action)

    if isinstance(action, MessageChunkAction):
        if result := self._handle_message_stream(event, action.message):
            return [result]

    if isinstance(action, MessageAction):
        message = action.message
        if result := await self._handle_message(event, message):
            return [result]

    if isinstance(action, UpdateAction):
        if update_event := self._handle_update_message(event, action):
            return [update_event]

    return None
```

### LangGraphUpdateEvent Handling

LangGraph emits three types of updates:

1. **State updates** (from "values" stream mode)
2. **Message chunks** (from "messages" stream mode)
3. **Custom events** (from "custom" stream mode)

```python
async def process_langgraph_update(
    self, event: LangGraphUpdateEvent
) -> list[AssistantResultUnion] | None:
    if is_message_update(event.update):
        # Convert message chunk to dispatcher event
        maybe_message_chunk, state = event.update[1]
        if not isinstance(maybe_message_chunk, AIMessageChunk):
            return None

        action = AssistantDispatcherEvent(
            action=MessageChunkAction(message=maybe_message_chunk),
            node_name=state["langgraph_node"],
            node_run_id=state["langgraph_checkpoint_ns"],
        )
        return await self.process(action)

    if is_state_update(event.update):
        # Update internal state tracking
        new_state = self._state_type.model_validate(event.update[1])
        self._state = new_state

    return None
```

### Message Deduplication

Messages are deduplicated by ID to prevent re-streaming:

```python
# In _init_or_update_state():
for message in saved_state.messages:
    if message.id is not None:
        self._stream_processor.mark_id_as_streamed(message.id)

# In stream processor:
if isinstance(produced_message, MESSAGE_TYPE_TUPLE) and produced_message.id is not None:
    if produced_message.id in self._streamed_update_ids:
        return None  # Already streamed
    self._streamed_update_ids.add(produced_message.id)
```

The deduplication strategy:
- Messages **with IDs** are persisted and must be deduplicated
- Messages **without IDs** are ephemeral (streaming chunks) and always sent

---

## Conversation Locking

Conversation locking prevents concurrent executions using a status-based state machine.

### Status State Machine

```
IDLE → IN_PROGRESS → IDLE
```

Status values from the `Conversation.Status` enum:

```python
class Status(models.TextChoices):
    IDLE = "idle"
    IN_PROGRESS = "in_progress"
    CANCELING = "canceling"
```

### Lock Acquisition

The lock is implemented as an async context manager:

```python
@asynccontextmanager
async def _lock_conversation(self):
    try:
        self._conversation.status = Conversation.Status.IN_PROGRESS
        await self._conversation.asave(update_fields=["status"])
        yield
    finally:
        self._conversation.status = Conversation.Status.IDLE
        await self._conversation.asave(update_fields=["status", "updated_at"])
```

### Usage

```python
async with self._lock_conversation():
    # Execute graph and stream results
    async for update in generator:
        if messages := await self._process_update(update):
            for message in messages:
                yield AssistantEventType.MESSAGE, message
```

### Lock Cleanup

The `finally` block ensures the conversation is unlocked even if an exception occurs:

```python
finally:
    self._conversation.status = Conversation.Status.IDLE
    await self._conversation.asave(update_fields=["status", "updated_at"])
```

---

## Error Handling

The runner implements comprehensive error handling with automatic state reset.

### GraphRecursionError

Occurs when the graph exceeds the recursion limit (default: 48 steps):

```python
except GraphRecursionError:
    yield (
        AssistantEventType.MESSAGE,
        FailureMessage(
            content="The assistant has reached the maximum number of steps. "
                   "You can explicitly ask to continue.",
            id=str(uuid4()),
        ),
    )
```

The recursion limit is configured in `_get_config()`:

```python
config: RunnableConfig = {
    "recursion_limit": 48,
    # ...
}
```

### LLM_API_EXCEPTIONS

Catches API errors from LLM providers (OpenAI, Anthropic):

```python
# In ee/hogai/utils/exceptions.py
import openai
import anthropic

LLM_API_EXCEPTIONS = (anthropic.APIError, openai.APIError)
```

Error handling:

```python
except LLM_API_EXCEPTIONS as e:
    # Reset state for retry
    await self._graph.aupdate_state(config, self._partial_state_type.get_reset_state())

    # Extract provider name from exception module
    provider = type(e).__module__.partition(".")[0] or "unknown_provider"

    # Increment metrics
    LLM_PROVIDER_ERROR_COUNTER.labels(provider=provider).inc()

    # Log exception
    logger.exception("llm_provider_error", error=str(e), provider=provider)

    # Capture for observability
    posthoganalytics.capture_exception(
        e,
        distinct_id=self._user.distinct_id if self._user else None,
        properties={
            "error_type": "llm_provider_error",
            "provider": provider,
            "tag": "max_ai",
        },
    )

    # Return user-friendly error
    yield (
        AssistantEventType.MESSAGE,
        FailureMessage(
            content="I'm unable to respond right now due to a temporary service issue. "
                   "Please try again later.",
            id=str(uuid4()),
        ),
    )
```

### GenerationCanceled

Special exception for user-initiated cancellation:

```python
class GenerationCanceled(Exception):
    """Raised when generation is canceled."""
    pass
```

Handling:

```python
except Exception as e:
    await self._graph.aupdate_state(config, self._partial_state_type.get_reset_state())

    if not isinstance(e, GenerationCanceled):
        # Log and report non-cancellation errors
        logger.exception("Error in assistant stream", error=e)
        self._capture_exception(e)

        # Check if failure message already sent
        snapshot = await self._graph.aget_state(config)
        state_snapshot = validate_state_update(snapshot.values, self._state_type)

        if not state_snapshot.messages or not isinstance(
            state_snapshot.messages[-1], FailureMessage
        ):
            yield AssistantEventType.MESSAGE, FailureMessage()
```

### State Reset on Errors

All error paths reset the state to allow retry:

```python
await self._graph.aupdate_state(config, self._partial_state_type.get_reset_state())
```

The `get_reset_state()` method returns a fresh state instance:

```python
class BaseState(BaseModel):
    @classmethod
    def get_reset_state(cls) -> Self:
        """Returns a new instance with all fields reset to their default values."""
        return cls(**{k: v.default for k, v in cls.model_fields.items()})
```

---

## AgentExecutor (Temporal)

The `AgentExecutor` manages distributed execution via Temporal workflows and Redis streams.

### Class Overview

```python
class AgentExecutor:
    """Manages executing an agent workflow and streaming the output."""

    def __init__(
        self,
        conversation: Conversation,
        timeout: int = CONVERSATION_STREAM_TIMEOUT,  # 30 minutes
        max_length: int = CONVERSATION_STREAM_MAX_LENGTH,  # 1000 messages
    ) -> None:
        self._conversation = conversation
        self._redis_stream = ConversationRedisStream(
            get_conversation_stream_key(conversation.id),
            timeout=timeout,
            max_length=max_length
        )
        self._workflow_id = f"conversation-{conversation.id}"
```

### Redis Stream Integration

The executor uses Redis streams as a message queue between Temporal and Django:

```
Temporal Workflow → Redis Stream → Django/FastAPI → Client
```

Key components:

```python
# Stream key generation
def get_conversation_stream_key(conversation_id: UUID) -> str:
    return f"{CONVERSATION_STREAM_PREFIX}{conversation_id}"

# Constants
CONVERSATION_STREAM_PREFIX = "conversation-stream:"
CONVERSATION_STREAM_TIMEOUT = 30 * 60  # 30 minutes
CONVERSATION_STREAM_MAX_LENGTH = 1000  # Maximum messages in stream
```

### Workflow Starting

```python
async def start_workflow(
    self, workflow: type[AgentBaseWorkflow], inputs: Any
) -> AsyncGenerator[AssistantOutput, Any]:
    try:
        # Delete stale stream from previous run
        await self._redis_stream.delete_stream()

        # Connect to Temporal
        client = await async_connect()

        # Start workflow
        handle = await client.start_workflow(
            workflow.run,
            inputs,
            id=self._workflow_id,
            task_queue=settings.MAX_AI_TASK_QUEUE,
            id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING,
            id_reuse_policy=WorkflowIDReusePolicy.ALLOW_DUPLICATE,
        )

        # Wait for workflow to start
        is_workflow_running = await self._wait_for_workflow_to_start(handle)
        if not is_workflow_running:
            raise Exception(f"Workflow failed to start within timeout: {self._workflow_id}")

    except Exception as e:
        logger.exception("Error starting workflow", error=e)
        yield self._failure_message()
        return

    # Stream from Redis
    async for chunk in self.stream_conversation():
        yield chunk
```

Key workflow configuration:

- **id_conflict_policy**: `USE_EXISTING` - reuse existing workflow if found
- **id_reuse_policy**: `ALLOW_DUPLICATE` - allow workflow ID reuse after completion
- **task_queue**: `settings.MAX_AI_TASK_QUEUE` - Temporal task queue name

### Wait for Workflow Start

```python
async def _wait_for_workflow_to_start(self, handle: WorkflowHandle) -> bool:
    """Wait for the workflow to start running.

    Returns:
        True if workflow started running, False otherwise
    """
    max_attempts = 10 * 60  # 60 seconds total with 0.1s sleep
    attempts = 0

    while attempts < max_attempts:
        description = await handle.describe()
        if description.status is None:
            attempts += 1
            await asyncio.sleep(0.1)
        elif description.status == WorkflowExecutionStatus.RUNNING:
            # Temporal only has one Open execution status
            return True
        else:
            return False

    return False
```

### Stream from Checkpoint

The main entry point handles both new generations and reconnections:

```python
async def astream(
    self, workflow: type[AgentBaseWorkflow], inputs: Any
) -> AsyncGenerator[AssistantOutput, Any]:
    """Stream agent workflow updates from Redis stream.

    Args:
        workflow: Agent temporal workflow class
        inputs: Agent temporal workflow inputs

    Returns:
        AssistantOutput generator
    """
    # Check if this is a reconnection
    if self._conversation.status != Conversation.Status.IDLE:
        if inputs.message is not None:
            raise ValueError("Cannot resume streaming with a new message")

        # Resume streaming from existing workflow
        async for chunk in self.stream_conversation():
            yield chunk
    else:
        # Start new workflow
        async for chunk in self.start_workflow(workflow, inputs):
            yield chunk
```

### Stream Conversation from Redis

```python
async def stream_conversation(self) -> AsyncGenerator[AssistantOutput, Any]:
    """Stream conversation updates from Redis stream.

    Returns:
        AssistantOutput generator
    """
    try:
        # Wait for stream to be created by Temporal workflow
        is_stream_available = await self._redis_stream.wait_for_stream()
        if not is_stream_available:
            raise StreamError(
                "Stream for this conversation not available - "
                "Temporal workflow might have failed"
            )

        last_chunk_time = time.time()
        async for chunk in self._redis_stream.read_stream():
            message = await self._redis_stream_to_assistant_output(chunk)

            # Track latency
            temporal_to_code_latency = last_chunk_time - chunk.timestamp
            if temporal_to_code_latency > 0:
                STREAM_DJANGO_EVENT_LOOP_LATENCY_HISTOGRAM.observe(temporal_to_code_latency)
            last_chunk_time = time.time()

            if message:
                yield message

    except Exception as e:
        logger.exception("Error streaming conversation", error=e)
        yield self._failure_message()

    finally:
        # Always clean up Redis stream
        await self._redis_stream.delete_stream()
```

### Redis to AssistantOutput Conversion

```python
async def _redis_stream_to_assistant_output(
    self, message: StreamEvent
) -> AssistantOutput | None:
    """Convert Redis stream event to Assistant output.

    Args:
        message: event from Redis stream

    Returns:
        AssistantOutput or None
    """
    if isinstance(message.event, MessageEvent):
        return (AssistantEventType.MESSAGE, message.event.payload)

    elif isinstance(message.event, ConversationEvent):
        conversation = await Conversation.objects.select_related("user").aget(
            id=message.event.payload
        )
        return (AssistantEventType.CONVERSATION, conversation)

    elif isinstance(message.event, UpdateEvent):
        return (AssistantEventType.UPDATE, message.event.payload)

    elif isinstance(message.event, GenerationStatusEvent):
        return (AssistantEventType.STATUS, message.event.payload)

    else:
        return None
```

### Workflow Cancellation

```python
async def cancel_workflow(self) -> None:
    """Cancel the current conversation and clean up resources.

    Raises:
        Exception: If cancellation fails
    """
    # Mark as canceling
    self._conversation.status = Conversation.Status.CANCELING
    await self._conversation.asave(update_fields=["status", "updated_at"])

    # Cancel Temporal workflow
    client = await async_connect()
    handle = client.get_workflow_handle(workflow_id=self._workflow_id)
    await handle.cancel()

    # Clean up Redis stream
    await self._redis_stream.delete_stream()

    # Mark as idle
    self._conversation.status = Conversation.Status.IDLE
    await self._conversation.asave(update_fields=["status", "updated_at"])
```

---

## Stream Processor Protocol

The stream processor protocol defines the interface for transforming raw events into client messages.

### Protocol Definition

```python
class AssistantStreamProcessorProtocol(Protocol[T]):
    """Protocol defining the interface for assistant stream processors."""

    _team: Team
    """The team."""

    _user: User
    """The user."""

    _streamed_update_ids: set[str]
    """Tracks the IDs of messages that have been streamed."""

    def process(
        self, event: AssistantDispatcherEvent
    ) -> Coroutine[Any, Any, list[T] | None]:
        """Process a dispatcher event and return a result or None."""
        ...

    def process_langgraph_update(
        self, event: LangGraphUpdateEvent
    ) -> Coroutine[Any, Any, list[T] | None]:
        """Process a LangGraph update event and return a list of results or None."""
        ...

    def mark_id_as_streamed(self, message_id: str) -> None:
        """Mark a message ID as streamed."""
        self._streamed_update_ids.add(message_id)
```

### ChatAgentStreamProcessor Implementation

The concrete implementation handles message transformation and deduplication:

```python
class ChatAgentStreamProcessor(AssistantStreamProcessorProtocol, Generic[StateType]):
    """
    Reduces streamed actions to client-facing messages.

    The stream processor maintains state about message chains and delegates to
    specialized handlers based on action type and message characteristics.
    """

    _verbose_nodes: set[MaxNodeName]
    """Nodes that emit messages."""

    _streaming_nodes: set[MaxNodeName]
    """Nodes that produce streaming messages."""

    _chunks: dict[str, AIMessageChunk]
    """Tracks the current message chunk."""

    _state: StateType | None
    """Tracks the current state."""

    _state_type: type[StateType]
    """The type of the state."""
```

### Initialization

```python
def __init__(
    self,
    team: Team,
    user: User,
    verbose_nodes: set[MaxNodeName],
    streaming_nodes: set[MaxNodeName],
    state_type: type[StateType],
):
    """
    Initialize the stream processor with node configuration.

    Args:
        team: The team
        user: The user
        verbose_nodes: Nodes that produce messages
        streaming_nodes: Nodes that produce streaming messages
        state_type: The type of the state
    """
    self._team = team
    self._user = user
    # If a node is streaming node, it should also be verbose
    self._verbose_nodes = verbose_nodes | streaming_nodes
    self._streaming_nodes = streaming_nodes
    self._streamed_update_ids: set[str] = set()
    self._chunks = {}
    self._state_type = state_type
    self._state = None
    self._artifact_manager = ArtifactManager(self._team, self._user)
```

### Process Method

```python
async def process(
    self, event: AssistantDispatcherEvent
) -> list[AssistantResultUnion] | None:
    """
    Reduce streamed actions to client messages.

    This is the main entry point for processing actions from nodes.
    """
    action = event.action

    if isinstance(action, NodeStartAction):
        # Initialize chunk buffer for streaming
        self._chunks[event.node_run_id] = AIMessageChunk(content="")
        return [AssistantGenerationStatusEvent(type=AssistantGenerationStatusType.ACK)]

    if isinstance(action, NodeEndAction):
        # Clean up chunk buffer
        if event.node_run_id in self._chunks:
            del self._chunks[event.node_run_id]
        return await self._handle_node_end(event, action)

    if isinstance(action, MessageChunkAction):
        if result := self._handle_message_stream(event, action.message):
            return [result]

    if isinstance(action, MessageAction):
        message = action.message
        if result := await self._handle_message(event, message):
            return [result]

    if isinstance(action, UpdateAction):
        if update_event := self._handle_update_message(event, action):
            return [update_event]

    return None
```

### Message Streaming

```python
def _handle_message_stream(
    self, event: AssistantDispatcherEvent, message: AIMessageChunk
) -> AssistantStreamedMessageUnion | None:
    """
    Process LLM chunks from "messages" stream mode.

    With dispatch pattern, complete messages are dispatched by nodes.
    This handles AIMessageChunk for ephemeral streaming (responsiveness).
    """
    node_name = cast(MaxNodeName, event.node_name)
    run_id = event.node_run_id

    # Only stream from configured streaming nodes
    if node_name not in self._streaming_nodes:
        return None

    # Initialize chunk buffer if needed
    if run_id not in self._chunks:
        self._chunks[run_id] = AIMessageChunk(content="")

    # Merge message chunks
    self._chunks[run_id] = merge_message_chunk(self._chunks[run_id], message)

    # Stream ephemeral message (no ID = not persisted)
    return normalize_ai_message(self._chunks[run_id])
```

### Nested Message Filtering

The processor filters messages based on graph nesting level:

```python
def _is_message_from_nested_node_or_graph(
    self, node_path: tuple[NodePath, ...]
) -> bool:
    """Check if the message is from a nested node or graph."""
    if not node_path:
        return False

    # The first path is always the top-level graph
    if len(node_path) > 2:
        # The second path is a top-level node
        # Check the next node to see if it's a nested node or graph
        return find_subgraph(node_path[2:])

    return False

async def _handle_message(
    self, action: AssistantDispatcherEvent, message: AssistantStreamedMessageUnion
) -> AssistantStreamedMessageUnion | None:
    """Handle a message from a node."""
    node_name = cast(MaxNodeName, action.node_name)
    produced_message: AssistantStreamedMessageUnion | None = None

    # ArtifactRefMessage must always be enriched with content
    if isinstance(message, ArtifactRefMessage):
        try:
            enriched_message = await self._artifact_manager.aget_enriched_message(message)
        except (ValueError, KeyError) as e:
            logger.warning(
                "Failed to enrich ArtifactMessage",
                error=str(e),
                artifact_id=message.artifact_id
            )
            enriched_message = None

        if not enriched_message:
            return None
        message = enriched_message

    # Output all messages from the top-level graph
    if not self._is_message_from_nested_node_or_graph(action.node_path or ()):
        produced_message = self._handle_root_message(message, node_name)
    # Special child messages (viz, notebook, failure, tool call)
    else:
        produced_message = self._handle_special_child_message(message)

    # Deduplicate messages with IDs
    if isinstance(produced_message, MESSAGE_TYPE_TUPLE) and produced_message.id is not None:
        if produced_message.id in self._streamed_update_ids:
            return None
        self._streamed_update_ids.add(produced_message.id)

    return produced_message
```

---

## Redis Stream Integration

Redis streams provide a durable, ordered message queue for Temporal-to-Django communication.

### ConversationRedisStream Class

```python
class ConversationRedisStream:
    """Manages conversation streaming from Redis streams."""

    def __init__(
        self,
        stream_key: str,
        timeout: int = CONVERSATION_STREAM_TIMEOUT,  # 30 minutes
        max_length: int = CONVERSATION_STREAM_MAX_LENGTH,  # 1000 messages
    ):
        self._stream_key = stream_key
        self._redis_client = get_async_client(settings.REDIS_URL)
        self._deletion_lock = asyncio.Lock()
        self._serializer = ConversationStreamSerializer()
        self._timeout = timeout
        self._max_length = max_length
```

### Stream Serialization

```python
class ConversationStreamSerializer:
    serialization_key = "data"

    def dumps(self, event: AssistantOutput | StatusPayload) -> dict[str, bytes] | None:
        """Serialize an event to a dictionary of bytes."""
        if isinstance(event, StatusPayload):
            return self._serialize(StreamStatusEvent(payload=event))
        else:
            event_type, event_data = event
            if event_type == AssistantEventType.MESSAGE:
                return self._serialize(
                    self._to_message_event(cast(AssistantStreamedMessageUnion, event_data))
                )
            elif event_type == AssistantEventType.CONVERSATION:
                return self._serialize(
                    self._to_conversation_event(cast(Conversation, event_data))
                )
            elif event_type == AssistantEventType.STATUS:
                return self._serialize(
                    self._to_status_event(cast(AssistantGenerationStatusEvent, event_data))
                )
            elif event_type == AssistantEventType.UPDATE:
                return self._serialize(
                    self._to_update_event(cast(AssistantUpdateEvent, event_data))
                )
            else:
                raise ValueError(f"Unknown event type: {event_type}")

    def _serialize(self, event: StreamEventUnion | None) -> dict[str, bytes] | None:
        if event is None:
            return None

        return {
            self.serialization_key: pickle.dumps(
                StreamEvent(event=event)
            ),
        }

    def deserialize(self, data: dict[bytes, bytes]) -> StreamEvent:
        return pickle.loads(data[bytes(self.serialization_key, "utf-8")])
```

### Wait for Stream

Uses linear backoff to wait for stream creation:

```python
async def wait_for_stream(self) -> bool:
    """Wait for stream to be created using linear backoff.

    Returns:
        True if stream was created, False otherwise
    """
    delay = 0.05  # Start with 50ms
    delay_increment = 0.15  # Increment by 150ms each attempt
    max_delay = 2.0  # Cap at 2 seconds
    timeout = 60.0  # 60 seconds timeout
    start_time = asyncio.get_event_loop().time()
    last_iteration_time = None

    while True:
        current_time = time.time()
        if last_iteration_time is not None:
            iteration_duration = current_time - last_iteration_time
            REDIS_STREAM_INIT_ITERATION_LATENCY_HISTOGRAM.observe(iteration_duration)
        last_iteration_time = current_time

        elapsed_time = asyncio.get_event_loop().time() - start_time
        if elapsed_time >= timeout:
            logger.debug(
                f"Stream creation timeout after {elapsed_time:.2f}s",
                stream_key=self._stream_key,
            )
            return False

        if await self._redis_client.exists(self._stream_key):
            return True

        logger.debug(
            f"Stream not found, retrying in {delay}s (elapsed: {elapsed_time:.2f}s)",
            stream_key=self._stream_key,
        )
        await asyncio.sleep(delay)

        # Linear backoff
        delay = min(delay + delay_increment, max_delay)
```

### Read Stream

```python
async def read_stream(
    self,
    start_id: str = "0",
    block_ms: int = 50,  # Block for 50ms waiting for new messages
    count: Optional[int] = CONVERSATION_STREAM_CONCURRENT_READ_COUNT,  # 8 messages
) -> AsyncGenerator[StreamEvent, None]:
    """
    Read updates from Redis stream.

    Args:
        start_id: Stream ID to start reading from ("0" for beginning, "$" for new)
        block_ms: How long to block waiting for new messages (milliseconds)
        count: Maximum number of messages to read

    Yields:
        StreamEvent
    """
    current_id = start_id
    start_time = asyncio.get_event_loop().time()
    last_iteration_time = None

    while True:
        current_time = time.time()
        if last_iteration_time is not None:
            iteration_duration = current_time - last_iteration_time
            REDIS_READ_ITERATION_LATENCY_HISTOGRAM.observe(iteration_duration)
        last_iteration_time = current_time

        # Check timeout
        if asyncio.get_event_loop().time() - start_time > self._timeout:
            raise StreamError("Stream timeout - conversation took too long to complete")

        try:
            messages = await self._redis_client.xread(
                {self._stream_key: current_id},
                block=block_ms,
                count=count,
            )

            if not messages:
                # No new messages after blocking, continue polling
                continue

            for _, stream_messages in messages:
                for stream_id, message in stream_messages:
                    current_id = stream_id
                    data = self._serializer.deserialize(message)

                    # Track latency
                    latency = time.time() - data.timestamp
                    REDIS_TO_CLIENT_LATENCY_HISTOGRAM.observe(latency)

                    # Handle stream status
                    if isinstance(data.event, StreamStatusEvent):
                        if data.event.payload.status == "complete":
                            return
                        elif data.event.payload.status == "error":
                            error = data.event.payload.error or "Unknown error"
                            if error:
                                raise StreamError(error)
                            continue
                    else:
                        yield data

        except redis_exceptions.ConnectionError:
            raise StreamError("Connection lost to conversation stream")
        except redis_exceptions.TimeoutError:
            raise StreamError("Stream read timeout")
        except redis_exceptions.RedisError:
            raise StreamError("Stream read error")
        except Exception:
            raise StreamError("Unexpected error reading conversation stream")
```

### Write to Stream

```python
async def write_to_stream(
    self,
    generator: AsyncGenerator[AssistantOutput, None],
    callback: Callable[[], None] | None = None
) -> None:
    """Write to the Redis stream.

    Args:
        generator: AsyncGenerator of AssistantOutput
        callback: Callback to trigger after each message is written
    """
    try:
        await self._redis_client.expire(self._stream_key, self._timeout)

        last_iteration_time = None
        async for chunk in generator:
            current_time = time.time()
            if last_iteration_time is not None:
                iteration_duration = current_time - last_iteration_time
                REDIS_WRITE_ITERATION_LATENCY_HISTOGRAM.observe(iteration_duration)
            last_iteration_time = current_time

            message = self._serializer.dumps(chunk)
            if message is not None:
                await self._redis_client.xadd(
                    self._stream_key,
                    message,
                    maxlen=self._max_length,
                    approximate=True,
                )

            if callback:
                callback()

        # Mark the stream as complete
        status_message = StatusPayload(status="complete")
        completion_message = self._serializer.dumps(status_message)
        await self._redis_client.xadd(
            self._stream_key,
            completion_message,
            maxlen=self._max_length,
            approximate=True,
        )

    except Exception as e:
        # Mark the stream as failed
        error_message = StatusPayload(status="error", error=str(e))
        message = self._serializer.dumps(error_message)
        await self._redis_client.xadd(
            self._stream_key,
            message,
            maxlen=self._max_length,
            approximate=True,
        )
        raise StreamError("Failed to write to stream")
```

### Delete Stream

```python
async def delete_stream(self) -> bool:
    """Delete the Redis stream for this conversation.

    Returns:
        True if stream was deleted, False otherwise
    """
    async with self._deletion_lock:
        try:
            return await self._redis_client.delete(self._stream_key) > 0
        except Exception:
            logger.exception("Failed to delete stream", stream_key=self._stream_key)
            return False
```

---

## Summary

The PostHog HogAI Runner & Streaming architecture provides:

1. **Flexible Execution**: Support for both direct LangGraph execution and distributed Temporal workflows
2. **Robust State Management**: Checkpoint-based state with automatic resumption after interrupts
3. **Real-time Streaming**: Multi-mode streaming (values, custom, messages) with token-level responsiveness
4. **Error Recovery**: Comprehensive error handling with automatic state reset
5. **Distributed Architecture**: Redis streams enable decoupled producer/consumer pattern
6. **Observability**: Prometheus metrics and PostHog callback handlers throughout
7. **Message Deduplication**: ID-based tracking prevents duplicate message delivery

This architecture enables PostHog to run complex, multi-step AI workflows with:
- Sub-second responsiveness via streaming
- Multi-hour conversation support via Temporal
- Automatic recovery from failures
- Full audit trail and observability
