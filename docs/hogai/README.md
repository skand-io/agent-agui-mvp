# HogAI: LangGraph-Based Agent Framework

**A comprehensive guide to PostHog's AI agent system**

## Overview

HogAI is a sophisticated LangGraph-based agent framework that powers PostHog's AI assistant. It provides a modular architecture for building multi-mode AI agents with dynamic tool execution, streaming responses, and intelligent context management.

### Core Capabilities

- **Multi-Mode Agent System**: Dynamic switching between specialized modes (Product Analytics, SQL, Session Replay) with mode-specific tools and capabilities
- **Streaming Architecture**: Real-time SSE streaming of agent responses, tool calls, and UI updates
- **Tool Execution Framework**: Extensible tool system with auto-registration, error handling, and artifact management
- **State Management**: Type-safe state graph with merge-by-ID message handling and custom reducers
- **Context Management**: Intelligent context preservation, conversation compaction, and prompt injection
- **Distributed Execution**: Temporal workflow integration with Redis stream coordination

---

## Multi-Mode Agent System

HogAI uses **modes** (not separate agents) to specialize behavior. The same graph runs, but tools and prompts change based on the current mode.

### Available Modes

| Mode | Purpose | Tools Available |
|------|---------|-----------------|
| **Product Analytics** | Trends, funnels, retention insights | `CreateInsightTool`, `SearchTool` |
| **SQL** | Direct HogQL queries | `ExecuteSQLTool`, `ReadDataTool` |
| **Session Replay** | Find and filter recordings | `FilterSessionRecordingsTool` |

### How Mode Switching Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MODE SWITCHING FLOW                                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User: "Can you write me a SQL query for daily active users?"               │
│                                                                             │
│  ROOT (Product Analytics mode):                                             │
│      │                                                                      │
│      ├─ LLM sees: [CreateInsightTool, SearchTool, SwitchModeTool]           │
│      │                                                                      │
│      ├─ LLM thinks: "This needs SQL mode"                                   │
│      │                                                                      │
│      ├─ LLM returns: tool_call: switch_mode(new_mode="sql")                 │
│      │    ══════════════════════════════════════════════════════════════    │
│      │    ▶ SSE TO FE: {"tool_name": "switch_mode", "args": {"new_mode": "sql"}}
│      │       FE shows: "Switching to SQL mode..."                           │
│      │    ══════════════════════════════════════════════════════════════    │
│      │                                                                      │
│      └─ State updated: agent_mode = "sql"                                   │
│                                                                             │
│  ROOT_TOOLS:                                                                │
│      └─ Executes switch_mode → returns confirmation                         │
│         router → "root" (loop back)                                         │
│                                                                             │
│  ROOT (SQL mode now!):                                                      │
│      │                                                                      │
│      ├─ LLM sees: [ExecuteSQLTool, ReadDataTool, SwitchModeTool]            │
│      │            ↑ Different tools!                                        │
│      │                                                                      │
│      ├─ LLM returns: tool_call: execute_sql(query="SELECT ...")             │
│      │    ══════════════════════════════════════════════════════════════    │
│      │    ▶ SSE TO FE: SQL query result with ui_payload                     │
│      │       FE renders: SQL results table                                  │
│      │    ══════════════════════════════════════════════════════════════    │
│      │                                                                      │
│      └─ Continues in SQL mode...                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### BE: Mode Detection and Tool Loading

```python
# Location: ee/hogai/core/agent_modes/executables.py

class AgentExecutable:
    async def arun(self, state: AssistantState, config):
        # Tools loaded based on current mode
        tools = await self._toolkit_manager.get_tools(state, config)
        #                                             ↑
        #                            state.agent_mode determines which tools

        model = ChatOpenAI(...).bind_tools(tools)
        message = await model.ainvoke(...)

        # Detect if LLM called switch_mode
        new_mode = self._get_updated_agent_mode(message, state.agent_mode)

        return PartialAssistantState(
            agent_mode=new_mode,  # ← Persisted in state for next iteration
            messages=[...],
        )

    def _get_updated_agent_mode(self, message, current_mode):
        """Scan tool_calls for switch_mode invocation."""
        for tool_call in message.tool_calls or []:
            if tool_call["name"] == "switch_mode":
                return tool_call["args"]["new_mode"]
        return current_mode
```

### FE: Handling Mode Changes

```typescript
// FE receives SSE event for switch_mode tool call
interface SwitchModeEvent {
  type: "tool_call";
  tool_name: "switch_mode";
  args: { new_mode: "sql" | "product_analytics" | "session_replay" };
}

// In useMaxAssistant hook:
if (event.tool_name === "switch_mode") {
  setCurrentMode(event.args.new_mode);
  // UI updates to show new mode indicator
  // Subsequent tool results render with mode-specific UI
}
```

### Key Points

1. **Mode stored in state** - `state.agent_mode` persists across loop iterations
2. **SwitchModeTool injected into all modes** - LLM can always switch
3. **Tools change per mode** - `toolkit_manager.get_tools()` returns different tools
4. **FE notified via SSE** - Can update UI immediately when mode changes
5. **Same graph, different behavior** - No separate agent graphs, just different tools/prompts

---

## Prompting Strategy

### How the LLM Knows When to Switch Modes

The LLM receives explicit guidance via two key prompts:

**1. System Prompt (SWITCHING_MODES_PROMPT):**
```
You can switch between specialized modes that provide different tools
and capabilities for specific task types.

# When to switch:
- You need a specific tool that's only available in another mode
- The task clearly belongs to another mode's specialty
  (e.g., SQL queries require sql mode)
- You've determined your current tools are insufficient

# When NOT to switch:
- You already have the necessary tools in your current mode
- You're just exploring or answering questions
- You haven't checked if your current mode can handle the task
```

**2. SwitchModeTool Description (dynamically built):**
```
Use this tool to switch to a specialized mode with different tools.

# Common tools (available in all modes)
- memory_write, memory_read, todo_write, search...

# Specialized modes
- product_analytics – General-purpose mode for product analytics tasks.
  [Mode tools: create_insight, search]
- sql – Specialized mode for SQL queries against ClickHouse.
  [Mode tools: execute_sql, read_data]
- session_replay – Specialized mode for analyzing session recordings.
  [Mode tools: filter_session_recordings, summarize_sessions]

Decision framework:
1. Check if you already have the necessary tools in your current mode
2. If not, identify which mode provides the tools you need
3. Switch to that mode using this tool
```

