# PostHog HogAI Core Execution Framework

This document provides comprehensive documentation of the PostHog HogAI core execution framework. The framework is built on top of LangGraph and provides a structured way to build AI agent graphs with nodes, state management, dispatching, and execution context tracking.

## Table of Contents

1. [Understanding LangChain & LangGraph](#understanding-langchain--langgraph)
2. [What LangGraph Provides](#what-langgraph-provides)
3. [What HogAI Adds on Top](#what-hogai-adds-on-top)
4. [Building Without LangGraph](#building-without-langgraph)
5. [Overview](#overview)
6. [Class Hierarchy](#class-hierarchy)
7. [Execution Pipeline](#execution-pipeline)
8. [Node Path Context](#node-path-context)
9. [Dispatcher Integration](#dispatcher-integration)
10. [Graph Building API](#graph-building-api)
11. [Complete Implementation Guide](#complete-implementation-guide)

---

## Understanding LangChain & LangGraph

### What is LangChain?

**LangChain** is a Python/JavaScript framework for building applications with Large Language Models (LLMs). Think of it as a toolkit that provides:

1. **LLM Abstractions**: Unified interface to call different LLM providers (OpenAI, Anthropic, etc.)
2. **Tool Calling**: Standard way to define "tools" that LLMs can invoke
3. **Message Types**: Structured message formats (`HumanMessage`, `AIMessage`, `ToolMessage`)
4. **Runnable Protocol**: A standard interface (`Runnable`) for composable components

**Key LangChain concepts used in HogAI:**

```python
# LangChain message types
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage

# LangChain tool base class
from langchain_core.tools import BaseTool

# LangChain configuration object (passed through execution)
from langchain_core.runnables import RunnableConfig

# LangChain LLM interface
from langchain_openai import ChatOpenAI
```

### What is LangGraph?

**LangGraph** is built on top of LangChain and adds **stateful, multi-step workflows** (called "graphs"). While LangChain handles single LLM calls, LangGraph handles:

- **Multi-step agent loops** (LLM → Tool → LLM → Tool → ...)
- **State persistence** (save/resume conversations)
- **Conditional branching** (route to different nodes based on state)
- **Parallel execution** (run multiple nodes simultaneously)
- **Streaming** (emit events during execution)

**Mental Model:**
```
LangChain = "How do I call an LLM and define tools?"
LangGraph = "How do I orchestrate multiple LLM calls with branching, looping, and state?"
```

### The Graph Abstraction

LangGraph models your agent as a **directed graph**:

```
┌─────────────────────────────────────────────────────────────────┐
│                         LANGGRAPH                               │
│                                                                 │
│   ┌─────────┐                                                   │
│   │  START  │ ← Entry point                                     │
│   └────┬────┘                                                   │
│        │                                                        │
│        ↓                                                        │
│   ┌─────────┐         ┌─────────────┐                           │
│   │  ROOT   │ ──────→ │ ROOT_TOOLS  │ ← Nodes (your code)       │
│   │  (LLM)  │ ←────── │  (execute)  │                           │
│   └────┬────┘         └─────────────┘                           │
│        │                                                        │
│        ↓ (no more tools)                                        │
│   ┌─────────┐                                                   │
│   │   END   │ ← Exit point                                      │
│   └─────────┘                                                   │
│                                                                 │
│   Edges define flow. Nodes are functions that transform state.  │
└─────────────────────────────────────────────────────────────────┘
```

**Key concepts:**
- **Nodes**: Functions that receive state and return state updates
- **Edges**: Connections between nodes (can be conditional)
- **State**: A typed dictionary that flows through the graph
- **Checkpointer**: Saves state for persistence/resumption

---

## What LangGraph Provides

LangGraph gives you these capabilities "for free":

### 1. State Management with Reducers

```python
from langgraph.graph import StateGraph
from typing import Annotated

# Define how fields merge when nodes return updates
def add_messages(existing: list, new: list) -> list:
    """Custom reducer: append new messages to existing."""
    return existing + new

class MyState(TypedDict):
    # Annotated with a reducer function
    messages: Annotated[list, add_messages]
    count: int  # No reducer = replace on update

# Create graph with state type
graph = StateGraph(MyState)
```

**What this means:**
- When a node returns `{"messages": [new_msg]}`, LangGraph automatically calls `add_messages(existing_messages, [new_msg])`
- Without reducers, you'd need to manually merge state in every node

### 2. Conditional Routing

```python
from langgraph.graph import END

def route_based_on_state(state: MyState) -> str:
    """Return the name of the next node."""
    if state["messages"][-1].tool_calls:
        return "tools_node"  # Go execute tools
    return END  # Finish

graph.add_conditional_edges(
    "llm_node",           # From this node
    route_based_on_state, # Call this function
    {
        "tools_node": "tools_node",
        END: END,
    }
)
```

**What this means:**
- After `llm_node` runs, LangGraph calls `route_based_on_state(state)`
- Based on return value, it routes to the next node
- Without this, you'd need to implement your own routing logic

### 3. Parallel Execution with `Send`

```python
from langgraph.types import Send

def route_to_parallel_tools(state: MyState) -> list[Send]:
    """Execute multiple tools in parallel."""
    tool_calls = state["messages"][-1].tool_calls
    return [
        Send("tools_node", {"tool_call_id": tc["id"]})
        for tc in tool_calls
    ]

graph.add_conditional_edges("llm_node", route_to_parallel_tools)
```

**What this means:**
- LangGraph will spawn multiple instances of `tools_node` running in parallel
- Results are collected and merged back into state
- Without this, you'd need to implement `asyncio.gather()` and state merging

### 4. Checkpointing (Persistence)

```python
from langgraph.checkpoint.postgres import PostgresSaver

checkpointer = PostgresSaver(connection_string)

compiled_graph = graph.compile(checkpointer=checkpointer)

# First run - saves state
result = await compiled_graph.ainvoke(
    {"messages": [HumanMessage("Hello")]},
    config={"configurable": {"thread_id": "conversation-123"}}
)

# Later - resumes from saved state
result = await compiled_graph.ainvoke(
    {"messages": [HumanMessage("Follow up")]},
    config={"configurable": {"thread_id": "conversation-123"}}
)
```

**What this means:**
- State is automatically saved after each node
- Can resume conversations from any point
- Supports interrupts (pause for user input)
- Without this, you'd need to implement your own persistence layer

### 5. Streaming Events

```python
async for event in compiled_graph.astream(
    state,
    config,
    stream_mode=["values", "custom", "messages"]
):
    # "values" = state updates after each node
    # "custom" = custom events from nodes (via StreamWriter)
    # "messages" = LLM token-by-token streaming
    print(event)
```

**What this means:**
- Real-time updates as the graph executes
- Multiple stream modes for different use cases
- Without this, you'd need to implement your own event system

### 6. Tool Binding

```python
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool

@tool
def get_weather(city: str) -> str:
    """Get weather for a city."""
    return f"Weather in {city}: Sunny"

llm = ChatOpenAI()
llm_with_tools = llm.bind_tools([get_weather])

# LLM can now generate tool calls
response = await llm_with_tools.ainvoke([HumanMessage("What's the weather in NYC?")])
# response.tool_calls = [{"name": "get_weather", "args": {"city": "NYC"}, "id": "..."}]
```

**What this means:**
- LangChain handles converting your Python functions to JSON schemas
- Handles parsing LLM responses into structured tool calls
- Without this, you'd need to manually create schemas and parse responses

---

## What HogAI Adds on Top

HogAI extends LangGraph with PostHog-specific features:

### 1. Node Path Tracking

**Problem:** In nested graphs (subgraphs calling subgraphs), you lose track of "where am I?"

**HogAI Solution:**
```python
# Automatic path tracking through nested execution
node_path = (
    NodePath(name="MainGraph"),
    NodePath(name="InsightsSubgraph"),
    NodePath(name="TrendsGeneratorNode"),
)

# Every node knows its full path
print(self.node_path)  # → Full traversal path
```

**Why this matters:**
- Debugging: Know exactly where an error occurred
- Streaming: Attribute events to correct node
- Billing: Track which nodes triggered LLM calls

### 2. Dispatcher for Real-Time UI Updates

**Problem:** LangGraph's streaming is low-level. UI needs structured events.

**HogAI Solution:**
```python
class MyNode(BaseAssistantNode):
    async def arun(self, state, config):
        # Emit UI update
        self.dispatcher.update("Analyzing your data...")

        # Do work
        result = await self.analyze(state)

        # Emit message for UI
        self.dispatcher.message(AssistantMessage(content="Done!"))

        return {"result": result}
```

**Why this matters:**
- UI shows "Analyzing your data..." while node runs
- Clean separation between node logic and event emission
- Non-blocking: errors in dispatcher don't crash node

### 3. Conversation Cancellation

**Problem:** User clicks "Stop" - how do you halt execution?

**HogAI Solution:**
```python
class BaseAssistantNode:
    async def __call__(self, state, config):
        # Check before execution
        if await self._is_conversation_cancelled(thread_id):
            raise GenerationCanceled

        # Execute node
        result = await self._execute(state, config)

        return result
```

**Why this matters:**
- Graceful cancellation without corrupting state
- Database-backed status check (works across distributed workers)

### 4. Mode System

**Problem:** Different user intents need different tools and prompts.

**HogAI Solution:**
```python
# Product Analytics mode
class ProductAnalyticsToolkit:
    tools = [CreateInsightTool, CreateDashboardTool]

# SQL mode
class SQLToolkit:
    tools = [ExecuteSQLTool]

# Dynamically switch based on user intent
if user_wants_sql:
    toolkit = SQLToolkit()
```

**Why this matters:**
- Clean separation of concerns
- LLM only sees relevant tools
- Different system prompts per mode

### 5. Django Integration

**Problem:** Need to persist state, load user data, check permissions.

**HogAI Solution:**
```python
class BaseAssistantNode:
    def __init__(self, team: Team, user: User):
        self._team = team  # Django model
        self._user = user  # Django model

    async def arun(self, state, config):
        # Access Django models safely in async context
        memory = await self._aget_core_memory()
        return {"memory": memory}
```

**Why this matters:**
- Async-safe Django ORM access
- Team/user context available in every node
- DjangoCheckpointer for state persistence

---

## Building Without LangGraph

If you wanted to build HogAI **without LangGraph**, here's what you'd need to implement:

### 1. Graph Execution Engine

```python
# WITHOUT LANGGRAPH - You'd need to build this:

class GraphEngine:
    def __init__(self):
        self.nodes: dict[str, Callable] = {}
        self.edges: dict[str, list[str]] = {}
        self.conditional_edges: dict[str, tuple[Callable, dict]] = {}

    def add_node(self, name: str, func: Callable):
        self.nodes[name] = func

    def add_edge(self, from_node: str, to_node: str):
        self.edges.setdefault(from_node, []).append(to_node)

    def add_conditional_edges(self, source: str, router: Callable, path_map: dict):
        self.conditional_edges[source] = (router, path_map)

    async def execute(self, initial_state: dict) -> dict:
        state = initial_state
        current_node = "START"

        while current_node != "END":
            # Get next node(s)
            if current_node in self.conditional_edges:
                router, path_map = self.conditional_edges[current_node]
                next_key = router(state)
                current_node = path_map[next_key]
            elif current_node in self.edges:
                current_node = self.edges[current_node][0]
            else:
                break

            if current_node == "END":
                break

            # Execute node
            node_func = self.nodes[current_node]
            state_update = await node_func(state)

            # Merge state (you'd need reducer logic here)
            state = {**state, **state_update}

        return state
```

**Complexity:** ~200 lines for basic version, ~2000+ for production-ready with error handling, parallel execution, interrupts.

### 2. State Persistence (Checkpointing)

```python
# WITHOUT LANGGRAPH - You'd need to build this:

class Checkpointer:
    def __init__(self, db_connection):
        self.db = db_connection

    async def save(self, thread_id: str, state: dict, node_name: str):
        """Save state after each node."""
        await self.db.execute(
            "INSERT INTO checkpoints (thread_id, state, node, timestamp) VALUES (?, ?, ?, ?)",
            (thread_id, json.dumps(state), node_name, datetime.now())
        )

    async def load(self, thread_id: str) -> dict | None:
        """Load latest state for thread."""
        row = await self.db.fetchone(
            "SELECT state FROM checkpoints WHERE thread_id = ? ORDER BY timestamp DESC LIMIT 1",
            (thread_id,)
        )
        return json.loads(row["state"]) if row else None

    async def get_history(self, thread_id: str) -> list[dict]:
        """Get all checkpoints for thread."""
        rows = await self.db.fetchall(
            "SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY timestamp",
            (thread_id,)
        )
        return [json.loads(r["state"]) for r in rows]
```

**Complexity:** ~500 lines for basic, ~3000+ for production with namespaces, blob storage, migrations.

### 3. State Reducers

```python
# WITHOUT LANGGRAPH - You'd need to build this:

class StateManager:
    def __init__(self, state_schema: type, reducers: dict[str, Callable]):
        self.schema = state_schema
        self.reducers = reducers

    def merge(self, existing: dict, update: dict) -> dict:
        """Merge state update into existing state."""
        result = existing.copy()

        for key, value in update.items():
            if value is None:
                continue

            if key in self.reducers:
                # Use custom reducer
                reducer = self.reducers[key]
                result[key] = reducer(existing.get(key), value)
            else:
                # Default: replace
                result[key] = value

        return result

# Usage
def add_messages(existing: list, new: list) -> list:
    # Merge by ID, append new
    existing_ids = {m["id"] for m in existing}
    result = existing.copy()
    for msg in new:
        if msg["id"] in existing_ids:
            # Update existing
            for i, m in enumerate(result):
                if m["id"] == msg["id"]:
                    result[i] = msg
                    break
        else:
            # Append new
            result.append(msg)
    return result

state_manager = StateManager(
    state_schema=AssistantState,
    reducers={"messages": add_messages}
)
```

**Complexity:** ~300 lines for basic, ~1000+ for production with validation, typing, edge cases.

### 4. Streaming Infrastructure

```python
# WITHOUT LANGGRAPH - You'd need to build this:

import asyncio
from typing import AsyncGenerator

class StreamManager:
    def __init__(self):
        self.subscribers: dict[str, list[asyncio.Queue]] = {}

    def create_writer(self, thread_id: str) -> Callable:
        """Create a writer function for a thread."""
        def write(event: dict):
            for queue in self.subscribers.get(thread_id, []):
                queue.put_nowait(event)
        return write

    async def subscribe(self, thread_id: str) -> AsyncGenerator[dict, None]:
        """Subscribe to events for a thread."""
        queue = asyncio.Queue()
        self.subscribers.setdefault(thread_id, []).append(queue)

        try:
            while True:
                event = await queue.get()
                if event is None:  # End signal
                    break
                yield event
        finally:
            self.subscribers[thread_id].remove(queue)

# In your graph engine
class GraphEngineWithStreaming(GraphEngine):
    def __init__(self, stream_manager: StreamManager):
        super().__init__()
        self.stream_manager = stream_manager

    async def execute_with_streaming(
        self,
        initial_state: dict,
        thread_id: str
    ) -> AsyncGenerator[dict, None]:
        writer = self.stream_manager.create_writer(thread_id)

        # ... execute graph, calling writer(event) at each step

        async for event in self.stream_manager.subscribe(thread_id):
            yield event
```

**Complexity:** ~400 lines for basic, ~2000+ for production with backpressure, reconnection, multiple stream modes.

### 5. Parallel Execution

```python
# WITHOUT LANGGRAPH - You'd need to build this:

class ParallelExecutor:
    async def execute_parallel(
        self,
        nodes: list[tuple[str, dict]],  # (node_name, node_state)
        node_funcs: dict[str, Callable],
    ) -> list[dict]:
        """Execute multiple nodes in parallel and collect results."""

        async def run_node(name: str, state: dict) -> dict:
            func = node_funcs[name]
            return await func(state)

        tasks = [
            run_node(name, state)
            for name, state in nodes
        ]

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Handle exceptions
        for i, result in enumerate(results):
            if isinstance(result, Exception):
                raise RuntimeError(f"Node {nodes[i][0]} failed: {result}")

        return results

    def merge_parallel_results(
        self,
        base_state: dict,
        results: list[dict],
        state_manager: StateManager,
    ) -> dict:
        """Merge results from parallel execution."""
        merged = base_state.copy()
        for result in results:
            merged = state_manager.merge(merged, result)
        return merged
```

**Complexity:** ~200 lines for basic, ~1500+ for production with cancellation, timeouts, error recovery.

### 6. Tool Calling Infrastructure

```python
# WITHOUT LANGGRAPH (and LangChain) - You'd need to build this:

import json
from pydantic import BaseModel

class ToolRegistry:
    def __init__(self):
        self.tools: dict[str, tuple[Callable, type[BaseModel]]] = {}

    def register(self, name: str, func: Callable, args_schema: type[BaseModel]):
        self.tools[name] = (func, args_schema)

    def get_schemas_for_llm(self) -> list[dict]:
        """Generate JSON schemas for LLM function calling."""
        schemas = []
        for name, (func, args_schema) in self.tools.items():
            schemas.append({
                "type": "function",
                "function": {
                    "name": name,
                    "description": func.__doc__ or "",
                    "parameters": args_schema.model_json_schema(),
                }
            })
        return schemas

    async def execute(self, tool_call: dict) -> str:
        """Execute a tool call from LLM response."""
        name = tool_call["name"]
        args = tool_call["args"]

        if name not in self.tools:
            raise ValueError(f"Unknown tool: {name}")

        func, args_schema = self.tools[name]

        # Validate args
        validated_args = args_schema(**args)

        # Execute
        result = await func(**validated_args.model_dump())

        return str(result)

class LLMCaller:
    def __init__(self, api_key: str, tool_registry: ToolRegistry):
        self.api_key = api_key
        self.tool_registry = tool_registry

    async def call_with_tools(self, messages: list[dict]) -> dict:
        """Call LLM with tool definitions."""
        import openai

        client = openai.AsyncOpenAI(api_key=self.api_key)

        response = await client.chat.completions.create(
            model="gpt-4",
            messages=messages,
            tools=self.tool_registry.get_schemas_for_llm(),
        )

        return self._parse_response(response)

    def _parse_response(self, response) -> dict:
        """Parse OpenAI response into structured format."""
        message = response.choices[0].message

        return {
            "content": message.content,
            "tool_calls": [
                {
                    "id": tc.id,
                    "name": tc.function.name,
                    "args": json.loads(tc.function.arguments),
                }
                for tc in (message.tool_calls or [])
            ]
        }
```

**Complexity:** ~500 lines for basic, ~3000+ for production with retries, streaming, multiple providers.

### Summary: Build vs Buy

| Component | LangGraph Provides | DIY Complexity |
|-----------|-------------------|----------------|
| Graph execution | ✅ Full implementation | ~2000 lines |
| State reducers | ✅ Annotation-based | ~1000 lines |
| Checkpointing | ✅ Multiple backends | ~3000 lines |
| Streaming | ✅ Multiple modes | ~2000 lines |
| Parallel execution | ✅ Send primitive | ~1500 lines |
| Tool calling | ✅ Via LangChain | ~3000 lines |
| **Total** | **~0 lines** | **~12,500 lines** |

**Verdict:** LangGraph provides ~12,500 lines of production-ready infrastructure. HogAI adds ~3,000 lines of PostHog-specific features on top.

---

## Overview

The HogAI core execution framework consists of four main modules:

- **`context.py`**: Context variable management for tracking node execution paths
- **`executable.py`**: Base executable class with core execution logic
- **`node.py`**: Assistant node implementation with cancellation and dispatching
- **`base.py`**: Graph builder for composing nodes into executable graphs

The framework uses Python's generic types extensively to provide type-safe state management across nodes and graphs.

## Class Hierarchy

### Type Parameters

The framework uses two generic type parameters throughout:

- **`StateType`**: The complete state type for the graph (e.g., `AssistantState`)
- **`PartialStateType`**: A partial state type that nodes can return to update specific fields (e.g., `PartialAssistantState`)

This allows nodes to return only the state updates they care about, rather than the full state.

### Core Classes

```
BaseAgentExecutable[StateType, PartialStateType]
    ├── BaseAssistantNode[StateType, PartialStateType]
    │
BaseAssistantGraph[StateType, PartialStateType]
```

#### 1. BaseAgentExecutable (Generic Base)

**Location**: `/ee/hogai/core/executable.py`

The foundation class that provides core execution logic without any LangGraph-specific features.

```python
class BaseAgentExecutable(
    Generic[StateType, PartialStateType],
    AssistantContextMixin,
    AssistantDispatcherMixin,
    ABC
):
    """Core assistant node with execution logic only."""

    _config: RunnableConfig | None = None
    _context_manager: AssistantContextManager | None = None
    _node_path: tuple[NodePath, ...]

    def __init__(self, team: Team, user: User, node_path: tuple[NodePath, ...]):
        self._team = team
        self._user = user
        self._node_path = node_path
```

**Key Responsibilities**:
- Manages team and user context
- Provides lazy-initialized `AssistantContextManager`
- Handles async/sync execution paths
- Wraps execution with node path context

**Mixins**:
- `AssistantContextMixin`: Provides access to team data, timezone, currency, core memory
- `AssistantDispatcherMixin`: Provides dispatcher property for emitting actions to LangGraph streams

#### 2. BaseAssistantNode (Extends BaseAgentExecutable)

**Location**: `/ee/hogai/core/node.py`

Adds LangGraph-specific features like dispatching and conversation cancellation.

```python
class BaseAssistantNode(BaseAgentExecutable[StateType, PartialStateType]):
    """Assistant node with dispatching and conversation cancellation support."""

    _is_context_path_used: bool = False
    """Whether the constructor set the node path or the node path from the context is used"""

    def __init__(self, team: Team, user: User, node_path: tuple[NodePath, ...] | None = None):
        if node_path is None:
            node_path = get_node_path() or ()
            self._is_context_path_used = True
        super().__init__(team, user, node_path)
```

**Key Features**:
- Automatic node path detection from context (if not explicitly provided)
- Dispatches `NodeStartAction` and `NodeEndAction` events
- Checks for conversation cancellation before execution
- Resets dispatcher and context manager on each run

#### 3. BaseAssistantGraph (Graph Builder)

**Location**: `/ee/hogai/core/base.py`

Provides a fluent API for building LangGraph state graphs with automatic node path tracking.

```python
class BaseAssistantGraph(Generic[StateType, PartialStateType], ABC):
    _team: Team
    _user: User
    _graph: StateGraph
    _node_path: tuple[NodePath, ...]

    def __init__(self, team: Team, user: User):
        self._team = team
        self._user = user
        self._has_start_node = False
        self._graph = StateGraph(self.state_type)
        self._node_path = (*(get_node_path() or ()), NodePath(name=self.graph_name.value))
```

**Abstract Properties** (must be implemented):
```python
@property
@abstractmethod
def state_type(self) -> type[StateType]:
    """The state class for this graph"""
    ...

@property
@abstractmethod
def graph_name(self) -> AssistantGraphName:
    """The name identifier for this graph"""
    ...
```

## Execution Pipeline

### BaseAgentExecutable Execution Flow

The execution pipeline handles both async and sync execution paths with proper context management.

```python
async def __call__(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
    """
    Run the assistant node.
    """
    # Reset the context manager on a new run
    self._context_manager = None
    self._dispatcher = None
    self._config = config

    return await self._execute(state, config)
```

#### Step 1: `__call__` Method

Entry point when LangGraph invokes the node:

1. Resets `_context_manager` to `None`
2. Resets `_dispatcher` to `None`
3. Stores the `RunnableConfig` in `_config`
4. Calls `_execute(state, config)`

#### Step 2: `_execute` Method

Determines whether to use async or sync execution:

```python
async def _execute(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
    try:
        return await self._arun_with_context(state, config)
    except NotImplementedError:
        pass
    return await database_sync_to_async(self._run_with_context, thread_sensitive=False)(state, config)
```

**Logic**:
1. Try async execution via `_arun_with_context`
2. If `NotImplementedError` is raised (no `arun` implementation), fall back to sync
3. Run sync version via Django's `database_sync_to_async` wrapper

#### Step 3: `_arun_with_context` / `_run_with_context`

These methods wrap the actual execution with node path context:

```python
async def _arun_with_context(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
    with set_node_path(self.node_path):
        return await self.arun(state, config)

def _run_with_context(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
    with set_node_path(self.node_path):
        return self.run(state, config)
```

The `set_node_path` context manager ensures that any child nodes or graphs created during execution inherit the correct path.

#### Step 4: `arun` / `run` Implementation

Subclasses implement these methods to provide the actual node logic:

```python
async def arun(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
    # Your node logic here
    ...
```

### BaseAssistantNode Enhanced Flow

`BaseAssistantNode` extends the execution flow with dispatching and cancellation:

```python
async def __call__(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
    """
    Run the assistant node and handle cancelled conversation before the node is run.
    """
    # Reset the dispatcher on a new run
    self._context_manager = None
    self._dispatcher = None
    self._config = config

    self.dispatcher.dispatch(NodeStartAction())

    thread_id = (config.get("configurable") or {}).get("thread_id")
    if thread_id and await self._is_conversation_cancelled(thread_id):
        raise GenerationCanceled

    new_state = await self._execute(state, config)

    self.dispatcher.dispatch(NodeEndAction(state=new_state))

    return new_state
```

**Enhanced Steps**:
1. Reset state (same as parent)
2. **Dispatch `NodeStartAction`** to notify listeners that node execution started
3. **Check for cancellation**: Query database to see if conversation was cancelled
4. Execute node logic via `_execute` (inherited from parent)
5. **Dispatch `NodeEndAction`** with the resulting state
6. Return the new state

### Exception Handling

The framework raises `GenerationCanceled` if a conversation is cancelled:

```python
async def _is_conversation_cancelled(self, conversation_id: UUID) -> bool:
    conversation = await self._aget_conversation(conversation_id)
    if not conversation:
        raise ValueError(f"Conversation {conversation_id} not found")
    return conversation.status == Conversation.Status.CANCELING
```

This exception propagates up through LangGraph, allowing graceful termination.

## Node Path Context

The node path context system uses Python's `contextvars` to track the execution path through nested nodes and graphs.

### Data Structure

**Location**: `/ee/hogai/utils/types/base.py`

```python
class NodePath(BaseModel):
    """Defines a vertice of the assistant graph path."""

    name: str
```

The full path is a tuple of `NodePath` objects representing the traversal through the graph hierarchy.

Example path: `(NodePath(name="MainGraph"), NodePath(name="SubGraph"), NodePath(name="GeneratorNode"))`

### Context Variable Implementation

**Location**: `/ee/hogai/core/context.py`

```python
import contextvars
from contextlib import contextmanager

from ee.hogai.utils.types.base import NodePath

node_path_context = contextvars.ContextVar[tuple[NodePath, ...]]("node_path_context")


@contextmanager
def set_node_path(node_path: tuple[NodePath, ...]):
    token = node_path_context.set(node_path)
    try:
        yield
    finally:
        node_path_context.reset(token)


def get_node_path() -> tuple[NodePath, ...] | None:
    try:
        return node_path_context.get()
    except LookupError:
        return None
```

### How It Works

**`contextvars.ContextVar`**:
- Thread-safe and async-safe context variable
- Each async task or thread gets its own isolated context
- Automatically propagates to child tasks created with `asyncio.create_task()`

**`set_node_path` Context Manager**:
1. Sets the context variable to the provided path
2. Stores a token for later restoration
3. Yields control to the wrapped code
4. Restores the previous value (or unsets if none) on exit

**`get_node_path` Helper**:
- Retrieves the current node path from context
- Returns `None` if no path is set (outside of execution)

### Usage Pattern

The node path is automatically managed during execution:

```python
# In BaseAgentExecutable._arun_with_context:
with set_node_path(self.node_path):
    return await self.arun(state, config)
```

Child nodes can access the parent path:

```python
# In BaseAssistantNode.__init__:
if node_path is None:
    node_path = get_node_path() or ()  # Get parent path from context
    self._is_context_path_used = True
```

### Node Path Construction

Each class constructs its path differently:

**BaseAgentExecutable** (manual path):
```python
@property
def node_path(self) -> tuple[NodePath, ...]:
    return (*self._node_path, NodePath(name=self.node_name))
```

**BaseAssistantNode** (context-aware):
```python
@property
def node_path(self) -> tuple[NodePath, ...]:
    # If the path is manually set, use it.
    if not self._is_context_path_used:
        return self._node_path
    # Otherwise, construct the path from the context.
    return (*self._node_path, NodePath(name=self.node_name))
```

**BaseAssistantGraph** (graph level):
```python
def __init__(self, team: Team, user: User):
    # ...
    self._node_path = (*(get_node_path() or ()), NodePath(name=self.graph_name.value))
```

### Automatic Method Wrapping

`BaseAssistantGraph` uses metaclass magic to automatically wrap all public methods with node path context:

```python
def __init_subclass__(cls, **kwargs):
    super().__init_subclass__(**kwargs)
    # Wrap all public methods with the node path context
    for name, method in cls.__dict__.items():
        if callable(method) and not name.startswith("_") and name not in ("graph_name", "state_type", "node_path"):
            setattr(cls, name, with_node_path(method))
```

The `with_node_path` decorator:

```python
def with_node_path(func: Callable[..., T]) -> Callable[..., T]:
    @wraps(func)
    def wrapper(self, *args: Any, **kwargs: Any) -> T:
        with set_node_path(self.node_path):
            return func(self, *args, **kwargs)
    return wrapper
```

This ensures that any graph method that creates nodes will automatically pass the correct parent path.

## Dispatcher Integration

The dispatcher system provides a way for nodes to emit events to LangGraph's custom streams, enabling real-time UI updates.

### Action Types

**Location**: `/ee/hogai/utils/types/base.py`

```python
class NodeStartAction(BaseModel):
    type: Literal["NODE_START"] = "NODE_START"


class NodeEndAction(BaseModel, Generic[PartialStateType]):
    type: Literal["NODE_END"] = "NODE_END"
    state: PartialStateType | None = None


class MessageAction(BaseModel):
    type: Literal["MESSAGE"] = "MESSAGE"
    message: AssistantMessageUnion


class UpdateAction(BaseModel):
    type: Literal["UPDATE"] = "UPDATE"
    content: str


AssistantActionUnion = MessageAction | MessageChunkAction | NodeStartAction | NodeEndAction | UpdateAction
```

### AssistantDispatcher

**Location**: `/ee/hogai/utils/dispatcher.py`

The dispatcher wraps LangGraph's `StreamWriter` and emits structured events:

```python
class AssistantDispatcher:
    """
    Lightweight dispatcher that emits actions to LangGraph custom stream.

    Clean separation: Dispatcher dispatches, BaseAssistant reduces.

    The dispatcher does NOT update state - it just emits actions to the stream.
    """

    _node_path: tuple[NodePath, ...]

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
            node_name: The name of the node dispatching actions (for attribution)
        """
        self._writer = writer
        self._node_path = node_path
        self._node_name = node_name
        self._node_run_id = node_run_id

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

    def message(self, message: AssistantMessageUnion) -> None:
        """
        Dispatch a message to the stream.
        """
        self.dispatch(MessageAction(message=message))

    def update(self, content: str):
        """Dispatch a transient update message to the stream that will be associated with a tool call in the UI."""
        self.dispatch(UpdateAction(content=content))
```

**Key Design**:
- Resilient: Catches exceptions to prevent node failures
- Stateless: Only emits events, doesn't modify state
- Attributed: Includes node path, name, and run ID for tracking

### Creating Dispatcher from Config

```python
def create_dispatcher_from_config(config: RunnableConfig, node_path: tuple[NodePath, ...]) -> AssistantDispatcher:
    """Create a dispatcher from a RunnableConfig and node path"""
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
    # `langgraph_checkpoint_ns` contains the nested path to the node, so it's more accurate for streaming.
    node_run_id: str = metadata.get("langgraph_checkpoint_ns") or ""

    return AssistantDispatcher(writer, node_path, node_name, node_run_id)
```

**Graceful Degradation**:
- In non-streaming contexts (like tests), uses a no-op writer
- Extracts metadata from LangGraph's config for attribution

### Dispatcher Mixin

**Location**: `/ee/hogai/core/mixins.py`

Nodes access the dispatcher via `AssistantDispatcherMixin`:

```python
class AssistantDispatcherMixin(ABC):
    _config: RunnableConfig | None
    _dispatcher: AssistantDispatcher | None = None

    @property
    @abstractmethod
    def node_path(self) -> tuple[NodePath, ...]: ...

    @property
    @abstractmethod
    def node_name(self) -> str: ...

    @property
    def tool_call_id(self) -> str:
        parent_tool_call_id = next((path.tool_call_id for path in reversed(self.node_path) if path.tool_call_id), None)
        if not parent_tool_call_id:
            raise ValueError("No tool call ID found")
        return parent_tool_call_id

    @property
    def dispatcher(self) -> AssistantDispatcher:
        """Create a dispatcher for this node"""
        if self._dispatcher:
            return self._dispatcher
        self._dispatcher = create_dispatcher_from_config(self._config or {}, self.node_path)
        return self._dispatcher
```

**Lazy Initialization**:
- Dispatcher is created on first access
- Cached for subsequent calls within the same execution

### Cancellation Check Flow

`BaseAssistantNode` uses the dispatcher in its execution flow:

```python
async def __call__(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
    # Reset the dispatcher on a new run
    self._context_manager = None
    self._dispatcher = None
    self._config = config

    self.dispatcher.dispatch(NodeStartAction())  # 1. Emit start event

    thread_id = (config.get("configurable") or {}).get("thread_id")
    if thread_id and await self._is_conversation_cancelled(thread_id):  # 2. Check cancellation
        raise GenerationCanceled

    new_state = await self._execute(state, config)  # 3. Execute node logic

    self.dispatcher.dispatch(NodeEndAction(state=new_state))  # 4. Emit end event

    return new_state
```

**Flow**:
1. Reset dispatcher to ensure fresh instance
2. Dispatch `NodeStartAction` (UI can show "Processing...")
3. Check if conversation was cancelled by user
4. Execute node logic
5. Dispatch `NodeEndAction` with result (UI can update state)

## Graph Building API

The `BaseAssistantGraph` class provides a fluent API for constructing LangGraph state graphs.

### Core Methods

#### `add_node(node, action)`

Adds a node to the graph:

```python
def add_node(
    self,
    node: "MaxNodeName",
    action: BaseAssistantNode[StateType, PartialStateType] | CompiledStateGraph,
):
    self._graph.add_node(node, action)
    return self
```

**Parameters**:
- `node`: The node name (typically an enum value)
- `action`: Either a `BaseAssistantNode` instance or a compiled subgraph

**Returns**: `self` for method chaining

#### `add_edge(from_node, to_node)`

Adds a directed edge between two nodes:

```python
def add_edge(self, from_node: "MaxNodeName", to_node: "MaxNodeName"):
    if from_node == AssistantNodeName.START:
        self._has_start_node = True
    self._graph.add_edge(from_node, to_node)
    return self
```

**Special Handling**:
- Tracks if `START` node has been connected (required for compilation)

**Returns**: `self` for method chaining

#### `add_conditional_edges(source, path_function, [path_map])`

Adds conditional edges based on a routing function:

```python
# From LangGraph's StateGraph (called via self._graph)
self._graph.add_conditional_edges(
    AssistantNodeName.TRENDS_GENERATOR,
    trends_generator.router,
    {
        "continue": AssistantNodeName.TRENDS_GENERATOR_TOOLS,
        "end": END,
    }
)
```

**Parameters**:
- `source`: The node to route from
- `path_function`: A function that takes state and returns a string key
- `path_map` (optional): Dict mapping return values to destination nodes

**Routing Function Example**:
```python
def router(self, state: StateType) -> str:
    if state.needs_tools:
        return "continue"
    return "end"
```

#### `compile(checkpointer)`

Compiles the graph into an executable form:

```python
def compile(self, checkpointer: DjangoCheckpointer | None | Literal[False] = None):
    if not self._has_start_node:
        raise ValueError("Start node not added to the graph")
    # TRICKY: We check `is not None` because False has a special meaning of "no checkpointer", which we want to pass on
    compiled_graph = self._graph.compile(
        checkpointer=checkpointer if checkpointer is not None else global_checkpointer
    )
    return compiled_graph
```

**Parameters**:
- `checkpointer`:
  - `None` (default): Use `global_checkpointer` (Django-based persistence)
  - `DjangoCheckpointer` instance: Use custom checkpointer
  - `False`: Disable checkpointing (stateless execution)

**Validation**:
- Raises `ValueError` if no edge from `START` node was added

**Global Checkpointer**:
```python
# Base checkpointer for all graphs
global_checkpointer = DjangoCheckpointer()
```

### Complete Graph Example

```python
from ee.hogai.core.base import BaseAssistantGraph
from ee.hogai.utils.types.base import AssistantState, PartialAssistantState, AssistantGraphName

class MyAssistantGraph(BaseAssistantGraph[AssistantState, PartialAssistantState]):
    @property
    def state_type(self) -> type[AssistantState]:
        return AssistantState

    @property
    def graph_name(self) -> AssistantGraphName:
        return AssistantGraphName.MY_GRAPH

    def build_graph(self):
        # Create nodes
        router_node = RouterNode(self._team, self._user)
        generator_node = GeneratorNode(self._team, self._user)
        tools_node = ToolsNode(self._team, self._user)

        # Build graph
        self.add_node(AssistantNodeName.ROUTER, router_node)
        self.add_node(AssistantNodeName.GENERATOR, generator_node)
        self.add_node(AssistantNodeName.TOOLS, tools_node)

        # Add edges
        self.add_edge(AssistantNodeName.START, AssistantNodeName.ROUTER)
        self.add_conditional_edges(
            AssistantNodeName.ROUTER,
            router_node.route,
            {
                "generate": AssistantNodeName.GENERATOR,
                "end": END,
            }
        )
        self.add_edge(AssistantNodeName.GENERATOR, AssistantNodeName.TOOLS)
        self.add_conditional_edges(
            AssistantNodeName.TOOLS,
            tools_node.should_continue,
            {
                "continue": AssistantNodeName.GENERATOR,
                "end": END,
            }
        )

        return self.compile()
```

---

## Registered Nodes vs LLM Tools

**Important distinction:** Nodes and Tools are different concepts.

| Concept | What it is | Registered where | Examples |
|---------|------------|------------------|----------|
| **Nodes** | Graph execution steps | `_graph._nodes` via `add_node()` | `ROOT`, `ROOT_TOOLS`, `MEMORY_COLLECTOR` |
| **Tools** | Functions the LLM can call | `toolkit_manager.get_tools()` | `CreateInsightTool`, `SearchTool`, `SwitchModeTool` |

**Nodes** = Steps in the state machine (graph topology)
**Tools** = Things bound to the LLM via `model.bind_tools(tools)`

### Nodes Registered by compile_full_graph()

The `AssistantGraph.compile_full_graph()` method registers these nodes:

```python
# Location: ee/hogai/chat_agent/graph.py

def compile_full_graph(self):
    return (
        self
        .add_title_generator()        # → TITLE_GENERATOR
        .add_slash_command_handler()  # → SLASH_COMMAND_HANDLER
        .add_memory_onboarding()      # → MEMORY_ONBOARDING
                                      #   MEMORY_INITIALIZER
                                      #   MEMORY_INITIALIZER_INTERRUPT
                                      #   MEMORY_ONBOARDING_ENQUIRY
                                      #   MEMORY_ONBOARDING_ENQUIRY_INTERRUPT
                                      #   MEMORY_ONBOARDING_FINALIZE
        .add_memory_collector()       # → MEMORY_COLLECTOR
        .add_memory_collector_tools() # → MEMORY_COLLECTOR_TOOLS
        .add_root()                   # → ROOT
                                      #   ROOT_TOOLS
        .compile()
    )
```

**Complete node registry after compilation:**

```python
_graph._nodes = {
    # Title generation
    "title_generator": TitleGeneratorNode(...),

    # Slash command handling
    "slash_command_handler": SlashCommandHandlerNode(...),

    # Memory onboarding flow
    "memory_onboarding": MemoryOnboardingNode(...),
    "memory_initializer": MemoryInitializerNode(...),
    "memory_initializer_interrupt": MemoryInitializerInterruptNode(...),
    "memory_onboarding_enquiry": MemoryOnboardingEnquiryNode(...),
    "memory_onboarding_enquiry_interrupt": MemoryOnboardingEnquiryInterruptNode(...),
    "memory_onboarding_finalize": MemoryOnboardingFinalizeNode(...),

    # Memory collection
    "memory_collector": MemoryCollectorNode(...),
    "memory_collector_tools": MemoryCollectorToolsNode(...),

    # Main agent loop (where LLM runs)
    "root": AgentLoopGraphNode(...),
    "root_tools": AgentLoopGraphToolsNode(...),
}
```

### LLM Tools (Different from Nodes)

Tools are retrieved dynamically inside the `ROOT` node execution:

```python
# Inside AgentExecutable.arun() (the ROOT node's logic)
tools = await toolkit_manager.get_tools(state, config)
# Returns: [CreateInsightTool, SearchTool, SwitchModeTool, ExecuteSQLTool, ...]

model = ChatOpenAI(...).bind_tools(tools)  # Bind to LLM
message = await model.ainvoke(prompts + messages)  # LLM can now call these tools
```

**Key difference:**
- **Nodes** are registered once at graph construction time
- **Tools** are fetched dynamically at execution time (can vary by mode)

---

## Complete Implementation Guide

This section provides step-by-step instructions to reimplement the framework from scratch.

### Step 1: Set Up Context Management

First, implement the context variable system for tracking node paths:

```python
# context.py
import contextvars
from contextlib import contextmanager
from pydantic import BaseModel

class NodePath(BaseModel):
    """Defines a vertice of the assistant graph path."""
    name: str

node_path_context = contextvars.ContextVar[tuple[NodePath, ...]]("node_path_context")


@contextmanager
def set_node_path(node_path: tuple[NodePath, ...]):
    """Context manager to set the current node path."""
    token = node_path_context.set(node_path)
    try:
        yield
    finally:
        node_path_context.reset(token)


def get_node_path() -> tuple[NodePath, ...] | None:
    """Get the current node path from context."""
    try:
        return node_path_context.get()
    except LookupError:
        return None
```

### Step 2: Create Action Types

Define the action types that will be dispatched:

```python
# types.py
from typing import Literal, Generic, TypeVar
from pydantic import BaseModel

PartialStateType = TypeVar("PartialStateType")

class NodeStartAction(BaseModel):
    type: Literal["NODE_START"] = "NODE_START"


class NodeEndAction(BaseModel, Generic[PartialStateType]):
    type: Literal["NODE_END"] = "NODE_END"
    state: PartialStateType | None = None


class MessageAction(BaseModel):
    type: Literal["MESSAGE"] = "MESSAGE"
    message: dict  # Your message type here


class UpdateAction(BaseModel):
    type: Literal["UPDATE"] = "UPDATE"
    content: str


AssistantActionUnion = MessageAction | NodeStartAction | NodeEndAction | UpdateAction
```

### Step 3: Implement Dispatcher

Create the dispatcher for emitting events:

```python
# dispatcher.py
from typing import Callable, Any
from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer
from langgraph.types import StreamWriter
import logging

logger = logging.getLogger(__name__)


class AssistantDispatcher:
    """Lightweight dispatcher that emits actions to LangGraph custom stream."""

    def __init__(
        self,
        writer: StreamWriter | Callable[[Any], None],
        node_path: tuple[NodePath, ...],
        node_name: str,
        node_run_id: str,
    ):
        self._writer = writer
        self._node_path = node_path
        self._node_name = node_name
        self._node_run_id = node_run_id

    def dispatch(self, action: AssistantActionUnion) -> None:
        """Emit action to custom stream. Does NOT update state."""
        try:
            self._writer({
                "action": action,
                "node_path": self._node_path,
                "node_name": self._node_name,
                "node_run_id": self._node_run_id,
            })
        except Exception as e:
            logger.error(f"Failed to dispatch action: {e}", exc_info=True)

    def message(self, message: dict) -> None:
        """Dispatch a message to the stream."""
        self.dispatch(MessageAction(message=message))

    def update(self, content: str):
        """Dispatch a transient update message to the stream."""
        self.dispatch(UpdateAction(content=content))


def create_dispatcher_from_config(
    config: RunnableConfig,
    node_path: tuple[NodePath, ...]
) -> AssistantDispatcher:
    """Create a dispatcher from a RunnableConfig and node path"""
    try:
        writer = get_stream_writer()
    except RuntimeError:
        # Not in streaming context (e.g., testing)
        def noop(*_args, **_kwargs):
            pass
        writer = noop

    metadata = config.get("metadata") or {}
    node_name: str = metadata.get("langgraph_node") or ""
    node_run_id: str = metadata.get("langgraph_checkpoint_ns") or ""

    return AssistantDispatcher(writer, node_path, node_name, node_run_id)
```

### Step 4: Create Mixins

Define the mixins that provide common functionality:

```python
# mixins.py
from abc import ABC, abstractmethod
from langchain_core.runnables import RunnableConfig

class AssistantDispatcherMixin(ABC):
    """Mixin that provides dispatcher property."""

    _config: RunnableConfig | None
    _dispatcher: AssistantDispatcher | None = None

    @property
    @abstractmethod
    def node_path(self) -> tuple[NodePath, ...]: ...

    @property
    @abstractmethod
    def node_name(self) -> str: ...

    @property
    def dispatcher(self) -> AssistantDispatcher:
        """Create a dispatcher for this node"""
        if self._dispatcher:
            return self._dispatcher
        self._dispatcher = create_dispatcher_from_config(
            self._config or {},
            self.node_path
        )
        return self._dispatcher


class AssistantContextMixin(ABC):
    """Mixin that provides context access methods."""

    _team: Any  # Your team model
    _user: Any  # Your user model

    # Add your context methods here
    # e.g., get_conversation, get_core_memory, etc.
```

### Step 5: Implement BaseAgentExecutable

Create the base executable class:

```python
# executable.py
from typing import Generic, TypeVar
from abc import ABC
from langchain_core.runnables import RunnableConfig

StateType = TypeVar("StateType")
PartialStateType = TypeVar("PartialStateType")


class BaseAgentExecutable(
    Generic[StateType, PartialStateType],
    AssistantContextMixin,
    AssistantDispatcherMixin,
    ABC
):
    """Core assistant node with execution logic only."""

    _config: RunnableConfig | None = None
    _context_manager: Any | None = None
    _node_path: tuple[NodePath, ...]

    def __init__(self, team: Any, user: Any, node_path: tuple[NodePath, ...]):
        self._team = team
        self._user = user
        self._node_path = node_path

    async def __call__(
        self,
        state: StateType,
        config: RunnableConfig
    ) -> PartialStateType | None:
        """Run the assistant node."""
        # Reset the context manager on a new run
        self._context_manager = None
        self._dispatcher = None
        self._config = config

        return await self._execute(state, config)

    def run(self, state: StateType, config: RunnableConfig) -> PartialStateType | None:
        """DEPRECATED. Use `arun` instead."""
        raise NotImplementedError

    async def arun(
        self,
        state: StateType,
        config: RunnableConfig
    ) -> PartialStateType | None:
        """Implement this method in subclasses."""
        raise NotImplementedError

    @property
    def node_name(self) -> str:
        """Get node name from config metadata or class name."""
        config_name: str | None = None
        if self._config and (metadata := self._config.get("metadata")):
            config_name = metadata.get("langgraph_node")
            if config_name is not None:
                config_name = str(config_name)
        return config_name or self.__class__.__name__

    @property
    def node_path(self) -> tuple[NodePath, ...]:
        """Construct full node path."""
        return (*self._node_path, NodePath(name=self.node_name))

    async def _execute(
        self,
        state: StateType,
        config: RunnableConfig
    ) -> PartialStateType | None:
        """Execute with fallback from async to sync."""
        try:
            return await self._arun_with_context(state, config)
        except NotImplementedError:
            pass
        # Fallback to sync (adapt for your framework)
        return await self._run_sync_in_thread(state, config)

    def _run_with_context(
        self,
        state: StateType,
        config: RunnableConfig
    ) -> PartialStateType | None:
        """Run sync version with context."""
        with set_node_path(self.node_path):
            return self.run(state, config)

    async def _arun_with_context(
        self,
        state: StateType,
        config: RunnableConfig
    ) -> PartialStateType | None:
        """Run async version with context."""
        with set_node_path(self.node_path):
            return await self.arun(state, config)

    async def _run_sync_in_thread(
        self,
        state: StateType,
        config: RunnableConfig
    ) -> PartialStateType | None:
        """Run sync version in thread pool (implement for your framework)."""
        import asyncio
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            self._run_with_context,
            state,
            config
        )
```

### Step 6: Implement BaseAssistantNode

Add LangGraph-specific features:

```python
# node.py
from langchain_core.runnables import RunnableConfig
from uuid import UUID


class GenerationCanceled(Exception):
    """Raised when conversation is cancelled."""
    pass


class BaseAssistantNode(BaseAgentExecutable[StateType, PartialStateType]):
    """Assistant node with dispatching and conversation cancellation support."""

    _is_context_path_used: bool = False

    def __init__(
        self,
        team: Any,
        user: Any,
        node_path: tuple[NodePath, ...] | None = None
    ):
        if node_path is None:
            node_path = get_node_path() or ()
            self._is_context_path_used = True
        super().__init__(team, user, node_path)

    async def __call__(
        self,
        state: StateType,
        config: RunnableConfig
    ) -> PartialStateType | None:
        """Run the assistant node and handle cancelled conversation."""
        # Reset the dispatcher on a new run
        self._context_manager = None
        self._dispatcher = None
        self._config = config

        self.dispatcher.dispatch(NodeStartAction())

        thread_id = (config.get("configurable") or {}).get("thread_id")
        if thread_id and await self._is_conversation_cancelled(thread_id):
            raise GenerationCanceled

        new_state = await self._execute(state, config)

        self.dispatcher.dispatch(NodeEndAction(state=new_state))

        return new_state

    @property
    def node_path(self) -> tuple[NodePath, ...]:
        """Get node path, preferring context path if used."""
        if not self._is_context_path_used:
            return self._node_path
        return (*self._node_path, NodePath(name=self.node_name))

    async def _is_conversation_cancelled(self, conversation_id: UUID) -> bool:
        """Check if conversation is cancelled (implement for your system)."""
        # Query your database to check conversation status
        # Return True if status is "canceling"
        return False
```

### Step 7: Implement BaseAssistantGraph

Create the graph builder:

```python
# base.py
from typing import Generic, TypeVar, Literal
from abc import ABC, abstractmethod
from functools import wraps
from langgraph.graph.state import CompiledStateGraph, StateGraph

StateType = TypeVar("StateType")
PartialStateType = TypeVar("PartialStateType")


def with_node_path(func):
    """Decorator that wraps function with node path context."""
    @wraps(func)
    def wrapper(self, *args, **kwargs):
        with set_node_path(self.node_path):
            return func(self, *args, **kwargs)
    return wrapper


class BaseAssistantGraph(Generic[StateType, PartialStateType], ABC):
    """Base class for building assistant graphs."""

    _team: Any
    _user: Any
    _graph: StateGraph
    _node_path: tuple[NodePath, ...]

    def __init__(self, team: Any, user: Any):
        self._team = team
        self._user = user
        self._has_start_node = False
        self._graph = StateGraph(self.state_type)
        self._node_path = (
            *(get_node_path() or ()),
            NodePath(name=self.graph_name)
        )

    def __init_subclass__(cls, **kwargs):
        """Automatically wrap all public methods with node path context."""
        super().__init_subclass__(**kwargs)
        for name, method in cls.__dict__.items():
            if (callable(method) and
                not name.startswith("_") and
                name not in ("graph_name", "state_type", "node_path")):
                setattr(cls, name, with_node_path(method))

    @property
    @abstractmethod
    def state_type(self) -> type[StateType]:
        """Return the state class for this graph."""
        ...

    @property
    @abstractmethod
    def graph_name(self) -> str:
        """Return the graph name identifier."""
        ...

    @property
    def node_path(self) -> tuple[NodePath, ...]:
        """Return the node path for this graph."""
        return self._node_path

    def add_edge(self, from_node: str, to_node: str):
        """Add an edge between two nodes."""
        if from_node == "START":
            self._has_start_node = True
        self._graph.add_edge(from_node, to_node)
        return self

    def add_node(
        self,
        node: str,
        action: BaseAssistantNode[StateType, PartialStateType] | CompiledStateGraph,
    ):
        """Add a node to the graph."""
        self._graph.add_node(node, action)
        return self

    def compile(self, checkpointer=None):
        """Compile the graph into an executable form."""
        if not self._has_start_node:
            raise ValueError("Start node not added to the graph")

        compiled_graph = self._graph.compile(checkpointer=checkpointer)
        return compiled_graph
```

### Step 8: Usage Example

Putting it all together:

```python
# Define your state types
from typing import TypedDict

class MyState(TypedDict):
    messages: list[dict]
    count: int

class MyPartialState(TypedDict, total=False):
    messages: list[dict]
    count: int


# Create a node
class CounterNode(BaseAssistantNode[MyState, MyPartialState]):
    async def arun(self, state: MyState, config: RunnableConfig) -> MyPartialState:
        # Emit update
        self.dispatcher.update("Counting...")

        # Do work
        new_count = state["count"] + 1

        # Return partial state
        return {"count": new_count}


# Create a graph
class MyGraph(BaseAssistantGraph[MyState, MyPartialState]):
    @property
    def state_type(self) -> type[MyState]:
        return MyState

    @property
    def graph_name(self) -> str:
        return "MyGraph"

    def build(self):
        counter = CounterNode(self._team, self._user)

        self.add_node("counter", counter)
        self.add_edge("START", "counter")
        self.add_edge("counter", "END")

        return self.compile()


# Use the graph
graph_builder = MyGraph(team=my_team, user=my_user)
compiled_graph = graph_builder.build()

# Execute
result = await compiled_graph.ainvoke(
    {"messages": [], "count": 0},
    config={"configurable": {"thread_id": "123"}}
)
```

### Key Implementation Notes

1. **Context Variables**: Use `contextvars` for async-safe thread-local storage
2. **Generic Types**: Leverage Python's generics for type-safe state management
3. **Lazy Initialization**: Create dispatcher and context manager on first access
4. **Resilient Dispatching**: Catch exceptions in dispatcher to prevent node failures
5. **Metaclass Magic**: Use `__init_subclass__` to automatically wrap methods
6. **Fluent API**: Return `self` from builder methods for chaining
7. **Graceful Degradation**: Use no-op writers when not in streaming context
8. **State Separation**: Nodes return partial state updates, not full state

This framework provides a clean abstraction over LangGraph while adding essential features like node path tracking, event dispatching, and cancellation handling.

