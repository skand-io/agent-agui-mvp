# HogAI Agent Modes System

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [AgentModeDefinition](#agentmodedefinition)
4. [AgentModeManager](#agentmodemanager)
5. [AgentToolkit & AgentToolkitManager](#agenttoolkit--agenttoolkitmanager)
6. [AgentExecutable & AgentToolsExecutable](#agentexecutable--agenttoolsexecutable)
7. [Mode Presets](#mode-presets)
8. [SwitchModeTool](#switchmodetool)
9. [Implementation Guide](#implementation-guide)
10. [Complete Example](#complete-example)

---

## Overview

The Agent Modes System is a modular architecture that allows HogAI to operate in different specialized modes, each with its own toolkit, execution logic, and capabilities. The system enables dynamic mode switching while preserving conversation context and state.

**Key Features:**

- **Mode Registry**: Centralized registry mapping `AgentMode` enum values to mode definitions
- **Dynamic Tool Assembly**: Tools are assembled from both agent-level and mode-specific toolkits
- **Lazy Node Instantiation**: Nodes are created on-demand and cached until mode changes
- **Mode Switching**: Runtime mode changes via `SwitchModeTool` with automatic cache invalidation
- **Tool Execution Routing**: Different node classes for LLM invocation vs tool execution

**Architecture Flow:**

```
User Input
    ↓
AgentModeManager (determines current mode)
    ↓
AgentExecutable (LLM invocation node)
    ↓
AgentToolkitManager.get_tools() (assembles tools from agent + mode toolkits)
    ↓
LLM generates tool calls
    ↓
AgentToolsExecutable (tool execution node, parallel execution via langgraph Send)
    ↓
Tool results returned to AgentExecutable
    ↓
Loop continues or exits
```

---

## Core Concepts

### AgentMode Enum

The `AgentMode` enum (from `posthog.schema`) defines available modes:

```python
from posthog.schema import AgentMode

# Available modes:
AgentMode.PRODUCT_ANALYTICS  # General-purpose product analytics
AgentMode.SQL               # SQL query generation and execution
AgentMode.SESSION_REPLAY    # Session recording analysis
```

### Node Types

The system uses two specialized node types:

1. **AgentExecutable** (LLM invocation node): Handles LLM calls, generates assistant messages with tool calls
2. **AgentToolsExecutable** (Tool execution node): Executes tool calls in parallel, returns results

### Tool Organization

Tools are organized into two categories:

1. **Agent Toolkit**: Common tools available across all modes (e.g., `ReadTaxonomyTool`, `SearchTool`, `SwitchModeTool`)
2. **Mode Toolkit**: Specialized tools specific to a mode (e.g., `ExecuteSQLTool` for SQL mode)

---

## AgentModeDefinition

`AgentModeDefinition` is a dataclass that encapsulates all configuration for a specific mode.

### Source Code

**File:** `/ee/hogai/core/agent_modes/factory.py`

```python
from dataclasses import dataclass
from posthog.schema import AgentMode
from .executables import AgentExecutable, AgentToolsExecutable
from .toolkit import AgentToolkit


@dataclass
class AgentModeDefinition:
    mode: AgentMode
    """The name of the agent's mode."""

    mode_description: str
    """The description of the agent's mode that will be injected into the tool.
    Keep it short and concise."""

    toolkit_class: type[AgentToolkit] = AgentToolkit
    """A custom toolkit class to use for the agent."""

    node_class: type[AgentExecutable] = AgentExecutable
    """A custom node class to use for the agent."""

    tools_node_class: type[AgentToolsExecutable] = AgentToolsExecutable
    """A custom tools node class to use for the agent."""
```

### Fields Explained

1. **mode**: Enum value identifying this mode (e.g., `AgentMode.SQL`)
2. **mode_description**: Human-readable description shown to the LLM when deciding whether to switch modes
3. **toolkit_class**: Class defining which tools are available in this mode
4. **node_class**: Custom executable class for LLM invocation (defaults to `AgentExecutable`)
5. **tools_node_class**: Custom executable class for tool execution (defaults to `AgentToolsExecutable`)

### Usage Example

```python
from posthog.schema import AgentMode
from ee.hogai.core.agent_modes.factory import AgentModeDefinition
from ee.hogai.tools import ExecuteSQLTool

class SQLAgentToolkit(AgentToolkit):
    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [ExecuteSQLTool]

sql_agent = AgentModeDefinition(
    mode=AgentMode.SQL,
    mode_description="Specialized mode capable of generating and executing SQL queries.",
    toolkit_class=SQLAgentToolkit,
)
```

---

## AgentModeManager

`AgentModeManager` is an abstract base class that manages the current mode and provides lazy-instantiated nodes.

### Source Code

**File:** `/ee/hogai/core/agent_modes/mode_manager.py`

```python
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Optional
from posthog.schema import AgentMode
from posthog.models import Team, User
from ee.hogai.context import AssistantContextManager
from ee.hogai.utils.types.base import NodePath

if TYPE_CHECKING:
    from .executables import AgentExecutable, AgentToolsExecutable
    from .factory import AgentModeDefinition


class AgentModeManager(AssistantContextMixin, ABC):
    _node: Optional["AgentExecutable"] = None
    _tools_node: Optional["AgentToolsExecutable"] = None

    def __init__(
        self,
        *,
        team: Team,
        user: User,
        node_path: tuple[NodePath, ...],
        context_manager: AssistantContextManager,
        mode: AgentMode | None = None,
    ):
        self._team = team
        self._user = user
        self._node_path = node_path
        self._context_manager = context_manager
        if has_agent_modes_feature_flag(team, user):
            self._mode = mode or AgentMode.PRODUCT_ANALYTICS
        else:
            self._mode = AgentMode.PRODUCT_ANALYTICS

    @property
    @abstractmethod
    def mode_registry(self) -> dict[AgentMode, "AgentModeDefinition"]:
        raise NotImplementedError("Mode registry is not implemented")

    @property
    @abstractmethod
    def toolkit_class(self) -> type[AgentToolkit]:
        raise NotImplementedError("Toolkit classes are not implemented")

    @property
    @abstractmethod
    def prompt_builder_class(self) -> type[AgentPromptBuilder]:
        raise NotImplementedError("Prompt builder class is not implemented")

    @property
    @abstractmethod
    def toolkit_manager_class(self) -> type[AgentToolkitManager]:
        return AgentToolkitManager

    @property
    def node(self) -> "AgentExecutable":
        if not self._node:
            agent_definition = self.mode_registry[self._mode]
            toolkit_manager_class = self.toolkit_manager_class
            toolkit_manager_class.configure(
                agent_toolkit=self.toolkit_class,
                mode_toolkit=agent_definition.toolkit_class,
                mode_registry=self.mode_registry,
            )
            self._node = agent_definition.node_class(
                team=self._team,
                user=self._user,
                node_path=self._node_path,
                toolkit_manager_class=toolkit_manager_class,
                prompt_builder_class=self.prompt_builder_class,
            )
        return self._node

    @property
    def tools_node(self) -> "AgentToolsExecutable":
        if not self._tools_node:
            agent_definition = self.mode_registry[self._mode]
            toolkit_manager_class = self.toolkit_manager_class
            toolkit_manager_class.configure(
                agent_toolkit=self.toolkit_class,
                mode_toolkit=agent_definition.toolkit_class,
                mode_registry=self.mode_registry,
            )
            self._tools_node = agent_definition.tools_node_class(
                team=self._team,
                user=self._user,
                node_path=self._node_path,
                toolkit_manager_class=toolkit_manager_class,
            )

        return self._tools_node

    @property
    def mode(self) -> AgentMode:
        return self._mode

    @mode.setter
    def mode(self, value: AgentMode):
        self._mode = value
        self._node = None
        self._tools_node = None
```

### Key Behaviors

**Lazy Instantiation:**

- `node` and `tools_node` properties cache instances in `_node` and `_tools_node`
- Nodes are created on first access, not in `__init__`
- This defers expensive initialization until actually needed

**Cache Invalidation:**

- When `mode` is set, both `_node` and `_tools_node` are cleared
- Next access to `node` or `tools_node` will create new instances with the new mode's configuration

**Toolkit Configuration:**

- Before creating nodes, the `toolkit_manager_class` is configured via `configure()` class method
- This sets the agent toolkit, mode toolkit, and mode registry on the class itself

**Mode Registry:**

- Abstract property requiring concrete implementations to define available modes
- Maps `AgentMode` values to `AgentModeDefinition` instances

### Concrete Implementation Example

**File:** `/ee/hogai/chat_agent/mode_manager.py`

```python
from posthog.schema import AgentMode
from ee.hogai.core.agent_modes.mode_manager import AgentModeManager
from ee.hogai.core.agent_modes.presets.product_analytics import product_analytics_agent
from ee.hogai.core.agent_modes.presets.sql import sql_agent
from ee.hogai.core.agent_modes.presets.session_replay import session_replay_agent


class ChatAgentModeManager(AgentModeManager):
    @property
    def mode_registry(self) -> dict[AgentMode, AgentModeDefinition]:
        return {
            AgentMode.PRODUCT_ANALYTICS: product_analytics_agent,
            AgentMode.SQL: sql_agent,
            AgentMode.SESSION_REPLAY: session_replay_agent,
        }

    @property
    def toolkit_class(self) -> type[AgentToolkit]:
        return ChatAgentToolkit

    @property
    def prompt_builder_class(self) -> type[AgentPromptBuilder]:
        return ChatAgentPromptBuilder

    @property
    def toolkit_manager_class(self) -> type[AgentToolkitManager]:
        return ChatAgentToolkitManager
```

---

## AgentToolkit & AgentToolkitManager

### AgentToolkit

`AgentToolkit` is a base class for defining collections of tools. Subclasses override the `tools` property to specify which tool classes are available.

**File:** `/ee/hogai/core/agent_modes/toolkit.py`

```python
from typing import TYPE_CHECKING
from posthog.models import Team, User
from ee.hogai.context import AssistantContextManager

if TYPE_CHECKING:
    from ee.hogai.tool import MaxTool
    from ee.hogai.tools.todo_write import TodoWriteExample


class AgentToolkit:
    POSITIVE_TODO_EXAMPLES: Sequence["TodoWriteExample"] | None = None
    """
    Positive examples that will be injected into the `todo_write` tool.
    Use this field to explain the agent how it should orchestrate complex
    tasks using provided tools.
    """

    NEGATIVE_TODO_EXAMPLES: Sequence["TodoWriteExample"] | None = None
    """
    Negative examples that will be injected into the `todo_write` tool.
    Use this field to explain the agent how it should **NOT** orchestrate
    tasks using provided tools.
    """

    def __init__(
        self,
        *,
        team: Team,
        user: User,
        context_manager: AssistantContextManager,
    ):
        self._team = team
        self._user = user
        self._context_manager = context_manager

    @property
    def tools(self) -> list[type["MaxTool"]]:
        """
        Custom tools are tools that are not part of the default toolkit.
        """
        return []
```

**Key Features:**

- **POSITIVE_TODO_EXAMPLES**: Examples showing correct tool orchestration patterns
- **NEGATIVE_TODO_EXAMPLES**: Examples showing incorrect patterns to avoid
- **tools property**: Returns list of tool classes (not instances)

**Example: SQL Toolkit with Examples**

**File:** `/ee/hogai/core/agent_modes/presets/sql.py`

```python
from ee.hogai.tools import ExecuteSQLTool
from ee.hogai.tools.todo_write import TodoWriteExample

POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION = """
User: what is our ARR from the US?
Assistant: I'll help you find your current ARR from the US users. Let me create a todo list.
*Creates todo list with the following items:*
1. Find the relevant data warehouse tables having financial data
2. Find column that can be used to associate a user with PostHog's default "persons" table
3. Retrieve person properties to narrow down data to users from specific country
4. Execute the SQL query
5. Analyze retrieved data
""".strip()

POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION_REASONING = """
The assistant used the todo list because:
1. Creating an SQL query requires understanding taxonomy and data warehouse tables
2. The data warehouse schema is complex
3. Property values might require sampling to understand the data
4. Multiple combinations of data might equally answer the question
""".strip()


class SQLAgentToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example=POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION,
            reasoning=POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION_REASONING,
        ),
    ]

    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [ExecuteSQLTool]
```

### AgentToolkitManager

`AgentToolkitManager` assembles tools from multiple toolkits and handles special tools like `TodoWriteTool` and `SwitchModeTool`.

**File:** `/ee/hogai/core/agent_modes/toolkit.py`

```python
import asyncio
from typing import TYPE_CHECKING, cast
from langchain_core.runnables import RunnableConfig
from posthog.models import Team, User
from ee.hogai.context import AssistantContextManager
from ee.hogai.tools.switch_mode import SwitchModeTool
from ee.hogai.tools.todo_write import TodoWriteTool
from ee.hogai.utils.types.base import AssistantState

if TYPE_CHECKING:
    from ee.hogai.tool import MaxTool
    from .factory import AgentModeDefinition


class AgentToolkitManager:
    _mode_registry: dict[AgentMode, "AgentModeDefinition"]
    _agent_toolkit: type[AgentToolkit]
    _mode_toolkit: type[AgentToolkit]

    def __init__(self, *, team: Team, user: User, context_manager: AssistantContextManager):
        self._team = team
        self._user = user
        self._context_manager = context_manager

    @classmethod
    def configure(
        cls,
        agent_toolkit: type[AgentToolkit],
        mode_toolkit: type[AgentToolkit],
        mode_registry: dict[AgentMode, "AgentModeDefinition"],
    ):
        cls._agent_toolkit = agent_toolkit
        cls._mode_toolkit = mode_toolkit
        cls._mode_registry = mode_registry

    async def get_tools(self, state: AssistantState, config: RunnableConfig) -> list["MaxTool"]:
        toolkits = [self._agent_toolkit, self._mode_toolkit]

        # Accumulate positive and negative examples from all toolkits
        positive_examples: list[TodoWriteExample] = []
        negative_examples: list[TodoWriteExample] = []
        for toolkit_class in toolkits:
            positive_examples.extend(toolkit_class.POSITIVE_TODO_EXAMPLES or [])
            negative_examples.extend(toolkit_class.NEGATIVE_TODO_EXAMPLES or [])

        # Initialize the static toolkit
        static_tools: list[Awaitable[MaxTool]] = []
        for toolkit_class in toolkits:
            toolkit = toolkit_class(team=self._team, user=self._user, context_manager=self._context_manager)
            for tool_class in toolkit.tools:
                if tool_class is TodoWriteTool:
                    if toolkit_class is self._mode_toolkit:
                        raise ValueError("TodoWriteTool is not allowed in the mode toolkit")
                    todo_future = cast(type[TodoWriteTool], tool_class).create_tool_class(
                        team=self._team,
                        user=self._user,
                        state=state,
                        config=config,
                        context_manager=self._context_manager,
                        positive_examples=positive_examples,
                        negative_examples=negative_examples,
                    )
                    static_tools.append(todo_future)
                elif tool_class == SwitchModeTool:
                    if toolkit_class is self._mode_toolkit:
                        raise ValueError("SwitchModeTool is not allowed in the mode toolkit")
                    switch_mode_future = SwitchModeTool.create_tool_class(
                        team=self._team,
                        user=self._user,
                        state=state,
                        config=config,
                        context_manager=self._context_manager,
                        mode_registry=self._mode_registry,
                        default_tool_classes=toolkit.tools,
                    )
                    static_tools.append(switch_mode_future)
                else:
                    tool_future = tool_class.create_tool_class(
                        team=self._team,
                        user=self._user,
                        state=state,
                        config=config,
                        context_manager=self._context_manager,
                    )
                    static_tools.append(tool_future)

        return await asyncio.gather(*static_tools)
```

### Key Behaviors

**Tool Assembly Flow:**

1. Iterate through both agent toolkit and mode toolkit
2. For each toolkit:
   - Instantiate the toolkit class
   - Iterate through tool classes in `toolkit.tools`
   - Create tool instances via `create_tool_class()` async factory method
3. Accumulate TODO examples from all toolkits
4. Special handling for `TodoWriteTool` and `SwitchModeTool`
5. Gather all tool creation futures concurrently

**Special Tool Handling:**

- **TodoWriteTool**: Inject accumulated positive/negative examples from both toolkits
- **SwitchModeTool**: Inject mode registry and default tool classes for generating mode descriptions
- Both tools are **prohibited** in mode toolkits (must be in agent toolkit only)

**Class-Level Configuration:**

- `configure()` is a class method that sets class variables
- This allows the toolkit manager to be configured once and reused across multiple instances
- Configuration includes agent toolkit, mode toolkit, and mode registry

---

## AgentExecutable & AgentToolsExecutable

### AgentExecutable (LLM Invocation Node)

`AgentExecutable` is responsible for invoking the LLM with system prompts, tools, and conversation history.

**File:** `/ee/hogai/core/agent_modes/executables.py`

```python
from langchain_core.runnables import RunnableConfig
from langgraph.types import Send
from posthog.models import Team, User
from ee.hogai.core.agent_modes.toolkit import AgentToolkitManager
from ee.hogai.core.agent_modes.prompt_builder import AgentPromptBuilder
from ee.hogai.utils.types import AssistantState, PartialAssistantState, AssistantNodeName
from ee.hogai.utils.types.base import NodePath


class AgentExecutable(BaseAgentLoopRootExecutable):
    MAX_TOOL_CALLS = 24
    """Determines the maximum number of tool calls allowed in a single generation."""

    THINKING_CONFIG = {"type": "enabled", "budget_tokens": 1024}
    """Determines the thinking configuration for the model."""

    def __init__(
        self,
        *,
        team: Team,
        user: User,
        toolkit_manager_class: type[AgentToolkitManager],
        prompt_builder_class: type[AgentPromptBuilder],
        node_path: tuple[NodePath, ...],
    ):
        super().__init__(
            team=team,
            user=user,
            toolkit_manager_class=toolkit_manager_class,
            prompt_builder_class=prompt_builder_class,
            node_path=node_path,
        )

    async def arun(self, state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
        # 1. Initialize toolkit manager and prompt builder
        toolkit_manager = self._toolkit_manager_class(
            team=self._team, user=self._user, context_manager=self.context_manager
        )
        prompt_builder = self._prompt_builder_class(
            team=self._team, user=self._user, context_manager=self.context_manager
        )

        # 2. Get tools and system prompts concurrently
        tools, system_prompts = await asyncio.gather(
            toolkit_manager.get_tools(state, config),
            prompt_builder.get_prompts(state, config)
        )

        # 3. Get model bound with tools
        model = self._get_model(state, tools)

        # 4. Construct messages with conversation history
        langchain_messages = self._construct_messages(
            state.messages, state.root_conversation_start_id, state.root_tool_calls_count
        )

        # 5. Invoke LLM
        message = await model.ainvoke(system_prompts + langchain_messages, config)

        # 6. Process output into assistant message
        assistant_message = self._process_output_message(message)

        # 7. Update state with new message and tool call count
        tool_call_count = (state.root_tool_calls_count or 0) + 1 if assistant_message.tool_calls else None

        return PartialAssistantState(
            messages=[assistant_message],
            root_tool_calls_count=tool_call_count,
            agent_mode=self._get_updated_agent_mode(assistant_message, state.agent_mode_or_default),
        )

    def router(self, state: AssistantState):
        last_message = state.messages[-1]
        if not isinstance(last_message, AssistantMessage) or not last_message.tool_calls:
            return AssistantNodeName.END
        # Fan out to parallel tool execution nodes
        return [
            Send(AssistantNodeName.ROOT_TOOLS, state.model_copy(update={"root_tool_call_id": tool_call.id}))
            for tool_call in last_message.tool_calls
        ]

    def _get_updated_agent_mode(self, generated_message: AssistantMessage, current_mode: AgentMode) -> AgentMode | None:
        from ee.hogai.tools.switch_mode import SWITCH_MODE_TOOL_NAME

        for tool_call in generated_message.tool_calls or []:
            if tool_call.name == SWITCH_MODE_TOOL_NAME and (new_mode := tool_call.args.get("new_mode")):
                return new_mode
        return current_mode
```

**Key Behaviors:**

**Tool Call Limiting:**

- `MAX_TOOL_CALLS = 24` prevents infinite loops
- When limit is reached, model is invoked without tools bound (forcing it to respond without calling tools)

**Mode Detection:**

- `_get_updated_agent_mode()` checks if any tool calls are `switch_mode`
- If found, extracts `new_mode` from tool args and returns it
- State update includes the new mode, triggering mode manager cache invalidation

**Routing Logic:**

- If no tool calls: route to `END`
- If tool calls present: use `Send` to fan out to parallel `ROOT_TOOLS` nodes (one per tool call)
- Each `Send` gets a copy of state with specific `root_tool_call_id`

### AgentToolsExecutable (Tool Execution Node)

`AgentToolsExecutable` executes individual tool calls and returns results.

**File:** `/ee/hogai/core/agent_modes/executables.py`

```python
from uuid import uuid4
from langchain_core.messages import ToolCall, ToolMessage as LangchainToolMessage
from langchain_core.runnables import RunnableConfig
from posthog.schema import AssistantMessage, AssistantToolCallMessage
from posthog.models import Team, User
from ee.hogai.core.agent_modes.toolkit import AgentToolkitManager
from ee.hogai.tool_errors import MaxToolError
from ee.hogai.utils.types import AssistantState, PartialAssistantState


class AgentToolsExecutable(BaseAgentLoopExecutable):
    async def arun(self, state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
        last_message = state.messages[-1]

        reset_state = PartialAssistantState(root_tool_call_id=None)
        if not isinstance(last_message, AssistantMessage) or not last_message.id or not state.root_tool_call_id:
            return reset_state

        # 1. Find the current tool call in the last message
        tool_call = next(
            (tool_call for tool_call in last_message.tool_calls or [] if tool_call.id == state.root_tool_call_id),
            None
        )
        if not tool_call:
            return reset_state

        # 2. Find the tool class in the toolkit
        toolkit_manager = self._toolkit_manager_class(
            team=self._team, user=self._user, context_manager=self.context_manager
        )
        available_tools = await toolkit_manager.get_tools(state, config)
        tool = next((tool for tool in available_tools if tool.get_name() == tool_call.name), None)

        # 3. If tool doesn't exist, return error message
        if not tool:
            return PartialAssistantState(
                messages=[
                    AssistantToolCallMessage(
                        content=ROOT_TOOL_DOES_NOT_EXIST,
                        id=str(uuid4()),
                        tool_call_id=tool_call.id,
                    )
                ],
            )

        # 4. Execute the tool
        try:
            result = await tool.ainvoke(
                ToolCall(type="tool_call", name=tool_call.name, args=tool_call.args, id=tool_call.id),
                config=config
            )
            if not isinstance(result, LangchainToolMessage):
                raise ValueError(f"Tool '{tool_call.name}' returned {type(result).__name__}, expected LangchainToolMessage")
        except MaxToolError as e:
            # Handle tool errors with retry hints
            content = f"Tool failed: {e.to_summary()}.{e.retry_hint}"
            return PartialAssistantState(
                messages=[
                    AssistantToolCallMessage(
                        content=content,
                        id=str(uuid4()),
                        tool_call_id=tool_call.id,
                    )
                ],
            )
        except Exception as e:
            # Handle unexpected errors
            return PartialAssistantState(
                messages=[
                    AssistantToolCallMessage(
                        content="The tool raised an internal error. Do not immediately retry.",
                        id=str(uuid4()),
                        tool_call_id=tool_call.id,
                    )
                ],
            )

        # 5. Return tool result message
        tool_message = AssistantToolCallMessage(
            content=str(result.content) if result.content else "",
            ui_payload={tool_call.name: result.artifact},
            id=str(uuid4()),
            tool_call_id=tool_call.id,
        )

        return PartialAssistantState(messages=[tool_message])

    def router(self, state: AssistantState) -> Literal["root", "end"]:
        last_message = state.messages[-1]
        if isinstance(last_message, AssistantToolCallMessage):
            return "root"  # Return to LLM node with tool results
        return "end"
```

**Key Behaviors:**

**Tool Lookup:**

- Uses `state.root_tool_call_id` to find specific tool call in last message
- Gets available tools from toolkit manager (same tools that were bound to LLM)
- Matches tool by name

**Error Handling:**

- `MaxToolError`: Custom error with retry strategies and hints
- `ValidationError`: Schema validation failures
- Generic `Exception`: Unexpected errors

**Result Processing:**

- Tool returns `LangchainToolMessage` with content and artifact
- Converted to `AssistantToolCallMessage` with `tool_call_id` linking back to the original call
- `ui_payload` contains tool artifacts for frontend rendering

**Routing:**

- If last message is `AssistantToolCallMessage`: route back to `root` (LLM node)
- Otherwise: route to `end`

---

## Mode Presets

### Product Analytics Mode

**File:** `/ee/hogai/core/agent_modes/presets/product_analytics.py`

```python
from posthog.schema import AgentMode
from ee.hogai.tools import CreateInsightTool, CreateDashboardTool
from ..factory import AgentModeDefinition
from ..toolkit import AgentToolkit


class ProductAnalyticsAgentToolkit(AgentToolkit):
    @property
    def tools(self) -> list[type["MaxTool"]]:
        tools: list[type[MaxTool]] = []

        if has_agent_modes_feature_flag(self._team, self._user):
            tools.append(CreateInsightTool)

        # Add other lower-priority tools
        tools.append(CreateDashboardTool)

        return tools


product_analytics_agent = AgentModeDefinition(
    mode=AgentMode.PRODUCT_ANALYTICS,
    mode_description="General-purpose mode for product analytics tasks.",
    toolkit_class=ProductAnalyticsAgentToolkit,
)
```

**Available Tools:**

- `CreateInsightTool`: Create analytics insights (trends, funnels, retention, etc.)
- `CreateDashboardTool`: Create and manage dashboards

### SQL Mode

**File:** `/ee/hogai/core/agent_modes/presets/sql.py`

```python
from posthog.schema import AgentMode
from ee.hogai.tools import ExecuteSQLTool
from ee.hogai.tools.todo_write import TodoWriteExample
from ..factory import AgentModeDefinition
from ..toolkit import AgentToolkit


POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION = """
User: what is our ARR from the US?
Assistant: I'll help you find your current ARR from the US users. Let me create a todo list.
*Creates todo list with the following items:*
1. Find the relevant data warehouse tables having financial data to create an SQL query
2. Find in the tables a column that can be used to associate a user with the PostHog's default table "persons."
3. Retrieve person properties to narrow down data to users from specific country
4. Execute the SQL query
5. Analyze retrieved data
*Begins working on the first task*
""".strip()

POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION_REASONING = """
The assistant used the todo list because:
1. Creating an SQL query (insight) requires understanding the taxonomy and data warehouse tables
2. The data warehouse schema is complex and requires understanding relationships
3. The user query requests additional segmentation using their data schema
4. Property values might require retrieving sample property values
5. Taxonomy and data warehouse schema might have multiple combinations of data
""".strip()


class SQLAgentToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example=POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION,
            reasoning=POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION_REASONING,
        ),
    ]

    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [ExecuteSQLTool]


sql_agent = AgentModeDefinition(
    mode=AgentMode.SQL,
    mode_description="Specialized mode capable of generating and executing SQL queries. This mode allows you to query the ClickHouse database, which contains both data collected by PostHog (events, groups, persons, sessions) and data warehouse sources connected by the user, such as SQL tables, CRMs, and external systems. This mode can also be used to search for specific data that can be used in other modes.",
    toolkit_class=SQLAgentToolkit,
)
```

**Available Tools:**

- `ExecuteSQLTool`: Generate and execute SQL queries against ClickHouse

**TODO Examples:**

- Teaches the agent how to orchestrate complex SQL tasks
- Examples show multi-step workflows involving taxonomy discovery and data warehouse exploration

### Session Replay Mode

**File:** `/ee/hogai/core/agent_modes/presets/session_replay.py`

```python
from posthog.schema import AgentMode
from ee.hogai.tools.replay.filter_session_recordings import FilterSessionRecordingsTool
from ee.hogai.tools.replay.summarize_sessions import SummarizeSessionsTool
from ee.hogai.tools.todo_write import TodoWriteExample
from ..factory import AgentModeDefinition
from ..toolkit import AgentToolkit


POSITIVE_EXAMPLE_FILTER_WITH_PROPERTIES = """
User: Show me recordings of mobile users from the US who encountered errors
Assistant: I'll help you find those recordings. Let me create a todo list to ensure I discover the right properties and filters.
*Creates todo list with the following items:*
1. Use read_taxonomy to discover person properties for country filtering
2. Use read_taxonomy to discover session properties for device type
3. Use read_taxonomy to discover recording properties for errors
4. Filter session recordings with the discovered properties
*Begins working on the first task*
""".strip()

POSITIVE_EXAMPLE_FILTER_WITH_PROPERTIES_REASONING = """
The assistant used the todo list because:
1. Filtering session recordings requires discovering multiple property types (person, session, recording)
2. Property names and values must be validated through read_taxonomy before creating filters
3. The query involves multiple filter criteria that need to be combined
4. The filter_session_recordings tool documentation explicitly requires using read_taxonomy for property discovery
5. Breaking this into steps ensures all properties are discovered before attempting to filter
""".strip()


class SessionReplayAgentToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example=POSITIVE_EXAMPLE_FILTER_WITH_PROPERTIES,
            reasoning=POSITIVE_EXAMPLE_FILTER_WITH_PROPERTIES_REASONING,
        ),
    ]

    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [FilterSessionRecordingsTool, SummarizeSessionsTool]


session_replay_agent = AgentModeDefinition(
    mode=AgentMode.SESSION_REPLAY,
    mode_description="Specialized mode for analyzing session recordings and user behavior. This mode allows you to filter session recordings, and summarize entire sessions or a set of them.",
    toolkit_class=SessionReplayAgentToolkit,
)
```

**Available Tools:**

- `FilterSessionRecordingsTool`: Filter session recordings by properties and events
- `SummarizeSessionsTool`: Summarize patterns across multiple sessions

**TODO Examples:**

- Show multi-step workflows for property discovery before filtering
- Demonstrate combining filtering with summarization

---

## SwitchModeTool

`SwitchModeTool` enables runtime mode switching with conversation context preservation.

**File:** `/ee/hogai/tools/switch_mode.py`

### Tool Description Prompt

```python
SWITCH_MODE_PROMPT = """
Use this tool to switch to a specialized mode with different tools and capabilities.
Your conversation history and context are preserved across mode switches.

# Common tools (available in all modes)
{{{default_tools}}}

# Specialized modes
{{{available_modes}}}

Decision framework:
1. Check if you already have the necessary tools in your current mode
2. If not, identify which mode provides the tools you need
3. Switch to that mode using this tool

Switch when:
- You need a tool listed in another mode's toolkit (e.g., execute_sql is only in sql mode)
- The task type clearly maps to a specialized mode (SQL queries → sql mode, trend analysis → product_analytics mode)
- You've confirmed your current mode lacks required capabilities

Do NOT switch when:
- You can complete the task with your current tools
- The task is informational/explanatory (no tools needed)
- You're uncertain–check your current tools first

After switching, you'll have access to that mode's specialized tools while retaining access to all common tools.
""".strip()
```

### Implementation

```python
from typing import Literal, Self, cast
from langchain_core.runnables import RunnableConfig
from pydantic import BaseModel, Field, create_model
from posthog.schema import AgentMode
from posthog.models import Team, User
from ee.hogai.context import AssistantContextManager
from ee.hogai.tool import MaxTool
from ee.hogai.utils.types.base import AssistantState


SWITCH_MODE_TOOL_NAME: Literal["switch_mode"] = "switch_mode"


class SwitchModeTool(MaxTool):
    name: Literal["switch_mode"] = SWITCH_MODE_TOOL_NAME
    _mode_registry: dict[AgentMode, "AgentModeDefinition"]

    async def _arun_impl(self, new_mode: str) -> tuple[str, AgentMode | None]:
        if new_mode not in self._mode_registry:
            available = ", ".join(self._mode_registry.keys())
            return (
                f"Failed to switch to {new_mode} mode. Available modes: {available}.",
                self._state.agent_mode,
            )

        return f"Successfully switched to {new_mode} mode. You now have access to this mode's specialized tools.", cast(AgentMode, new_mode)

    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        mode_registry: dict[AgentMode, "AgentModeDefinition"],
        default_tool_classes: list[type["MaxTool"]],
        state: AssistantState | None = None,
        config: RunnableConfig | None = None,
        context_manager: AssistantContextManager | None = None,
    ) -> Self:
        # Generate description with mode information
        context_manager = AssistantContextManager(team, user, config)
        default_tools, available_modes = await asyncio.gather(
            _get_default_tools_prompt(
                team=team, user=user, state=state, config=config,
                default_tool_classes=default_tool_classes
            ),
            _get_modes_prompt(
                team=team, user=user, state=state, config=config,
                context_manager=context_manager, mode_registry=mode_registry,
            ),
        )

        description_prompt = format_prompt_string(
            SWITCH_MODE_PROMPT,
            default_tools=default_tools,
            available_modes=available_modes
        )

        cls._mode_registry = mode_registry

        # Create dynamic Pydantic schema with mode enum
        ModeKind = Literal[*mode_registry.keys()]  # type: ignore
        args_schema = create_model(
            "SwitchModeToolArgs",
            __base__=BaseModel,
            new_mode=(ModeKind, Field(description="The name of the mode to switch to.")),
        )

        return cls(
            team=team,
            user=user,
            state=state,
            config=config,
            description=description_prompt,
            args_schema=args_schema,
        )
```

### Key Behaviors

**Dynamic Schema Generation:**

- Uses `create_model()` to create Pydantic schema with `Literal` type of available modes
- Ensures LLM can only call tool with valid mode names
- Type-safe at runtime

**Description Generation:**

- `_get_default_tools_prompt()`: Lists common tools available in all modes
- `_get_modes_prompt()`: Lists specialized modes with their descriptions and tools
- Formatted as mustache template with mode registry information

**Mode Registry Injection:**

- Mode registry is passed to `create_tool_class()`
- Stored as class variable for use in `_arun_impl()`
- Enables validation and mode switching logic

**State Update:**

- Tool returns tuple: `(message, new_mode)`
- `AgentExecutable._get_updated_agent_mode()` detects this and updates state
- Mode manager's setter invalidates cached nodes

---

## Implementation Guide

### Step 1: Define Mode Toolkit

Create a toolkit class extending `AgentToolkit`:

```python
from ee.hogai.core.agent_modes.toolkit import AgentToolkit
from ee.hogai.tools import YourCustomTool


class CustomModeToolkit(AgentToolkit):
    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [YourCustomTool]
```

**Optional: Add TODO Examples:**

```python
from ee.hogai.tools.todo_write import TodoWriteExample


class CustomModeToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example="User: example query\nAssistant: example response",
            reasoning="Why this is a good example",
        ),
    ]

    NEGATIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example="User: example query\nAssistant: bad response",
            reasoning="Why this is a bad example",
        ),
    ]

    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [YourCustomTool]
```

### Step 2: Create Mode Definition

Create an `AgentModeDefinition` instance:

```python
from posthog.schema import AgentMode
from ee.hogai.core.agent_modes.factory import AgentModeDefinition


custom_mode = AgentModeDefinition(
    mode=AgentMode.YOUR_MODE,  # Add to AgentMode enum first
    mode_description="Brief description of what this mode does and when to use it.",
    toolkit_class=CustomModeToolkit,
    # Optional: Override node classes if needed
    # node_class=CustomAgentExecutable,
    # tools_node_class=CustomAgentToolsExecutable,
)
```

### Step 3: Register Mode in Mode Manager

Add to your mode manager's `mode_registry`:

```python
from ee.hogai.core.agent_modes.mode_manager import AgentModeManager


class YourAgentModeManager(AgentModeManager):
    @property
    def mode_registry(self) -> dict[AgentMode, AgentModeDefinition]:
        return {
            AgentMode.PRODUCT_ANALYTICS: product_analytics_agent,
            AgentMode.SQL: sql_agent,
            AgentMode.SESSION_REPLAY: session_replay_agent,
            AgentMode.YOUR_MODE: custom_mode,  # Add your mode here
        }
```

### Step 4: Add Mode to Enum (if new)

If adding a completely new mode, update `posthog.schema.AgentMode`:

```python
# In posthog/schema.py or wherever AgentMode is defined
from enum import Enum


class AgentMode(str, Enum):
    PRODUCT_ANALYTICS = "product_analytics"
    SQL = "sql"
    SESSION_REPLAY = "session_replay"
    YOUR_MODE = "your_mode"  # Add your mode
```

### Step 5: Use Mode Manager in Graph

```python
from ee.hogai.chat_agent.mode_manager import ChatAgentModeManager


# Initialize mode manager
mode_manager = ChatAgentModeManager(
    team=team,
    user=user,
    node_path=node_path,
    context_manager=context_manager,
    mode=initial_mode,  # Optional, defaults to PRODUCT_ANALYTICS
)

# Use in langgraph nodes
async def agent_node(state: AssistantState, config: RunnableConfig):
    return await mode_manager.node.arun(state, config)

async def tools_node(state: AssistantState, config: RunnableConfig):
    return await mode_manager.tools_node.arun(state, config)
```

---

## Complete Example

Here's a complete example implementing a new "Data Warehouse" mode:

### 1. Define Tools

```python
# ee/hogai/tools/data_warehouse/query_warehouse.py
from ee.hogai.tool import MaxTool


class QueryWarehouseTool(MaxTool):
    name = "query_warehouse"

    async def _arun_impl(self, table_name: str, filters: dict) -> str:
        # Implementation
        return "Query results..."
```

### 2. Create Toolkit

```python
# ee/hogai/core/agent_modes/presets/data_warehouse.py
from posthog.schema import AgentMode
from ee.hogai.tools.data_warehouse.query_warehouse import QueryWarehouseTool
from ee.hogai.tools.todo_write import TodoWriteExample
from ..factory import AgentModeDefinition
from ..toolkit import AgentToolkit


POSITIVE_EXAMPLE = """
User: Show me all customers from the CRM who signed up last month
Assistant: I'll query your data warehouse to find that information.
*Creates todo list with the following items:*
1. Discover available data warehouse tables
2. Find the CRM table schema
3. Query the table with appropriate filters
4. Format and present the results
""".strip()


class DataWarehouseToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example=POSITIVE_EXAMPLE,
            reasoning="Data warehouse queries require discovering tables and schemas first",
        ),
    ]

    @property
    def tools(self) -> list[type["MaxTool"]]:
        return [QueryWarehouseTool]


data_warehouse_agent = AgentModeDefinition(
    mode=AgentMode.DATA_WAREHOUSE,
    mode_description="Specialized mode for querying external data warehouse tables like CRMs and SQL databases.",
    toolkit_class=DataWarehouseToolkit,
)
```

### 3. Update Mode Manager

```python
# ee/hogai/chat_agent/mode_manager.py
from ee.hogai.core.agent_modes.presets.data_warehouse import data_warehouse_agent


class ChatAgentModeManager(AgentModeManager):
    @property
    def mode_registry(self) -> dict[AgentMode, AgentModeDefinition]:
        return {
            AgentMode.PRODUCT_ANALYTICS: product_analytics_agent,
            AgentMode.SQL: sql_agent,
            AgentMode.SESSION_REPLAY: session_replay_agent,
            AgentMode.DATA_WAREHOUSE: data_warehouse_agent,  # New mode
        }
```

### 4. Usage

```python
# The agent will now automatically have access to the new mode
# Users can ask: "Switch to data warehouse mode and show me CRM customers"
# The LLM will call: switch_mode(new_mode="data_warehouse")
# Then: query_warehouse(table_name="crm_customers", filters={...})
```

---

## Architecture Diagrams

### Mode Switching Flow

```
User: "Switch to SQL mode and query revenue by country"
    ↓
AgentExecutable.arun()
    ↓
LLM generates: switch_mode(new_mode="sql")
    ↓
AgentToolsExecutable.arun()
    ↓
SwitchModeTool._arun_impl() → returns ("Success", AgentMode.SQL)
    ↓
AgentExecutable._get_updated_agent_mode() detects mode change
    ↓
State update: agent_mode = AgentMode.SQL
    ↓
AgentModeManager.mode setter → invalidates _node and _tools_node
    ↓
Next iteration: AgentModeManager.node property creates new node with SQL toolkit
    ↓
AgentExecutable.arun() with SQLAgentToolkit
    ↓
LLM now has access to ExecuteSQLTool
    ↓
LLM generates: execute_sql(query="SELECT country, SUM(revenue) ...")
    ↓
AgentToolsExecutable executes ExecuteSQLTool
    ↓
Results returned to user
```

### Tool Assembly Flow

```
AgentToolkitManager.get_tools()
    ↓
Iterate: [agent_toolkit, mode_toolkit]
    ↓
For each toolkit:
    │
    ├─ Instantiate toolkit class
    │   ├─ ChatAgentToolkit(team, user, context_manager)
    │   └─ SQLAgentToolkit(team, user, context_manager)
    │
    ├─ Get tools from toolkit.tools property
    │   ├─ ChatAgentToolkit.tools → [ReadTaxonomyTool, SearchTool, TodoWriteTool, SwitchModeTool]
    │   └─ SQLAgentToolkit.tools → [ExecuteSQLTool]
    │
    ├─ Accumulate TODO examples
    │   ├─ ChatAgentToolkit.POSITIVE_TODO_EXAMPLES → []
    │   └─ SQLAgentToolkit.POSITIVE_TODO_EXAMPLES → [example1, example2, ...]
    │
    └─ Create tool instances
        ├─ Regular tools: tool_class.create_tool_class(team, user, state, config, context_manager)
        ├─ TodoWriteTool: inject accumulated examples
        └─ SwitchModeTool: inject mode_registry and default_tool_classes
    ↓
asyncio.gather(*all_tool_futures)
    ↓
Return: [ReadTaxonomyTool(), SearchTool(), TodoWriteTool(examples=...), SwitchModeTool(modes=...), ExecuteSQLTool()]
```

---

## Key Design Patterns

### 1. Factory Pattern (Mode Definitions)

`AgentModeDefinition` acts as a factory configuration:

```python
# Definition = configuration
sql_agent = AgentModeDefinition(
    mode=AgentMode.SQL,
    toolkit_class=SQLAgentToolkit,
    node_class=AgentExecutable,
)

# Factory uses definition to create instances
node = sql_agent.node_class(team, user, ...)
toolkit = sql_agent.toolkit_class(team, user, ...)
```

### 2. Lazy Initialization (Mode Manager)

Nodes are created on first access, not in constructor:

```python
@property
def node(self) -> "AgentExecutable":
    if not self._node:
        # Create and cache
        self._node = self.mode_registry[self._mode].node_class(...)
    return self._node
```

### 3. Class-Level Configuration (Toolkit Manager)

Configuration is set on the class, not instance:

```python
@classmethod
def configure(cls, agent_toolkit, mode_toolkit, mode_registry):
    cls._agent_toolkit = agent_toolkit
    cls._mode_toolkit = mode_toolkit
    cls._mode_registry = mode_registry
```

This allows toolkit manager to be instantiated in multiple places while sharing configuration.

### 4. Dynamic Schema Generation (Switch Mode Tool)

Tool schema is generated dynamically based on available modes:

```python
ModeKind = Literal[*mode_registry.keys()]  # Literal["product_analytics", "sql", "session_replay"]
args_schema = create_model(
    "SwitchModeToolArgs",
    new_mode=(ModeKind, Field(...)),
)
```

### 5. Parallel Execution (Tools Node)

Uses langgraph's `Send` for parallel tool execution:

```python
def router(self, state: AssistantState):
    return [
        Send(AssistantNodeName.ROOT_TOOLS, state.model_copy(update={"root_tool_call_id": tc.id}))
        for tc in last_message.tool_calls
    ]
```

---

## Testing Modes

### Unit Testing a Toolkit

```python
import pytest
from ee.hogai.core.agent_modes.presets.sql import SQLAgentToolkit
from ee.hogai.tools import ExecuteSQLTool


@pytest.mark.asyncio
async def test_sql_toolkit_tools():
    toolkit = SQLAgentToolkit(team=team, user=user, context_manager=context_manager)

    assert ExecuteSQLTool in toolkit.tools
    assert len(toolkit.POSITIVE_TODO_EXAMPLES) > 0
```

### Integration Testing Mode Switching

```python
import pytest
from ee.hogai.chat_agent.mode_manager import ChatAgentModeManager
from posthog.schema import AgentMode


@pytest.mark.asyncio
async def test_mode_switching():
    mode_manager = ChatAgentModeManager(
        team=team,
        user=user,
        node_path=(),
        context_manager=context_manager,
        mode=AgentMode.PRODUCT_ANALYTICS,
    )

    # Get initial node
    node1 = mode_manager.node

    # Switch mode
    mode_manager.mode = AgentMode.SQL

    # Verify cache was invalidated
    node2 = mode_manager.node
    assert node1 is not node2

    # Verify new toolkit is used
    toolkit_manager = mode_manager.toolkit_manager_class(
        team=team, user=user, context_manager=context_manager
    )
    tools = await toolkit_manager.get_tools(state, config)

    tool_names = [tool.get_name() for tool in tools]
    assert "execute_sql" in tool_names
```

### E2E Testing with LLM

```python
@pytest.mark.asyncio
async def test_e2e_mode_switching():
    # Initialize graph with mode manager
    graph = create_graph_with_mode_manager()

    # Send user message requesting mode switch
    state = AssistantState(messages=[
        HumanMessage(content="Switch to SQL mode and query revenue")
    ])

    # Run graph
    result = await graph.ainvoke(state, config)

    # Verify mode was switched
    assert result.agent_mode == AgentMode.SQL

    # Verify SQL tool was called
    tool_messages = [m for m in result.messages if isinstance(m, AssistantToolCallMessage)]
    assert any(m.tool_call_id for m in tool_messages if "execute_sql" in str(m))
```

---

## Best Practices

### 1. Mode Descriptions

Keep mode descriptions concise and focused on:

- **What** the mode does
- **When** to use it
- **Which tools** it provides

```python
# Good
mode_description="Specialized mode for SQL queries. Use when you need to query ClickHouse database or data warehouse tables. Provides execute_sql tool."

# Bad (too verbose)
mode_description="This is a specialized mode that you can use when you want to generate and execute SQL queries against the ClickHouse database which contains events, persons, groups, and also data warehouse sources..."
```

### 2. TODO Examples

Provide examples showing:

- **Multi-step workflows** (when to use TodoWriteTool)
- **Tool orchestration** patterns (which tools to use in which order)
- **Edge cases** (how to handle errors, missing data)

```python
POSITIVE_TODO_EXAMPLES = [
    TodoWriteExample(
        example="<show actual conversation>",
        reasoning="<explain why this is correct>",
    ),
]

NEGATIVE_TODO_EXAMPLES = [
    TodoWriteExample(
        example="<show bad conversation>",
        reasoning="<explain why this is wrong>",
    ),
]
```

### 3. Tool Naming

Use consistent, descriptive tool names:

```python
# Good
execute_sql
filter_session_recordings
create_insight

# Bad
sql  # Too vague
filter  # Too generic
make_chart  # Ambiguous
```

### 4. Mode Granularity

Create modes for:

- **Distinct tool sets** (different capabilities)
- **Different domains** (product analytics vs session replay)
- **Performance isolation** (expensive tools in separate modes)

Avoid creating modes for:

- **Minor tool variations** (use feature flags instead)
- **User preferences** (use configuration instead)
- **Temporary experiments** (use contextual tools instead)

### 5. Cache Invalidation

Always invalidate cached nodes when mode changes:

```python
@mode.setter
def mode(self, value: AgentMode):
    self._mode = value
    self._node = None  # Invalidate LLM node
    self._tools_node = None  # Invalidate tools node
```

### 6. Error Handling

Handle mode switching errors gracefully:

```python
async def _arun_impl(self, new_mode: str) -> tuple[str, AgentMode | None]:
    if new_mode not in self._mode_registry:
        available = ", ".join(self._mode_registry.keys())
        return (
            f"Mode '{new_mode}' does not exist. Available: {available}",
            self._state.agent_mode,  # Keep current mode
        )
    # ...
```

---

## Troubleshooting

### Issue: Tools not appearing after mode switch

**Cause:** Cached nodes not invalidated

**Solution:** Ensure mode setter clears `_node` and `_tools_node`:

```python
@mode.setter
def mode(self, value: AgentMode):
    self._mode = value
    self._node = None
    self._tools_node = None
```

### Issue: TodoWriteTool examples not showing up

**Cause:** Examples defined in mode toolkit instead of agent toolkit

**Solution:** Move `POSITIVE_TODO_EXAMPLES` to agent toolkit:

```python
# Wrong - mode toolkit
class SQLAgentToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [...]  # Will raise error

# Right - agent toolkit
class ChatAgentToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [...]
```

### Issue: SwitchModeTool not available

**Cause:** Tool not in agent toolkit or feature flag disabled

**Solution:** Add to agent toolkit and check feature flag:

```python
class ChatAgentToolkit(AgentToolkit):
    @property
    def tools(self) -> list[type["MaxTool"]]:
        tools = [ReadTaxonomyTool, SearchTool, TodoWriteTool]
        if has_agent_modes_feature_flag(self._team, self._user):
            tools.append(SwitchModeTool)  # Add switch mode tool
        return tools
```

### Issue: Mode registry not found

**Cause:** `mode_registry` property not implemented in mode manager

**Solution:** Implement abstract property:

```python
class YourModeManager(AgentModeManager):
    @property
    def mode_registry(self) -> dict[AgentMode, AgentModeDefinition]:
        return {
            AgentMode.PRODUCT_ANALYTICS: product_analytics_agent,
            # ... other modes
        }
```

---

## Summary

The HogAI Agent Modes System provides a powerful, flexible architecture for specialized agent capabilities:

**Core Components:**

1. **AgentModeDefinition**: Configuration dataclass for modes
2. **AgentModeManager**: Mode lifecycle and node management
3. **AgentToolkit**: Tool collection definitions
4. **AgentToolkitManager**: Dynamic tool assembly
5. **AgentExecutable**: LLM invocation node
6. **AgentToolsExecutable**: Tool execution node
7. **SwitchModeTool**: Runtime mode switching

**Key Features:**

- Lazy node instantiation with caching
- Dynamic tool assembly from multiple toolkits
- Runtime mode switching with cache invalidation
- TODO example injection for task orchestration
- Parallel tool execution via langgraph

**Design Patterns:**

- Factory pattern for mode definitions
- Lazy initialization for nodes
- Class-level configuration for toolkit managers
- Dynamic schema generation for mode switching

This architecture enables PostHog's AI assistant to seamlessly switch between different specialized modes while maintaining conversation context and providing optimal tools for each task domain.