### How Mode Descriptions are Built

Mode descriptions are dynamically assembled from the `mode_registry`:

```python
# Location: ee/hogai/tools/switch_mode.py

async def _get_modes_prompt(mode_registry) -> str:
    formatted_modes = []
    for definition, tools in zip(mode_registry.values(), resolved_tools):
        formatted_modes.append(
            f"- {definition.mode.value} – {definition.mode_description}. "
            f"[Mode tools: {', '.join([tool.get_name() for tool in tools])}]"
        )
    return "\n".join(formatted_modes)
```

Each `AgentModeDefinition` provides:
- `mode` - The enum value (e.g., `AgentMode.SQL`)
- `mode_description` - Concise description for the LLM
- `toolkit_class` - Class that defines available tools

---

## Adding a New Mode (Developer Guide)

### Step 1: Define the Mode Enum

```python
# Location: posthog/schema.py

class AgentMode(str, Enum):
    PRODUCT_ANALYTICS = "product_analytics"
    SQL = "sql"
    SESSION_REPLAY = "session_replay"
    MY_NEW_MODE = "my_new_mode"  # ← Add here
```

### Step 2: Create the Toolkit

```python
# Location: ee/hogai/core/agent_modes/presets/my_new_mode.py

from ee.hogai.core.agent_modes.toolkit import AgentToolkit
from ee.hogai.tools.my_tool import MyTool

class MyNewModeToolkit(AgentToolkit):
    """Toolkit for my new mode."""

    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [
            MyTool,
            AnotherTool,
        ]

    # Optional: Add examples to guide TodoWriteTool behavior
    POSITIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example="When user asks for X, create todo: 'Analyze X using MyTool'",
            reasoning="This helps break down complex requests",
        ),
    ]
```

### Step 3: Create the Mode Definition

```python
# Location: ee/hogai/core/agent_modes/presets/my_new_mode.py

from ee.hogai.core.agent_modes.factory import AgentModeDefinition
from posthog.schema import AgentMode

my_new_mode_agent = AgentModeDefinition(
    mode=AgentMode.MY_NEW_MODE,
    mode_description="Specialized mode for [describe purpose]. "
                     "This mode allows you to [key capabilities].",
    toolkit_class=MyNewModeToolkit,
    # Optional: custom node classes
    # node_class=MyCustomAgentExecutable,
    # tools_node_class=MyCustomAgentToolsExecutable,
)
```

### Step 4: Register the Mode

```python
# Location: ee/hogai/chat_agent/mode_manager.py

from ee.hogai.core.agent_modes.presets.my_new_mode import my_new_mode_agent

class ChatAgentModeManager(AgentModeManager):
    @property
    def mode_registry(self) -> dict[AgentMode, AgentModeDefinition]:
        return {
            AgentMode.PRODUCT_ANALYTICS: product_analytics_agent,
            AgentMode.SQL: sql_agent,
            AgentMode.SESSION_REPLAY: session_replay_agent,
            AgentMode.MY_NEW_MODE: my_new_mode_agent,  # ← Add here
        }
```

### Step 5: Create Your Tools

```python
# Location: ee/hogai/tools/my_tool.py

from ee.hogai.tool import MaxTool

MY_TOOL_PROMPT = """
Use this tool when the user wants to [describe when to use].

# Arguments
- arg1: Description of argument 1
- arg2: Description of argument 2

# Examples
User: "Do X with Y"
→ my_tool(arg1="X", arg2="Y")
"""

class MyToolArgs(BaseModel):
    arg1: str = Field(description="What arg1 is for")
    arg2: str = Field(description="What arg2 is for")

class MyTool(MaxTool):
    name: str = "my_tool"
    description: str = MY_TOOL_PROMPT
    args_schema: type = MyToolArgs

    async def _arun_impl(self, arg1: str, arg2: str) -> tuple[str, Any]:
        # Do the work
        result = await do_something(arg1, arg2)

        # Return (text_for_llm, artifact_for_fe)
        return f"Completed: {result}", {"my_tool": result}
```

### Checklist for New Modes

- [ ] Add `AgentMode` enum value to `posthog/schema.py`
- [ ] Create toolkit class with `tools` property
- [ ] Create `AgentModeDefinition` with clear `mode_description`
- [ ] Register in `ChatAgentModeManager.mode_registry`
- [ ] Create any new tools needed (with good prompts!)
- [ ] Add positive/negative examples for TodoWriteTool (optional)
- [ ] Test that SwitchModeTool shows your mode in its description

### Writing Good Mode Descriptions

The `mode_description` is what the LLM sees when deciding whether to switch:

**Bad:**
```python
mode_description="Mode for data stuff"
```

**Good:**
```python
mode_description="Specialized mode for SQL queries against ClickHouse. "
                 "This mode allows you to query events, persons, sessions, "
                 "and data warehouse sources. Use when the user needs raw "
                 "data access or complex aggregations."
```

**Key elements:**
1. What the mode specializes in
2. What data/capabilities it provides
3. When to use it (trigger phrases)

---

## Frontend vs Backend Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (TypeScript/React)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  useMaxAssistant() Hook                                              │   │
│  │  - Manages SSE connection to /api/chat endpoint                      │   │
│  │  - Parses AssistantOutput events from stream                         │   │
│  │  - Updates React state with messages, tool calls, artifacts          │   │
│  │  - Handles form interrupts (create_form tool)                        │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              │ Renders                                      │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  UI Components                                                       │   │
│  │  - <AssistantMessage> - renders AI responses                         │   │
│  │  - <ToolCallMessage> - renders tool execution UI                     │   │
│  │  - <VisualizationArtifact> - renders charts, tables from artifacts   │   │
│  │  - <FormInterrupt> - renders forms for user input                    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ SSE Stream (/api/chat)
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BACKEND (Python/Django)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  API Layer (Django Views)                                            │   │
│  │  - POST /api/chat → ChatView.post()                                  │   │
│  │  - Creates BaseAgentRunner instance                                  │   │
│  │  - Returns StreamingHttpResponse with SSE events                     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              │ Calls                                        │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Runner Layer (ee/hogai/core/runner.py)                              │   │
│  │  - BaseAgentRunner.astream() → AsyncGenerator[AssistantOutput]       │   │
│  │  - Manages conversation locking, state, checkpointing                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              │ Executes                                     │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Graph Layer (ee/hogai/core/base.py)                                 │   │
│  │  - LangGraph StateGraph with ROOT ↔ ROOT_TOOLS topology              │   │
│  │  - Nodes: AgentExecutable, AgentToolsExecutable                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              │ Uses                                         │
│                              ↓                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Tool Layer (ee/hogai/tools/)                                        │   │
│  │  - MaxTool subclasses execute business logic                         │   │
│  │  - Return artifacts for FE rendering                                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Detailed Architecture with Function Calls

