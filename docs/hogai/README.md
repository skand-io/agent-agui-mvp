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
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 3: BE Graph Execution - ROOT Node                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BE: AgentExecutable.__call__(state, config)                                │
│      │                                                                      │
│      ├─ dispatcher.dispatch(NodeStartAction())  → SSE: status event         │
│      │                                                                      │
│      ├─ tools = await toolkit_manager.get_tools(state, config)              │
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
│                                                                             │
│  BE: AgentToolsExecutable.router(state)                                     │
│      │                                                                      │
│      └─ return "root"  # Loop back for LLM to see tool result               │
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
│      │                                                                      │
│      └─ return PartialAssistantState(messages=[AIMessage(...)])             │
│                                                                             │
│  BE: AgentExecutable.router(state)                                          │
│      │                                                                      │
│      └─ return END  # No tool calls, exit graph                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 6: BE → FE (SSE Stream)                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  BE: BaseAgentRunner._process_update(update)                                │
│      │                                                                      │
│      └─ yields:                                                             │
│           (MESSAGE, AIMessage(tool_calls=[...]))         # Step 3 result    │
│           (MESSAGE, ToolCallMessage(ui_payload={...}))   # Step 4 result    │
│           (MESSAGE, AIMessage(content="I've created...")) # Step 5 result   │
│                                                                             │
│  BE: sse_generator() converts to SSE format:                                │
│      event: MESSAGE                                                         │
│      data: {"type": "ai", "content": "", "tool_calls": [...]}               │
│                                                                             │
│      event: MESSAGE                                                         │
│      data: {"type": "tool_call", "ui_payload": {"create_insight": {...}}}   │
│                                                                             │
│      event: MESSAGE                                                         │
│      data: {"type": "ai", "content": "I've created a trends insight..."}    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 7: FE Rendering                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  FE: useMaxAssistant.parseSSEEvent(event)                                   │
│      │                                                                      │
│      ├─ Adds messages to state                                              │
│      ├─ setMessages([...messages, newMessage])                              │
│      │                                                                      │
│      └─ Re-renders UI                                                       │
│                                                                             │
│  FE: MessageRenderer component                                              │
│      │                                                                      │
│      ├─ <ToolCallMessage ui_payload={create_insight: {...}}>                │
│      │    └─ <InsightVisualization query={...} />  # Renders chart          │
│      │                                                                      │
│      └─ <AssistantMessage content="I've created a trends insight..." />     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## State Flow Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STATE LAYER (BE)                                                           │
│  Location: ee/hogai/utils/types/base.py                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  class AssistantState(BaseStateWithMessages):                               │
│      """Full state - flows through entire graph."""                         │
│                                                                             │
│      messages: Annotated[list[AssistantMessage], add_and_merge_messages]    │
│      agent_mode: AgentMode | None = None                                    │
│      root_tool_call_id: str | None = None      # Current tool being executed│
│      root_tool_calls_count: int = 0            # Track iterations           │
│      start_id: str | None = None               # Conversation window start  │
│      start_dt: datetime | None = None          # For cache expiration       │
│      # ... 30+ more fields                                                  │
│                                                                             │
│  class PartialAssistantState(BaseStateWithMessages):                        │
│      """Partial state - nodes return updates only."""                       │
│                                                                             │
│      messages: list[AssistantMessage] | ReplaceMessages | None = None       │
│      agent_mode: AgentMode | None = None                                    │
│      # All fields optional - only set what changed                          │
│                                                                             │
│  def add_and_merge_messages(                                                │
│      existing: list[AssistantMessage],                                      │
│      updates: list[AssistantMessage],                                       │
│  ) → list[AssistantMessage]:                                                │
│      """                                                                    │
│      Reducer for messages field:                                            │
│      - Messages with same ID: update in place                               │
│      - Messages with new ID: append                                         │
│      - ReplaceMessages wrapper: replace entire list                         │
│      """                                                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

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
