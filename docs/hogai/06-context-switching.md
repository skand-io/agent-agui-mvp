# PostHog HogAI Context Switching Mechanism

This document provides a comprehensive guide to the context switching mechanism in PostHog's HogAI agent system. The context switching mechanism allows the agent to dynamically switch between specialized modes (e.g., `product_analytics`, `sql`, `web_analytics`) while preserving conversation context and state.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [SwitchModeTool](#switchmodetool)
4. [Mode Change Detection](#mode-change-detection)
5. [State Propagation](#state-propagation)
6. [Compaction Manager](#compaction-manager)
7. [UI Context Preservation](#ui-context-preservation)
8. [Complete Implementation Example](#complete-implementation-example)

---

## Overview

The context switching mechanism consists of five key components:

1. **SwitchModeTool** - A tool that agents can call to switch modes
2. **Mode Change Detection** - Logic in `AgentExecutable` that detects mode switches
3. **State Propagation** - The `agent_mode` field in state that flows through the graph
4. **Compaction Manager** - Handles mode reminders after conversation summarization
5. **AssistantContextManager** - Manages context preservation across mode switches

When an agent switches modes:
- The conversation history is preserved
- The new mode's specialized tools become available
- Common tools remain available across all modes
- Context messages inform the agent of the mode change

---

## Architecture

### Mode Registry

The system uses a mode registry (`dict[AgentMode, AgentModeDefinition]`) that maps mode names to their definitions:

```python
from dataclasses import dataclass
from posthog.schema import AgentMode

@dataclass
class AgentModeDefinition:
    mode: AgentMode
    """The name of the agent's mode."""

    mode_description: str
    """The description of the agent's mode that will be injected into the tool."""

    toolkit_class: type[AgentToolkit] = AgentToolkit
    """A custom toolkit class to use for the agent."""

    node_class: type[AgentExecutable] = AgentExecutable
    """A custom node class to use for the agent."""

    tools_node_class: type[AgentToolsExecutable] = AgentToolsExecutable
    """A custom tools node class to use for the agent."""
```

Example mode registry:

```python
mode_registry = {
    AgentMode.PRODUCT_ANALYTICS: AgentModeDefinition(
        mode=AgentMode.PRODUCT_ANALYTICS,
        mode_description="General product analytics with trend/funnel/retention analysis",
        toolkit_class=ProductAnalyticsToolkit,
    ),
    AgentMode.SQL: AgentModeDefinition(
        mode=AgentMode.SQL,
        mode_description="Execute SQL queries against the database",
        toolkit_class=SqlToolkit,
    ),
    AgentMode.WEB_ANALYTICS: AgentModeDefinition(
        mode=AgentMode.WEB_ANALYTICS,
        mode_description="Web analytics for traffic and conversion analysis",
        toolkit_class=WebAnalyticsToolkit,
    ),
}
```

### State Structure

The agent state includes an `agent_mode` field:

```python
from posthog.schema import AgentMode
from pydantic import BaseModel, Field

class BaseStateWithMessages(BaseState):
    agent_mode: AgentMode | None = Field(default=None)
    """The mode of the agent."""

    @property
    def agent_mode_or_default(self) -> AgentMode:
        return self.agent_mode or AgentMode.PRODUCT_ANALYTICS
```

---

## SwitchModeTool

The `SwitchModeTool` is the mechanism agents use to switch between modes.

### Dynamic Literal Type Generation

The tool uses Pydantic's `create_model()` to generate a dynamic `Literal` type from the mode registry:

```python
from typing import Literal
from pydantic import BaseModel, Field, create_model

class SwitchModeTool(MaxTool):
    name: Literal["switch_mode"] = "switch_mode"
    _mode_registry: dict[AgentMode, "AgentModeDefinition"]

    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        mode_registry: dict[AgentMode, "AgentModeDefinition"] | None = None,
        default_tool_classes: list[type["MaxTool"]] | None = None,
        state: AssistantState | None = None,
        config: RunnableConfig | None = None,
        context_manager: AssistantContextManager | None = None,
    ) -> Self:
        if mode_registry is None or default_tool_classes is None:
            raise ValueError("SwitchModeTool requires mode_registry and default_tool_classes")

        # Build the description prompt with available modes
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

        # Store the registry as a class variable
        cls._mode_registry = mode_registry

        # Create dynamic Literal type from mode registry keys
        ModeKind = Literal[*mode_registry.keys()]  # type: ignore

        # Generate args schema with the dynamic Literal
        args_schema = create_model(
            "SwitchModeToolArgs",
            __base__=BaseModel,
            new_mode=(
                ModeKind,
                Field(description="The name of the mode to switch to."),
            ),
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

**Key Implementation Details:**

1. **Dynamic Literal Type**: `Literal[*mode_registry.keys()]` creates a type that only accepts valid mode names
2. **Schema Generation**: `create_model()` generates a Pydantic model with proper validation
3. **Class Variable**: `_mode_registry` is stored as a class variable for access in `_arun_impl`

### Tool Execution

The tool returns both a message and the new mode:

```python
async def _arun_impl(self, new_mode: str) -> tuple[str, AgentMode | None]:
    # Validate the mode exists
    if new_mode not in self._mode_registry:
        available = ", ".join(self._mode_registry.keys())
        return (
            format_prompt_string(
                SWITCH_MODE_FAILURE_PROMPT,
                new_mode=new_mode,
                available_modes=available
            ),
            self._state.agent_mode,  # Return current mode on failure
        )

    # Return success message and new mode
    return (
        format_prompt_string(SWITCH_MODE_TOOL_PROMPT, new_mode=new_mode),
        cast(AgentMode, new_mode)
    )
```

**Return Value**: A tuple of `(message: str, new_mode: AgentMode | None)`
- The message is shown to the agent
- The new mode is extracted by the mode detection logic

### Mode Prompt Generation

The tool generates a description of available modes by inspecting each mode's toolkit:

```python
async def _get_modes_prompt(
    *,
    team: Team,
    user: User,
    state: AssistantState | None = None,
    config: RunnableConfig | None = None,
    context_manager: AssistantContextManager,
    mode_registry: dict[AgentMode, "AgentModeDefinition"],
) -> str:
    """Get the prompt containing the description of the available modes."""

    # Create tasks to get tools for each mode
    all_futures: list[asyncio.Future[list[MaxTool]]] = []
    for definition in mode_registry.values():
        all_futures.append(
            asyncio.gather(
                *[
                    tool_class.create_tool_class(team=team, user=user, state=state, config=config)
                    for tool_class in definition.toolkit_class(
                        team=team, user=user, context_manager=context_manager
                    ).tools
                ]
            )
        )

    # Resolve all tools in parallel
    resolved_tools = await asyncio.gather(*all_futures)

    # Format mode descriptions with their tools
    formatted_modes: list[str] = []
    for definition, tools in zip(mode_registry.values(), resolved_tools):
        formatted_modes.append(
            f"- {definition.mode.value} – {definition.mode_description}. "
            f"[Mode tools: {', '.join([tool.get_name() for tool in tools])}]"
        )

    return "\n".join(formatted_modes)
```

**Example Output:**
```
- product_analytics – General product analytics with trend/funnel/retention analysis. [Mode tools: create_trends, create_funnel, create_retention]
- sql – Execute SQL queries against the database. [Mode tools: execute_sql, validate_sql]
- web_analytics – Web analytics for traffic and conversion analysis. [Mode tools: get_traffic, get_conversions]
```

---

## Mode Change Detection

The `AgentExecutable` class detects mode changes by scanning tool calls for `switch_mode`:

```python
class AgentExecutable(BaseAgentLoopRootExecutable):
    async def arun(self, state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
        # ... model invocation and message processing ...

        message = await model.ainvoke(system_prompts + langchain_messages, config)
        assistant_message = self._process_output_message(message)

        # Detect mode changes
        updated_mode = self._get_updated_agent_mode(
            assistant_message,
            state.agent_mode_or_default
        )

        return PartialAssistantState(
            messages=new_messages,
            agent_mode=updated_mode,  # Propagate the new mode
            # ... other state fields ...
        )

    def _get_updated_agent_mode(
        self,
        generated_message: AssistantMessage,
        current_mode: AgentMode
    ) -> AgentMode | None:
        """Scan tool calls for switch_mode and extract the new mode."""
        from ee.hogai.tools.switch_mode import SWITCH_MODE_TOOL_NAME

        for tool_call in generated_message.tool_calls or []:
            if tool_call.name == SWITCH_MODE_TOOL_NAME:
                if new_mode := tool_call.args.get("new_mode"):
                    return new_mode

        return current_mode
```

**Key Implementation Details:**

1. **Tool Call Scanning**: Iterates through all tool calls in the generated message
2. **Name Matching**: Checks if `tool_call.name == "switch_mode"`
3. **Argument Extraction**: Extracts `new_mode` from the tool call arguments
4. **Fallback**: Returns current mode if no switch_mode call is found

**Example Tool Call:**
```json
{
  "name": "switch_mode",
  "args": {
    "new_mode": "sql"
  },
  "id": "call_abc123"
}
```

---

## State Propagation

The `agent_mode` field flows through the graph using LangGraph's state management:

### State Definition

```python
class _SharedAssistantState(BaseStateWithMessages, BaseStateWithIntermediateSteps):
    """The state of the root node."""
    # ... other fields ...

class AssistantState(_SharedAssistantState):
    messages: Annotated[Sequence[AssistantMessageUnion], add_and_merge_messages] = Field(default=[])
    # agent_mode inherited from BaseStateWithMessages

class PartialAssistantState(_SharedAssistantState):
    messages: ReplaceMessages[AssistantMessageUnion] | list[AssistantMessageUnion] = Field(default=[])
    # agent_mode inherited from BaseStateWithMessages
```

### State Updates

Nodes return `PartialAssistantState` which merges with the existing state:

```python
# In AgentExecutable.arun()
return PartialAssistantState(
    messages=new_messages,
    agent_mode=updated_mode,  # This updates the agent_mode field
    root_tool_calls_count=tool_call_count,
    # ... other fields ...
)
```

### Graph Flow

```
┌─────────────────┐
│  Initial State  │
│  agent_mode=PA  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AgentExecutable│
│  Detects switch │
│  Returns: SQL   │
└────────┬────────┘
         │
         ▼ (State Merge)
┌─────────────────┐
│  Updated State  │
│  agent_mode=SQL │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Next Iteration │
│  Uses SQL tools │
└─────────────────┘
```

### Mode Manager Integration

The `AgentModeManager` uses the state's `agent_mode` to configure nodes:

```python
class AgentModeManager(AssistantContextMixin, ABC):
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
    def node(self) -> "AgentExecutable":
        if not self._node:
            agent_definition = self.mode_registry[self._mode]

            # Configure the toolkit manager with the current mode
            toolkit_manager_class = self.toolkit_manager_class
            toolkit_manager_class.configure(
                agent_toolkit=self.toolkit_class,
                mode_toolkit=agent_definition.toolkit_class,
                mode_registry=self.mode_registry,
            )

            # Create the node with the configured toolkit
            self._node = agent_definition.node_class(
                team=self._team,
                user=self._user,
                node_path=self._node_path,
                toolkit_manager_class=toolkit_manager_class,
                prompt_builder_class=self.prompt_builder_class,
            )

        return self._node

    @property
    def mode(self) -> AgentMode:
        return self._mode

    @mode.setter
    def mode(self, value: AgentMode):
        """When mode changes, reset the cached nodes."""
        self._mode = value
        self._node = None
        self._tools_node = None
```

**Key Points:**
- Setting `mode` clears the cached `_node` and `_tools_node`
- Next access to `node` property creates a new node with the new mode's toolkit

---

## Compaction Manager

The `AnthropicConversationCompactionManager` handles mode reminders after conversation summarization.

### Problem Statement

When a conversation exceeds the token limit:
1. The conversation is summarized
2. The summary is inserted into the message window
3. The agent may lose context about which mode it's in

**Solution**: Insert a mode reminder message after the summary.

### Mode Reminder Logic

```python
class ConversationCompactionManager(ABC):
    CONVERSATION_WINDOW_SIZE = 100_000
    """Maximum number of tokens allowed in the conversation window."""

    def update_window(
        self,
        messages: Sequence[T],
        summary_message: ContextMessage,
        agent_mode: AgentMode,
        start_id: str | None = None,
        is_modes_feature_flag_enabled: bool = False,
    ) -> InsertionResult:
        """Finds the optimal position to insert the summary message."""

        window_start_id_candidate = self.find_window_boundary(messages, max_messages=16, max_tokens=2048)
        start_message = find_start_message(messages, start_id)

        if not start_message:
            raise ValueError("Start message not found")

        start_message_copy = start_message.model_copy(deep=True)
        start_message_copy.id = str(uuid4())

        # Handle different window boundary scenarios
        if not window_start_id_candidate:
            return self._handle_no_window_boundary(
                messages, summary_message, start_message_copy, agent_mode,
                is_modes_feature_flag_enabled
            )

        start_message_idx = find_start_message_idx(messages, window_start_id_candidate)
        new_window = messages[start_message_idx:]

        if start_id and next((m for m in new_window if m.id == start_id), None):
            return self._handle_start_in_window(
                messages, summary_message, start_id, window_start_id_candidate,
                agent_mode, is_modes_feature_flag_enabled,
            )

        return self._handle_start_outside_window(
            new_window, summary_message, start_message_copy, window_start_id_candidate,
            agent_mode, is_modes_feature_flag_enabled,
        )
```

### Mode Message Generation

```python
def _get_mode_message(
    self,
    updated_messages: Sequence[AssistantMessageUnion],
    agent_mode: AgentMode
) -> ContextMessage | None:
    """Generate a mode reminder message if needed."""
    if not self._should_add_mode_reminder(updated_messages):
        return None

    return ContextMessage(
        content=ROOT_AGENT_MODE_REMINDER_PROMPT.format(mode=agent_mode.value),
        id=str(uuid4()),
    )

def _should_add_mode_reminder(self, messages: Sequence[AssistantMessageUnion]) -> bool:
    """
    Determine if a mode reminder should be added.
    Returns True if:
    - agent_mode is set
    - mode is not evident in the messages (no switch_mode call)
    - initial mode message is not present
    """
    if self._has_initial_mode_message(messages):
        return False
    if self._is_mode_evident_in_window(messages):
        return False
    return True

def _is_mode_evident_in_window(self, messages: Sequence[AssistantMessageUnion]) -> bool:
    """Check if the mode is evident from a switch_mode tool call."""
    for message in messages:
        if isinstance(message, AssistantMessage) and message.tool_calls:
            for tool_call in message.tool_calls:
                if tool_call.name == SWITCH_MODE_TOOL_NAME:
                    return True
    return False

def _has_initial_mode_message(self, messages: Sequence[AssistantMessageUnion]) -> bool:
    """Check if the initial mode message is present."""
    for message in messages:
        if isinstance(message, ContextMessage):
            if CONTEXT_INITIAL_MODE_PROMPT in message.content:
                return True
    return False
```

**Mode Reminder Prompt:**
```
<system_reminder>
You are currently in {mode} mode. This mode was enabled earlier in the conversation.
</system_reminder>
```

### Insertion Strategy

The mode reminder is inserted right after the summary message:

```python
def _insert_mode_reminder_after_summary(
    self,
    messages: Sequence[T],
    summary_id: str,
    agent_mode: AgentMode,
    is_modes_feature_flag_enabled: bool,
) -> Sequence[T]:
    """Insert mode reminder right after the summary message if needed."""
    if not is_modes_feature_flag_enabled:
        return messages

    context_message = self._get_mode_message(messages, agent_mode)
    if not context_message:
        return messages

    # Find the summary message
    summary_idx = next(i for i, msg in enumerate(messages) if msg.id == summary_id)

    # Insert mode reminder after summary
    return [
        *messages[:summary_idx + 1],
        context_message,
        *messages[summary_idx + 1:],
    ]
```

**Example Message Sequence:**
```
[Previous messages...]
ContextMessage(id="summary-123", content="Conversation summary: ...")
ContextMessage(id="mode-456", content="<system_reminder>You are currently in sql mode...</system_reminder>")
HumanMessage(id="start-789", content="Show me users...")
[Subsequent messages...]
```

---

## UI Context Preservation

The `AssistantContextManager` handles context preservation across mode switches.

### Context Message Injection

Context messages are injected at the start of each conversation turn:

```python
class AssistantContextManager(AssistantContextMixin):
    async def get_state_messages_with_context(
        self,
        state: BaseStateWithMessages
    ) -> Sequence[AssistantMessageUnion] | None:
        """Returns state messages with context messages injected."""
        if context_prompts := await self._get_context_messages(state):
            updated_messages = self._inject_context_messages(state, context_prompts)
            return updated_messages
        return None

    async def _get_context_messages(self, state: BaseStateWithMessages) -> list[ContextMessage]:
        """Build context messages including mode context."""
        are_modes_enabled = has_agent_modes_feature_flag(self._team, self._user)

        prompts: list[ContextMessage] = []

        # Add mode context message
        if are_modes_enabled:
            if mode_prompt := self._get_mode_context_messages(state):
                prompts.append(mode_prompt)

        # Add contextual tools prompt
        if contextual_tools := await self._get_contextual_tools_prompt():
            prompts.append(ContextMessage(content=contextual_tools, id=str(uuid4())))

        # Add UI context
        if ui_context := await self._format_ui_context(self.get_ui_context(state)):
            prompts.append(ContextMessage(content=ui_context, id=str(uuid4())))

        return self._deduplicate_context_messages(state, prompts)
```

### Mode Context Messages

```python
def _get_mode_context_messages(self, state: BaseStateWithMessages) -> ContextMessage | None:
    """
    Returns a mode ContextMessage if one should be injected.
    - On first turn: inject initial mode prompt
    - On subsequent turns: inject switch prompt if mode changed
    """
    current_mode = state.agent_mode_or_default
    is_first_message = find_start_message_idx(state.messages, state.start_id) == 0

    # First message: inject initial mode prompt
    if is_first_message:
        return self._create_mode_context_message(current_mode, is_initial=True)

    # Subsequent messages: check if mode changed
    previous_mode = self._get_previous_mode_from_messages(state.messages)
    if previous_mode and previous_mode != current_mode:
        return self._create_mode_context_message(current_mode, is_initial=False)

    return None

def _get_previous_mode_from_messages(
    self,
    messages: Sequence[AssistantMessageUnion]
) -> AgentMode | None:
    """
    Extracts the most recent mode from existing messages.
    Checks ContextMessages metadata and AssistantMessages for switch_mode calls.
    """
    from ee.hogai.tools.switch_mode import SWITCH_MODE_TOOL_NAME

    for message in reversed(messages):
        # Check for switch_mode tool calls
        if isinstance(message, AssistantMessage) and message.tool_calls:
            for tool_call in message.tool_calls:
                if tool_call.name == SWITCH_MODE_TOOL_NAME:
                    new_mode = tool_call.args.get("new_mode")
                    if new_mode and new_mode in AgentMode.__members__.values():
                        return AgentMode(new_mode)

        # Check for mode context messages
        if isinstance(message, ContextMessage) and isinstance(message.meta, ModeContext):
            return message.meta.mode

    return None

def _create_mode_context_message(
    self,
    mode: AgentMode,
    *,
    is_initial: bool
) -> ContextMessage:
    """Create a mode context message."""
    mode_prompt = CONTEXT_INITIAL_MODE_PROMPT if is_initial else CONTEXT_MODE_SWITCH_PROMPT

    content = format_prompt_string(
        CONTEXT_MODE_PROMPT,
        mode_prompt=mode_prompt,
        mode=mode.value,
    )

    return ContextMessage(
        content=content,
        id=str(uuid4()),
        meta=ModeContext(mode=mode),
    )
```

**Example Context Messages:**

Initial mode:
```
<system_reminder>Your initial mode is product_analytics.</system_reminder>
```

Mode switch:
```
<system_reminder>Your mode has been switched to sql.</system_reminder>
```

### Message Injection Strategy

Context messages are inserted before the start message:

```python
def _inject_context_messages(
    self,
    state: BaseStateWithMessages,
    context_messages: list[ContextMessage]
) -> list[AssistantMessageUnion]:
    """Insert context messages right before the start message."""
    return insert_messages_before_start(
        state.messages,
        context_messages,
        start_id=state.start_id
    )
```

**Example Message Flow:**

Before injection:
```
[message_1, message_2, HumanMessage(id="start", content="..."), message_3]
```

After injection:
```
[message_1, message_2,
 ContextMessage(id="ctx-1", content="<system_reminder>Your mode has been switched to sql.</system_reminder>"),
 HumanMessage(id="start", content="..."),
 message_3]
```

---

## Complete Implementation Example

Here's a complete example implementing the context switching mechanism:

### Step 1: Define Mode Registry

```python
from posthog.schema import AgentMode
from ee.hogai.core.agent_modes.factory import AgentModeDefinition
from ee.hogai.core.agent_modes.toolkit import AgentToolkit

# Define toolkits for each mode
class ProductAnalyticsToolkit(AgentToolkit):
    @property
    def tools(self) -> list[type[MaxTool]]:
        return [CreateTrendsTool, CreateFunnelTool, CreateRetentionTool]

class SqlToolkit(AgentToolkit):
    @property
    def tools(self) -> list[type[MaxTool]]:
        return [ExecuteSqlTool, ValidateSqlTool]

class WebAnalyticsToolkit(AgentToolkit):
    @property
    def tools(self) -> list[type[MaxTool]]:
        return [GetTrafficTool, GetConversionsTool]

# Create mode registry
MODE_REGISTRY = {
    AgentMode.PRODUCT_ANALYTICS: AgentModeDefinition(
        mode=AgentMode.PRODUCT_ANALYTICS,
        mode_description="General product analytics with trend/funnel/retention analysis",
        toolkit_class=ProductAnalyticsToolkit,
    ),
    AgentMode.SQL: AgentModeDefinition(
        mode=AgentMode.SQL,
        mode_description="Execute SQL queries against the database",
        toolkit_class=SqlToolkit,
    ),
    AgentMode.WEB_ANALYTICS: AgentModeDefinition(
        mode=AgentMode.WEB_ANALYTICS,
        mode_description="Web analytics for traffic and conversion analysis",
        toolkit_class=WebAnalyticsToolkit,
    ),
}
```

### Step 2: Configure Toolkit Manager

```python
from ee.hogai.core.agent_modes.toolkit import AgentToolkitManager

class MyAgentToolkitManager(AgentToolkitManager):
    @property
    def default_tools(self) -> list[type[MaxTool]]:
        """Tools available in all modes."""
        return [SwitchModeTool, SearchDocsTool, GetMetadataTool]

    async def get_tools(
        self,
        state: AssistantState,
        config: RunnableConfig
    ) -> list[MaxTool]:
        """Get tools for the current mode."""
        # Get common tools
        common_tools = await asyncio.gather(
            *[
                tool_class.create_tool_class(
                    team=self._team,
                    user=self._user,
                    state=state,
                    config=config,
                    mode_registry=self._mode_registry,
                    default_tool_classes=self.default_tools,
                )
                for tool_class in self.default_tools
            ]
        )

        # Get mode-specific tools
        mode_toolkit = self._mode_toolkit_class(
            team=self._team,
            user=self._user,
            context_manager=self._context_manager
        )
        mode_tools = await asyncio.gather(
            *[
                tool_class.create_tool_class(
                    team=self._team,
                    user=self._user,
                    state=state,
                    config=config,
                )
                for tool_class in mode_toolkit.tools
            ]
        )

        return [*common_tools, *mode_tools]
```

### Step 3: Create Agent Executable

```python
from ee.hogai.core.agent_modes.executables import AgentExecutable

class MyAgentExecutable(AgentExecutable):
    async def arun(
        self,
        state: AssistantState,
        config: RunnableConfig
    ) -> PartialAssistantState:
        # Get tools for current mode
        toolkit_manager = self._toolkit_manager_class(
            team=self._team,
            user=self._user,
            context_manager=self.context_manager
        )
        tools = await toolkit_manager.get_tools(state, config)

        # Bind tools to model
        model = self._get_model(state, tools)

        # Get system prompts
        prompt_builder = self._prompt_builder_class(
            team=self._team,
            user=self._user,
            context_manager=self.context_manager
        )
        system_prompts = await prompt_builder.get_prompts(state, config)

        # Add context messages on first turn
        messages_to_replace: Sequence[AssistantMessageUnion] = []
        if self._is_first_turn(state):
            if updated_messages := await self.context_manager.get_state_messages_with_context(state):
                messages_to_replace = updated_messages

        # Construct messages
        langchain_messages = self._construct_messages(
            messages_to_replace or state.messages,
            state.root_conversation_start_id,
            state.root_tool_calls_count
        )

        # Invoke model
        message = await model.ainvoke(system_prompts + langchain_messages, config)
        assistant_message = self._process_output_message(message)

        # Detect mode change
        updated_mode = self._get_updated_agent_mode(
            assistant_message,
            state.agent_mode_or_default
        )

        # Build response
        new_messages: list[AssistantMessageUnion] | ReplaceMessages[AssistantMessageUnion]
        new_messages = [assistant_message]
        if messages_to_replace:
            new_messages = ReplaceMessages([*messages_to_replace, assistant_message])

        return PartialAssistantState(
            messages=new_messages,
            agent_mode=updated_mode,  # Propagate mode change
        )
```

### Step 4: Build the Graph

```python
from langgraph.graph import StateGraph
from ee.hogai.utils.types import AssistantState, PartialAssistantState

def build_agent_graph(
    team: Team,
    user: User,
    mode_registry: dict[AgentMode, AgentModeDefinition],
):
    # Create graph
    builder = StateGraph(AssistantState, output=PartialAssistantState)

    # Create mode manager
    context_manager = AssistantContextManager(team, user)
    mode_manager = AgentModeManager(
        team=team,
        user=user,
        node_path=(NodePath(name="root"),),
        context_manager=context_manager,
        mode=AgentMode.PRODUCT_ANALYTICS,  # Initial mode
    )

    # Configure toolkit manager
    MyAgentToolkitManager.configure(
        agent_toolkit=AgentToolkit,
        mode_toolkit=mode_registry[mode_manager.mode].toolkit_class,
        mode_registry=mode_registry,
    )

    # Add nodes
    builder.add_node("root", mode_manager.node.arun)
    builder.add_node("root_tools", mode_manager.tools_node.arun)

    # Add edges
    builder.add_edge(START, "root")
    builder.add_conditional_edges("root", mode_manager.node.router)
    builder.add_conditional_edges("root_tools", mode_manager.tools_node.router)

    return builder.compile()
```

### Step 5: Execute with Mode Switching

```python
async def run_conversation():
    team = Team.objects.get(id=1)
    user = User.objects.get(id=1)

    # Build graph
    graph = build_agent_graph(team, user, MODE_REGISTRY)

    # Initial state
    state = AssistantState(
        messages=[
            HumanMessage(
                id=str(uuid4()),
                content="Show me a trends query for page views",
            )
        ],
        start_id=messages[0].id,
        agent_mode=AgentMode.PRODUCT_ANALYTICS,
    )

    # First turn: agent uses product analytics tools
    result = await graph.ainvoke(state)
    print(f"Mode: {result['agent_mode']}")  # product_analytics

    # Agent decides to switch modes
    state = result.copy()
    state.messages.append(
        HumanMessage(
            id=str(uuid4()),
            content="Actually, run a SQL query for the same data",
        )
    )

    # Second turn: agent switches to SQL mode
    result = await graph.ainvoke(state)
    print(f"Mode: {result['agent_mode']}")  # sql

    # The agent now has access to SQL tools
    # Context is preserved across the mode switch
```

### Example Conversation Flow

```
User: "Show me a trends query for page views"

[Agent in product_analytics mode]
Assistant: I'll create a trends query for you.
  Tool Call: create_trends(event="pageview", ...)

---

User: "Actually, run a SQL query for the same data"

[Agent detects need for SQL tools]
Assistant: I need to switch to SQL mode for this.
  Tool Call: switch_mode(new_mode="sql")

[Mode change detected, agent_mode updated to "sql"]
[Context message injected: "Your mode has been switched to sql"]
[Agent in sql mode, with execute_sql tool available]
Assistant: I'll execute a SQL query for you.
  Tool Call: execute_sql(query="SELECT COUNT(*) FROM events WHERE event = 'pageview'", ...)
```

**Key Points:**
1. Conversation context is fully preserved across mode switches
2. The agent seamlessly transitions from product analytics tools to SQL tools
3. Context messages inform the agent of mode changes
4. The mode field flows through the graph state automatically

---

## Summary

The PostHog HogAI context switching mechanism provides:

1. **Dynamic Mode Switching** - Agents can switch between specialized modes using the `switch_mode` tool
2. **Type Safety** - Dynamic Literal types ensure only valid modes can be selected
3. **Context Preservation** - Full conversation history and UI context are preserved across switches
4. **State Propagation** - The `agent_mode` field flows through the LangGraph state automatically
5. **Mode Awareness** - Context messages and mode reminders keep the agent aware of its current mode
6. **Tool Isolation** - Each mode has its own specialized toolkit while sharing common tools

### Key Files

- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/tools/switch_mode.py` - SwitchModeTool implementation
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/core/agent_modes/executables.py` - Mode detection logic
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/core/agent_modes/compaction_manager.py` - Mode reminder logic
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/context/context.py` - Context preservation logic
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/core/agent_modes/factory.py` - Mode registry structure

### Implementation Checklist

When implementing context switching in a new system:

- [ ] Define `AgentMode` enum with all available modes
- [ ] Create `AgentModeDefinition` for each mode with toolkit and description
- [ ] Build mode registry (`dict[AgentMode, AgentModeDefinition]`)
- [ ] Add `agent_mode` field to state (with `agent_mode_or_default` property)
- [ ] Implement `SwitchModeTool` with dynamic Literal type from registry
- [ ] Add mode detection logic in `AgentExecutable._get_updated_agent_mode()`
- [ ] Return `agent_mode` in `PartialAssistantState` to propagate changes
- [ ] Implement mode reminder logic in compaction manager
- [ ] Add mode context messages in `AssistantContextManager`
- [ ] Configure `AgentModeManager` to use mode-specific toolkits
- [ ] Test mode switching preserves conversation context

### Advanced Patterns

**Conditional Mode Availability:**
```python
def get_mode_registry(team: Team, user: User) -> dict[AgentMode, AgentModeDefinition]:
    registry = {AgentMode.PRODUCT_ANALYTICS: ...}
    
    # Only add SQL mode if user has permission
    if has_sql_permission(user):
        registry[AgentMode.SQL] = ...
    
    return registry
```

**Mode-Specific Prompts:**
```python
class SqlPromptBuilder(AgentPromptBuilder):
    async def get_prompts(self, state: AssistantState, config: RunnableConfig) -> list[BaseMessage]:
        base_prompts = await super().get_prompts(state, config)
        sql_specific = HumanMessage(content="When writing SQL, use the events table...")
        return [*base_prompts, sql_specific]
```

**Mode Transition Validation:**
```python
def _get_updated_agent_mode(self, generated_message: AssistantMessage, current_mode: AgentMode) -> AgentMode | None:
    for tool_call in generated_message.tool_calls or []:
        if tool_call.name == SWITCH_MODE_TOOL_NAME:
            if new_mode := tool_call.args.get("new_mode"):
                # Validate transition is allowed
                if self._is_valid_transition(current_mode, new_mode):
                    return new_mode
    return current_mode
```

---

## References

- PostHog Agent Modes Documentation
- LangGraph State Management Guide
- Pydantic Dynamic Model Creation
- Anthropic Prompt Caching