### Layer-by-Layer Breakdown

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND (FE) - TypeScript/React                                           │
│  Location: frontend/src/scenes/max/                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  useMaxAssistant(conversationId: string) → {                                │
│    messages: AssistantMessage[],                                            │
│    sendMessage: (content: string) => void,                                  │
│    isStreaming: boolean,                                                    │
│    submitFormResponse: (response: FormResponse) => void                     │
│  }                                                                          │
│                                                                             │
│  Key Functions:                                                             │
│  - startStream(message) → EventSource connection to /api/chat               │
│  - parseSSEEvent(event) → AssistantOutput (MESSAGE | STATUS | UPDATE)       │
│  - handleToolArtifact(artifact) → renders UI component                      │
│  - handleFormInterrupt(interrupt) → shows form, collects response           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTP POST + SSE Stream
                                    │ Content-Type: text/event-stream
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  BACKEND (BE) - API LAYER                                                   │
│  Location: ee/hogai/api.py                                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  class ChatView(APIView):                                                   │
│      async def post(request) → StreamingHttpResponse:                       │
│          conversation = get_or_create_conversation(request.data)            │
│          runner = ChatAgentRunner(                                          │
│              team=request.user.team,                                        │
│              user=request.user,                                             │
│              conversation=conversation,                                     │
│              graph=AssistantGraph(...).compile(),                           │
│          )                                                                  │
│          return StreamingHttpResponse(                                      │
│              streaming_content=sse_generator(runner.astream()),             │
│              content_type="text/event-stream"                               │
│          )                                                                  │
│                                                                             │
│  def sse_generator(stream: AsyncGenerator[AssistantOutput]):                │
│      async for event_type, payload in stream:                               │
│          yield f"event: {event_type}\ndata: {json.dumps(payload)}\n\n"      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ runner.astream()
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  BACKEND (BE) - RUNNER LAYER                                                │
│  Location: ee/hogai/core/runner.py                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  class BaseAgentRunner(ABC):                                                │
│      _graph: CompiledStateGraph                                             │
│      _conversation: Conversation                                            │
│      _stream_processor: AssistantStreamProcessorProtocol                    │
│                                                                             │
│      async def astream(                                                     │
│          stream_message_chunks: bool = True,                                │
│          stream_subgraphs: bool = True,                                     │
│      ) → AsyncGenerator[AssistantOutput, None]:                             │
│          """                                                                │
│          Main entry point for agent execution.                              │
│          Yields: tuple[AssistantEventType, payload]                         │
│            - (CONVERSATION, Conversation)                                   │
│            - (MESSAGE, AssistantMessage | ToolCallMessage)                  │
│            - (STATUS, GenerationStatusEvent)                                │
│            - (UPDATE, UpdateEvent)                                          │
│          """                                                                │
│          async with self._lock_conversation():      # IDLE → IN_PROGRESS    │
│              state = await self._init_or_update_state()                     │
│              config = self._get_config()                                    │
│                                                                             │
│              async for update in self._graph.astream(                       │
│                  state,                                                     │
│                  config=config,                                             │
│                  stream_mode=["values", "custom", "messages"],              │
│              ):                                                             │
│                  for output in await self._process_update(update):          │
│                      yield output                                           │
│          # Lock released → IN_PROGRESS → IDLE                               │
│                                                                             │
│      async def _init_or_update_state(self) → AssistantState:                │
│          """Load state from checkpoint or create fresh state."""            │
│          checkpoint = await self._graph.aget_state(config)                  │
│          if checkpoint.values:                                              │
│              return self.get_resumed_state(checkpoint)                      │
│          return self.get_initial_state()                                    │
│                                                                             │
│      async def _process_update(update) → list[AssistantOutput]:             │
│          """Convert LangGraph events to client-facing outputs."""           │
│          if isinstance(update, AssistantDispatcherEvent):                   │
│              return self._stream_processor.process(update)                  │
│          return self._stream_processor.process_langgraph_update(update)     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ self._graph.astream(state, config)
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  BACKEND (BE) - GRAPH LAYER                                                 │
│  Location: ee/hogai/core/base.py, ee/hogai/chat_agent/graph.py              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  class BaseAssistantGraph(ABC, Generic[StateType, PartialStateType]):       │
│      _graph: StateGraph                                                     │
│                                                                             │
│      def add_node(                                                          │
│          self,                                                              │
│          node: AssistantNodeName,      # e.g., ROOT, ROOT_TOOLS             │
│          action: BaseAssistantNode,    # executable instance                │
│      ) → Self:                                                              │
│          """Add node to graph with automatic node path tracking."""         │
│          self._graph.add_node(node, action)                                 │
│          return self                                                        │
│                                                                             │
│      def add_edge(                                                          │
│          self,                                                              │
│          from_node: AssistantNodeName,                                      │
│          to_node: AssistantNodeName,                                        │
│      ) → Self:                                                              │
│          self._graph.add_edge(from_node, to_node)                           │
│          return self                                                        │
│                                                                             │
│      def add_conditional_edges(                                             │
│          self,                                                              │
│          source: AssistantNodeName,                                         │
│          router: Callable[[StateType], str | list[Send]],                   │
│          path_map: dict[str, AssistantNodeName],                            │
│      ) → Self:                                                              │
│          """Add routing logic based on state."""                            │
│          self._graph.add_conditional_edges(source, router, path_map)        │
│          return self                                                        │
│                                                                             │
│      def compile(                                                           │
│          checkpointer: DjangoCheckpointer | None = global_checkpointer      │
│      ) → CompiledStateGraph:                                                │
│          return self._graph.compile(checkpointer=checkpointer)              │
│                                                                             │
│  # Graph Topology (built in AssistantGraph):                                │
│  #                                                                          │
│  #   START → ROOT ←──────────────────┐                                      │
│  #            │                      │                                      │
│  #            │ has_tool_calls?      │ loop back                            │
│  #            ↓                      │                                      │
│  #       ROOT_TOOLS ─────────────────┘                                      │
│  #            │                                                             │
│  #            │ no more tools                                               │
│  #            ↓                                                             │
│  #           END                                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Node execution
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  BACKEND (BE) - NODE LAYER                                                  │
│  Location: ee/hogai/core/executable.py, ee/hogai/core/node.py               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  class BaseAgentExecutable(                                                 │
│      AssistantContextMixin,                                                 │
│      AssistantDispatcherMixin,                                              │
│      ABC,                                                                   │
│      Generic[StateType, PartialStateType]                                   │
│  ):                                                                         │
│      async def __call__(                                                    │
│          self,                                                              │
│          state: StateType,                                                  │
│          config: RunnableConfig,                                            │
│      ) → PartialStateType:                                                  │
│          """Entry point called by LangGraph."""                             │
│          return await self._execute(state, config)                          │
│                                                                             │
│      async def _execute(state, config) → PartialStateType:                  │
│          """Execute with async/sync fallback."""                            │
│          try:                                                               │
│              return await self._arun_with_context(state, config)            │
│          except NotImplementedError:                                        │
│              return await database_sync_to_async(                           │
│                  self._run_with_context                                     │
│              )(state, config)                                               │
│                                                                             │
│      async def _arun_with_context(state, config) → PartialStateType:        │
│          """Set node path context, then execute."""                         │
│          with set_node_path(self.node_path):                                │
│              return await self.arun(state, config)                          │
│                                                                             │
│      @abstractmethod                                                        │
│      async def arun(                                                        │
│          self,                                                              │
│          state: StateType,                                                  │
│          config: RunnableConfig,                                            │
│      ) → PartialStateType:                                                  │
│          """Override this in subclasses."""                                 │
│          ...                                                                │
│                                                                             │
│  class BaseAssistantNode(BaseAgentExecutable):                              │
│      """Adds dispatcher events and cancellation support."""                 │
│                                                                             │
│      async def __call__(state, config) → PartialStateType:                  │
│          self.dispatcher.dispatch(NodeStartAction())                        │
│                                                                             │
│          if await self._is_conversation_cancelled(thread_id):               │
│              raise GenerationCanceled()                                     │
│                                                                             │
│          result = await self._execute(state, config)                        │
│                                                                             │
│          self.dispatcher.dispatch(NodeEndAction(state=result))              │
│          return result                                                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ AgentExecutable / AgentToolsExecutable
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  BACKEND (BE) - MODE LAYER                                                  │
│  Location: ee/hogai/core/agent_modes/                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  @dataclass                                                                 │
│  class AgentModeDefinition:                                                 │
│      mode: AgentMode                    # e.g., "product_analytics", "sql"  │
│      mode_description: str              # For LLM to decide when to switch  │
│      toolkit_class: type[AgentToolkit]  # Mode-specific tools               │
│      node_class: type[AgentExecutable] = AgentExecutable                    │
│      tools_node_class: type[AgentToolsExecutable] = AgentToolsExecutable    │
│                                                                             │
│  class AgentModeManager(ABC):                                               │
│      _mode: AgentMode                                                       │
│      _node: AgentExecutable | None = None       # Cached                    │
│      _tools_node: AgentToolsExecutable | None = None                        │
│                                                                             │
│      @property                                                              │
│      @abstractmethod                                                        │
│      def mode_registry(self) → dict[AgentMode, AgentModeDefinition]:        │
│          """Return registry of available modes."""                          │
│          ...                                                                │
│                                                                             │
│      @property                                                              │
│      def node(self) → AgentExecutable:                                      │
│          """Lazily instantiate and cache the LLM node."""                   │
│          if not self._node:                                                 │
│              definition = self.mode_registry[self._mode]                    │
│              self._node = definition.node_class(                            │
│                  team=self._team,                                           │
│                  user=self._user,                                           │
│                  toolkit_manager_class=AgentToolkitManager,                 │
│                  prompt_builder_class=AgentPromptBuilder,                   │
│              )                                                              │
│          return self._node                                                  │
│                                                                             │
│      @mode.setter                                                           │
│      def mode(self, value: AgentMode):                                      │
│          """Setting mode invalidates cached nodes."""                       │
│          self._mode = value                                                 │
│          self._node = None          # Force re-instantiation                │
│          self._tools_node = None                                            │
│                                                                             │
│  class AgentExecutable(BaseAgentLoopRootExecutable):                        │
│      """LLM invocation node - generates assistant messages."""              │
│                                                                             │
│      async def arun(state, config) → PartialAssistantState:                 │
│          # 1. Get tools and prompts concurrently                            │
│          tools, prompts = await asyncio.gather(                             │
│              self._toolkit_manager.get_tools(state, config),                │
│              self._prompt_builder.get_prompts(state, config),               │
│          )                                                                  │
│                                                                             │
│          # 2. Bind tools to LLM                                             │
│          model = self._get_model().bind_tools(                              │
│              tools,                                                         │
│              parallel_tool_calls=True,                                      │
│          )                                                                  │
│                                                                             │
│          # 3. Invoke LLM                                                    │
│          message = await model.ainvoke(                                     │
│              prompts + self._get_langchain_messages(state),                 │
│              config,                                                        │
│          )                                                                  │
│                                                                             │
│          # 4. Detect mode changes                                           │
│          new_mode = self._get_updated_agent_mode(message, state.agent_mode) │
│                                                                             │
│          # 5. Return partial state                                          │
│          return PartialAssistantState(                                      │
│              messages=[self._process_output_message(message)],              │
│              agent_mode=new_mode,                                           │
│              root_tool_calls_count=state.root_tool_calls_count + 1,         │
│          )                                                                  │
│                                                                             │
│      def _get_updated_agent_mode(message, current_mode) → AgentMode:        │
│          """Scan tool_calls for switch_mode invocation."""                  │
│          for tool_call in message.tool_calls or []:                         │
│              if tool_call["name"] == "switch_mode":                         │
│                  return tool_call["args"]["new_mode"]                       │
│          return current_mode                                                │
│                                                                             │
│      def router(state: AssistantState) → str | list[Send]:                  │
│          """Route to ROOT_TOOLS if tool calls exist, else END."""           │
│          if state.messages[-1].tool_calls:                                  │
│              return [                                                       │
│                  Send(ROOT_TOOLS, state.model_copy(                         │
│                      update={"root_tool_call_id": tc.id}                    │
│                  ))                                                         │
│                  for tc in state.messages[-1].tool_calls                    │
│              ]                                                              │
│          return END                                                         │
│                                                                             │
│  class AgentToolsExecutable(BaseAgentLoopExecutable):                       │
│      """Tool execution node - executes tool calls in parallel."""           │
│                                                                             │
│      async def arun(state, config) → PartialAssistantState:                 │
│          # 1. Find the tool call to execute                                 │
│          tool_call = self._find_tool_call(                                  │
│              state.messages[-1],                                            │
│              state.root_tool_call_id,                                       │
│          )                                                                  │
│                                                                             │
│          # 2. Get tool instance from toolkit                                │
│          tools = await self._toolkit_manager.get_tools(state, config)       │
│          tool = next(t for t in tools if t.name == tool_call["name"])       │
│                                                                             │
│          # 3. Set node path on tool for nested tracking                     │
│          tool.set_node_path(self.node_path + (NodePath(                     │
│              name=ROOT_TOOLS,                                               │
│              tool_call_id=tool_call["id"],                                  │
│          ),))                                                               │
│                                                                             │
│          # 4. Execute tool                                                  │
│          try:                                                               │
│              result = await tool.ainvoke(                                   │
│                  ToolCall(**tool_call),                                     │
│                  config=config,                                             │
│              )                                                              │
│          except MaxToolError as e:                                          │
│              return PartialAssistantState(                                  │
│                  messages=[ToolCallMessage(                                 │
│                      content=e.to_summary(),                                │
│                      tool_call_id=tool_call["id"],                          │
│                  )]                                                         │
│              )                                                              │
│                                                                             │
│          # 5. Convert result to message                                     │
│          if isinstance(result.artifact, ToolMessagesArtifact):              │
│              return PartialAssistantState(messages=result.artifact.messages)│
│          return PartialAssistantState(                                      │
│              messages=[ToolCallMessage(                                     │
│                  content=result.content,                                    │
│                  tool_call_id=tool_call["id"],                              │
│                  ui_payload={tool.name: result.artifact},                   │
│              )]                                                             │
│          )                                                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ tool.ainvoke(tool_call, config)
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  BACKEND (BE) - TOOL LAYER                                                  │
│  Location: ee/hogai/tool.py, ee/hogai/tools/                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  class MaxTool(                                                             │
│      AssistantContextMixin,                                                 │
│      AssistantDispatcherMixin,                                              │
│      BaseTool,             # LangChain base                                 │
│  ):                                                                         │
│      name: str                          # Tool name for LLM                 │
│      description: str                   # Prompt for when/how to use        │
│      args_schema: type[BaseModel]       # Pydantic schema for args          │
│      response_format: str = "content_and_artifact"                          │
│      billable: bool = False             # Track LLM usage in tool           │
│      context_prompt_template: str | None = None  # Inject into system prompt│
│                                                                             │
│      @classmethod                                                           │
│      async def create_tool_class(                                           │
│          cls,                                                               │
│          *,                                                                 │
│          team: Team,                                                        │
│          user: User,                                                        │
│          state: AssistantState,                                             │
│          config: RunnableConfig,                                            │
│          context_manager: AssistantContextManager,                          │
│          node_path: tuple[NodePath, ...] | None = None,                     │
│      ) → Self:                                                              │
│          """Factory method for dynamic tool configuration."""               │
│          # Override to customize description, args_schema at runtime        │
│          return cls(team=team, user=user, ...)                              │
│                                                                             │
│      async def _arun(                                                       │
│          self,                                                              │
│          **kwargs,                      # Validated args from args_schema   │
│      ) → tuple[str, Any]:                                                   │
│          """LangChain entry point."""                                       │
│          return await self._arun_with_context(**kwargs)                     │
│                                                                             │
│      async def _arun_with_context(**kwargs) → tuple[str, Any]:              │
│          """Set node path context, then execute."""                         │
│          with set_node_path(self._node_path):                               │
│              return await self._arun_impl(**kwargs)                         │
│                                                                             │
│      @abstractmethod                                                        │
│      async def _arun_impl(                                                  │
│          self,                                                              │
│          **kwargs,                                                          │
│      ) → tuple[str, Any]:                                                   │
│          """                                                                │
│          Override in subclasses.                                            │
│          Returns: (text_content, artifact)                                  │
│            - text_content: str shown to LLM                                 │
│            - artifact: None | ToolMessagesArtifact | dict | AgentMode       │
│              → Sent to FE for UI rendering                                  │
│          """                                                                │
│          ...                                                                │
│                                                                             │
│  # Example Tool Implementation:                                             │
│  class ExecuteSQLTool(MaxTool):                                             │
│      name: str = "execute_sql"                                              │
│      args_schema: type = ExecuteSQLToolArgs  # Pydantic model               │
│      description: str = EXECUTE_SQL_PROMPT   # Long prompt with examples    │
│      billable: bool = True                   # Tracks LLM usage             │
│                                                                             │
│      async def _arun_impl(                                                  │
│          self,                                                              │
│          query: str,                    # From args_schema                  │
│      ) → tuple[str, ToolMessagesArtifact]:                                  │
│          # 1. Create visualization artifact (→ FE renders chart)            │
│          artifact = await self._context_manager.artifacts.create(           │
│              content=VisualizationArtifactContent(query=query),             │
│              name="SQL Query Result",                                       │
│          )                                                                  │
│                                                                             │
│          # 2. Execute query                                                 │
│          result = await execute_hogql_query(self._team, query)              │
│                                                                             │
│          # 3. Return messages for state + FE                                │
│          return "", ToolMessagesArtifact(                                   │
│              messages=[                                                     │
│                  ArtifactRefMessage(artifact_id=artifact.id),  # → FE       │
│                  ToolCallMessage(                                           │
│                      content=format_results(result),  # → LLM               │
│                      ui_payload={"execute_sql": query},  # → FE             │
│                  ),                                                         │
│              ]                                                              │
│          )                                                                  │
│                                                                             │
│  # Tool Registration (auto via __init_subclass__):                          │
│  CONTEXTUAL_TOOL_NAME_TO_TOOL: dict[str, type[MaxTool]] = {}                │
│                                                                             │
│  def get_contextual_tool_class(name: str) → type[MaxTool] | None:           │
│      """Lookup tool class by name from registry."""                         │
│      return CONTEXTUAL_TOOL_NAME_TO_TOOL.get(name)                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Returns artifact
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  FRONTEND (FE) - ARTIFACT RENDERING                                        │
│  Location: frontend/src/scenes/max/                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  // Artifact received via SSE stream                                        │
│  interface ToolCallMessage {                                                │
│    type: "tool_call";                                                       │
│    tool_call_id: string;                                                    │
│    content: string;           // For LLM context                            │
│    ui_payload: {              // For FE rendering                           │
│      [toolName: string]: any; // e.g., {"execute_sql": "SELECT ..."}        │
│    };                                                                       │
│  }                                                                          │
│                                                                             │
│  // FE renders based on tool type                                           │
│  function ToolCallRenderer({ message }: { message: ToolCallMessage }) {     │
│    const toolName = Object.keys(message.ui_payload)[0];                     │
│    switch (toolName) {                                                      │
│      case "execute_sql":                                                    │
│        return <SQLQueryResult query={message.ui_payload.execute_sql} />;    │
│      case "create_insight":                                                 │
│        return <InsightVisualization {...message.ui_payload.create_insight}/>│
│      case "filter_session_recordings":                                      │
│        return <RecordingsList {...message.ui_payload} />;                   │
│      default:                                                               │
│        return <GenericToolResult content={message.content} />;              │
│    }                                                                        │
│  }                                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Complete Function Call Flow

### Example: User asks "Show me a trends query for pageviews"

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: FE → BE (HTTP Request)                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FE: useMaxAssistant.sendMessage("Show me a trends query for pageviews")    │
│      │                                                                      │
│      │  POST /api/projects/{id}/max/chat                                    │
│      │  Body: { message: "Show me a trends query for pageviews" }           │
│      ↓                                                                      │
│  BE: ChatView.post(request)                                                 │
│      │                                                                      │
│      │  conversation = Conversation.objects.get_or_create(...)              │
│      │  runner = ChatAgentRunner(conversation=conversation, ...)            │
│      ↓                                                                      │
│      return StreamingHttpResponse(sse_generator(runner.astream()))          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: BE Runner Execution                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BE: BaseAgentRunner.astream()                                              │
│      │                                                                      │
│      ├─ _lock_conversation()                                                │
│      │    conversation.status = "in_progress"                               │
│      │    conversation.save()                                               │
│      │                                                                      │
│      ├─ _init_or_update_state()                                             │
│      │    state = AssistantState(                                           │
│      │        messages=[HumanMessage(content="Show me a trends...")],       │
│      │        agent_mode="product_analytics",                               │
│      │    )                                                                 │
│      │                                                                      │
│      └─ _graph.astream(state, config, stream_mode=["values", "custom"])     │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  _graph IS PRE-REGISTERED WITH NODES                                    ││
│  │                                                                         ││
│  │  The graph was built at construction time (compile_full_graph),         ││
│  │  NOT at execution time. _graph already contains:                        ││
│  │                                                                         ││
│  │  _graph._nodes = {                                                      ││
│  │      "root": AgentLoopGraphNode(...),        # Pre-registered           ││
│  │      "root_tools": AgentLoopGraphToolsNode(...),                        ││
│  │      "title_generator": TitleGeneratorNode(...),                        ││
│  │      ... (12 nodes total)                                               ││
│  │  }                                                                      ││
│  │                                                                         ││
│  │  See: docs/hogai/01-core-execution-framework.md                         ││
│  │       Section: "Registered Nodes vs LLM Tools"                          ││
│  │                                                                         ││
│  │  When astream() runs, LangGraph:                                        ││
│  │  1. Looks up node by name: _graph._nodes["root"]                        ││
│  │  2. Calls it: node.__call__(state, config)                              ││
│  │  3. Node returns PartialState, LangGraph merges it                      ││
│  │  4. Calls router to determine next node                                 ││
│  │  5. Repeats until END                                                   ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: BE Graph Execution - ROOT Node                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  HOW LANGGRAPH CALLS POSTHOG'S AgentExecutable                          ││
│  │                                                                         ││
│  │  _graph._nodes["root"]                      # LangGraph looks up        ││
│  │      ↓                                                                  ││
│  │  AgentLoopGraphNode.__call__(state, config) # PostHog wrapper           ││
│  │      ↓                                                                  ││
│  │  ChatAgentModeManager.node                  # Gets mode-specific exec   ││
│  │      ↓                                                                  ││
│  │  AgentExecutable.__call__(state, config)    # Does the actual LLM work  ││
│  │                                                                         ││
│  │  LangGraph only cares that _nodes["root"] is callable.                  ││
│  │  It doesn't know about PostHog's class hierarchy.                       ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
│  BE: AgentExecutable.__call__(state, config)                                │
│      │                                                                      │
│      ├─ dispatcher.dispatch(NodeStartAction())                              │
│      │    ════════════════════════════════════════════════════════════════  │
│      │    ▶ SSE STREAMS TO FE NOW: "root node starting"                     │
│      │    ══════════════════════════════════════════════════════════════════  │
│      │                                                                      │
│      ├─ tools = await toolkit_manager.get_tools(state, config)              │
│      │    # LLM TOOLS (not graph nodes!) - functions LLM can call           │
│      │    # Returns: [CreateInsightTool, SearchTool, SwitchModeTool, ...]   │
│      │                                                                      │
│      ├─ prompts = await prompt_builder.get_prompts(state, config)           │
│      │    # Returns: [SystemMessage("You are Max, an AI assistant...")]     │
│      │                                                                      │
│      ├─ model = ChatOpenAI(...).bind_tools(tools)                           │
│      │                                                                      │
│      ├─ message = await model.ainvoke(prompts + messages, config)           │
│      │    # LLM responds with tool_call to create_insight                   │
│      │    # message.tool_calls = [                                          │
│      │    #   {"name": "create_insight", "args": {...}, "id": "tc_123"}     │
│      │    # ]                                                               │
│      │    ══════════════════════════════════════════════════════════════════  │
│      │    ▶ SSE STREAMS TO FE NOW: LLM message with tool_calls              │
│      │    ══════════════════════════════════════════════════════════════════  │
│      │                                                                      │
│      ├─ dispatcher.dispatch(NodeEndAction(state=partial_state))             │
│      │                                                                      │
│      └─ return PartialAssistantState(                                       │
│             messages=[AIMessage(tool_calls=[...])],                         │
│         )                                                                   │
│                                                                             │
│  BE: AgentExecutable.router(state)                                          │
│      │                                                                      │
│      └─ return [Send(ROOT_TOOLS, state.copy(root_tool_call_id="tc_123"))]   │
│           # Parallel execution: one Send per tool call                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 4: BE Graph Execution - ROOT_TOOLS Node                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BE: AgentToolsExecutable.__call__(state, config)                           │
│      │                                                                      │
│      ├─ tool_call = find_tool_call(state, "tc_123")                         │
│      │    # {"name": "create_insight", "args": {...}, "id": "tc_123"}       │
│      │                                                                      │
│      ├─ tool = CreateInsightTool.create_tool_class(team, user, state, ...)  │
│      │                                                                      │
│      ├─ tool.set_node_path(self.node_path + (NodePath("ROOT_TOOLS", ...),)) │
│      │                                                                      │
│      └─ result = await tool.ainvoke(ToolCall(**tool_call), config)          │
│                                                                             │
│  BE: CreateInsightTool._arun_impl(title, query_description, insight_type)   │
│      │                                                                      │
│      ├─ # Build InsightsGraph subgraph                                      │
│      ├─ graph = InsightsGraph(team, user).add_trends_generator().compile()  │
│      │                                                                      │
│      ├─ # Execute subgraph to generate HogQL query                          │
│      ├─ result = await graph.ainvoke(insight_state, config)                 │
│      │                                                                      │
│      ├─ # Create visualization artifact                                     │
│      ├─ artifact = await artifacts.create(                                  │
│      │      content=VisualizationArtifactContent(query=hogql_query),        │
│      │  )                                                                   │
│      │                                                                      │
│      └─ return "", ToolMessagesArtifact(                                    │
│             messages=[                                                      │
│                 ArtifactRefMessage(artifact_id=artifact.id),                │
│                 ToolCallMessage(                                            │
│                     content="Created trends insight for pageviews",         │
│                     ui_payload={"create_insight": {...}},                   │
│                 ),                                                          │
│             ]                                                               │
│         )                                                                   │
│         ══════════════════════════════════════════════════════════════════  │
│         ▶ SSE STREAMS TO FE NOW: Tool result with ui_payload                │
│            FE immediately renders the insight visualization                 │
│         ══════════════════════════════════════════════════════════════════  │
│                                                                             │
│  BE: AgentToolsExecutable.router(state)                                     │
│      │                                                                      │
│      └─ return "root"  # Loop back for LLM to see tool result               │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │  THE LOOP: Keeps running until no tool_calls                            ││
│  │                                                                         ││
│  │  ROOT_TOOLS always returns "root" → back to ROOT node                   ││
│  │  ROOT checks: does LLM response have tool_calls?                        ││
│  │    - YES → Send(ROOT_TOOLS) again (loop continues)                      ││
│  │    - NO  → return END (loop exits)                                      ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 5: BE Graph Execution - ROOT Node (Second Iteration)                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BE: AgentExecutable.__call__(state, config)                                │
│      │                                                                      │
│      ├─ # State now includes tool result message                            │
│      ├─ # messages = [HumanMessage, AIMessage(tool_calls), ToolCallMessage] │
│      │                                                                      │
│      ├─ message = await model.ainvoke(prompts + messages, config)           │
│      │    # LLM sees tool result, generates final response                  │
│      │    # message.content = "I've created a trends insight..."            │
│      │    # message.tool_calls = []  (no more tools)                        │
│      │    ══════════════════════════════════════════════════════════════════  │
│      │    ▶ SSE STREAMS TO FE NOW: Final AI response text                   │
│      │       (tokens stream incrementally as LLM generates)                 │
│      │    ══════════════════════════════════════════════════════════════════  │
│      │                                                                      │
│      └─ return PartialAssistantState(messages=[AIMessage(...)])             │
│                                                                             │
│  BE: AgentExecutable.router(state)                                          │
│      │                                                                      │
│      └─ return END  # No tool calls → loop exits                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STREAMING TIMELINE (Real-time, not batched!)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  FE receives SSE events AS THEY HAPPEN, not after all steps complete:  │ │
│  │                                                                        │ │
│  │  T=0ms    Step 3 starts  → SSE: NodeStartAction                        │ │
│  │  T=500ms  LLM responds   → SSE: AIMessage(tool_calls=[...])            │ │
│  │  T=501ms  Step 4 starts  → SSE: NodeStartAction (root_tools)           │ │
│  │  T=2000ms Tool completes → SSE: ToolCallMessage(ui_payload={...})      │ │
│  │           ▶ FE RENDERS CHART IMMEDIATELY (doesn't wait for LLM)        │ │
│  │  T=2001ms Step 5 starts  → SSE: NodeStartAction (root, 2nd iter)       │ │
│  │  T=2100ms LLM token 1    → SSE: "I've"                                 │ │
│  │  T=2150ms LLM token 2    → SSE: " created"                             │ │
│  │  T=2200ms LLM token 3    → SSE: " a trends"                            │ │
│  │           ▶ FE STREAMS TEXT AS TOKENS ARRIVE                           │ │
│  │  T=2500ms LLM done       → SSE: AIMessage(content="I've created...")   │ │
│  │  T=2501ms Graph ends     → SSE: stream closes                          │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  For PARALLEL tool calls (e.g., 2 tools):                                   │
│  T=501ms  ROOT_TOOLS (tool 1) starts                                        │
│  T=502ms  ROOT_TOOLS (tool 2) starts  (parallel!)                           │
│  T=1500ms Tool 2 completes → SSE immediately → FE renders                   │
│  T=2000ms Tool 1 completes → SSE immediately → FE renders                   │
│           ▶ Each result streams as soon as ready, no waiting for siblings   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: FE Rendering (Incremental)                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FE: useMaxAssistant.parseSSEEvent(event)                                   │
│      │                                                                      │
│      ├─ Each SSE event triggers immediate state update                      │
│      ├─ setMessages([...messages, newMessage])                              │
│      │                                                                      │
│      └─ React re-renders affected components                                │
│                                                                             │
│  FE: MessageRenderer component (renders incrementally)                      │
│      │                                                                      │
│      ├─ T=2000ms: <ToolCallMessage ui_payload={create_insight: {...}}>      │
│      │              └─ <InsightVisualization />  # Chart appears!           │
│      │                                                                      │
│      └─ T=2100ms+: <AssistantMessage content="I've..." />                   │
│                      └─ Text streams in token by token                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```


## Documentation Index

### Core Architecture (Read First)

1. **[Core Execution Framework](./01-core-execution-framework.md)** (BE)
   - Class hierarchy (BaseAgentExecutable → BaseAssistantNode)
   - Execution pipeline: `__call__` → `_execute` → `arun`
   - Node path context management
   - **Start here**: Foundational understanding of how nodes execute

2. **[State Management](./02-state-management.md)** (BE)
   - State class hierarchy: `BaseState` → `AssistantState`
   - Merge-by-ID message strategy: `add_and_merge_messages()`
   - `ReplaceMessages` wrapper for conversation compaction
   - Custom reducers and state update patterns

3. **[Runner & Streaming](./03-runner-streaming.md)** (BE)
   - `BaseAgentRunner.astream()` orchestration
   - Conversation locking: `_lock_conversation()`
   - State initialization: `_init_or_update_state()`
   - Stream processor protocol and Redis integration

### Tool System

4. **[Tool System Architecture](./04-tool-system.md)** (BE)
   - `MaxTool` base class: `_arun_impl()` → `tuple[str, artifact]`
   - Factory pattern: `create_tool_class()`
   - Auto-registration: `CONTEXTUAL_TOOL_NAME_TO_TOOL` registry
   - `ToolMessagesArtifact` for multi-message returns

### Mode System

5. **[Agent Modes](./05-agent-modes.md)** (BE)
   - `AgentModeDefinition` dataclass structure
   - `AgentModeManager.node` property (lazy instantiation)
   - `AgentToolkitManager.get_tools()` dynamic assembly
   - `AgentExecutable.arun()` and `AgentToolsExecutable.arun()`

6. **[Context Switching](./06-context-switching.md)** (BE)
   - `SwitchModeTool._arun_impl()` → returns `AgentMode`
   - Mode detection: `_get_updated_agent_mode()`
   - State propagation via `agent_mode` field
   - Cache invalidation in `AgentModeManager.mode` setter

### Prompt & Event Systems

7. **[Prompt System](./07-prompt-system.md)** (BE)
   - `AgentPromptBuilder.get_prompts()` → `list[BaseMessage]`
   - Mustache templates: `format_prompt_string(template, **vars)`
   - `context_prompt_template` injection

8. **[Dispatcher & Events](./08-dispatcher-events.md)** (BE)
   - `AssistantDispatcher.dispatch(action)` → LangGraph custom stream
   - Action types: `NodeStartAction`, `NodeEndAction`, `MessageAction`
   - Non-blocking error handling

### Persistence & Examples

9. **[Checkpoint & Persistence](./09-checkpoint-persistence.md)** (BE)
   - `DjangoCheckpointer.aget_tuple()` / `aput()`
   - Checkpoint namespaces for subgraph isolation
   - `NodeInterrupt` for form-based pausing

10. **[Example Tool Implementations](./10-example-tools.md)** (BE)
    - `SearchTool`: Delegate pattern with subtools
    - `CreateInsightTool`: Subgraph execution pattern
    - `ExecuteSQLTool`: Artifact creation pattern
    - `SwitchModeTool`: Dynamic schema generation

---

## Quick Start Guide

### Suggested Reading Order

#### Phase 1: Core Understanding (BE)
1. **Core Execution Framework** - How nodes execute via `__call__` → `arun`
2. **State Management** - How state flows via `PartialAssistantState` updates
3. **Runner & Streaming** - How `astream()` orchestrates execution

#### Phase 2: Tool & Mode Systems (BE)
4. **Tool System** - How `MaxTool._arun_impl()` returns `(content, artifact)`
5. **Agent Modes** - How `AgentModeManager` switches between modes
6. **Context Switching** - How `SwitchModeTool` triggers mode changes

#### Phase 3: Advanced Features (BE)
7. **Prompt System** - How `AgentPromptBuilder` generates prompts
8. **Dispatcher & Events** - How events stream to client

---

## Reimplementation Checklist

### Backend (Python)

- [ ] **State Classes** - `AssistantState`, `PartialAssistantState`, `add_and_merge_messages()`
- [ ] **Context Management** - `node_path_context`, `AssistantContextManager`
- [ ] **Dispatcher** - `AssistantDispatcher.dispatch()`, action types
- [ ] **Base Executable** - `BaseAgentExecutable.__call__()` → `arun()`
- [ ] **Assistant Node** - `BaseAssistantNode` with cancellation support
- [ ] **MaxTool** - `_arun_impl()` returning `tuple[str, artifact]`
- [ ] **Tool Registry** - Auto-registration via `__init_subclass__`
- [ ] **Mode System** - `AgentModeDefinition`, `AgentModeManager`
- [ ] **Mode Nodes** - `AgentExecutable.arun()`, `AgentToolsExecutable.arun()`
- [ ] **Toolkit Manager** - `AgentToolkitManager.get_tools()`
- [ ] **Graph Builder** - `BaseAssistantGraph.add_node()`, `compile()`
- [ ] **Runner** - `BaseAgentRunner.astream()` with locking
- [ ] **Prompt Builder** - `AgentPromptBuilder.get_prompts()`
- [ ] **Checkpointer** - `DjangoCheckpointer` for state persistence

### Frontend (TypeScript/React)

- [ ] **SSE Hook** - `useMaxAssistant()` with `EventSource` connection
- [ ] **Message Parsing** - Parse `AssistantOutput` events from stream
- [ ] **State Management** - Track messages, streaming state, interrupts
- [ ] **Artifact Rendering** - Route `ui_payload` to appropriate components
- [ ] **Form Handling** - Handle `NodeInterrupt` for `create_form` tool

---

## Key Design Patterns

### 1. Generic State Pattern (BE)
```python
class BaseAgentExecutable(Generic[StateType, PartialStateType]):
    async def arun(self, state: StateType, config) -> PartialStateType:
        ...
```

### 2. Merge-by-ID Pattern (BE)
```python
def add_and_merge_messages(existing: list, updates: list) -> list:
    """Messages with matching IDs replace; new IDs append."""
```

### 3. Factory Method Pattern (BE)
```python
@classmethod
async def create_tool_class(cls, team, user, state, config) -> Self:
    """Create tool instance with runtime configuration."""
```

### 4. Lazy Initialization Pattern (BE)
```python
@property
def node(self) -> AgentExecutable:
    if not self._node:
        self._node = self._create_node()
    return self._node
```

### 5. Dispatcher Pattern (BE → FE)
```python
self.dispatcher.dispatch(MessageAction(message=msg))  # → SSE stream → FE
```

---

**Happy Building!**

For questions, refer to individual documents or explore `/ee/hogai/` source code.
