# PostHog HogAI Prompt System

This document provides complete details on the PostHog HogAI prompt system architecture. This system enables dynamic, context-aware prompt generation for LLM agents with tool-level steering, template-based composition, and runtime customization.

## Table of Contents

1. [Overview](#overview)
2. [AgentPromptBuilder](#agentpromptbuilder)
3. [Mustache-style Templates](#mustache-style-templates)
4. [Context Prompt Template](#context-prompt-template)
5. [Dynamic Prompt Generation](#dynamic-prompt-generation)
6. [Example Patterns](#example-patterns)
7. [System Prompt Structure](#system-prompt-structure)

---

## Overview

The HogAI prompt system is designed around several key principles:

- **Separation of concerns**: Prompts are separated into base agent prompts, mode-specific prompts, tool-level context, and runtime UI context
- **Dynamic generation**: Prompts are generated at runtime with access to team settings, user permissions, and contextual data
- **Template composition**: Large prompts are composed from smaller, reusable template strings using Mustache-style formatting
- **Tool-level steering**: Individual tools can inject context into the system prompt to guide when/how the LLM should use them

---

## AgentPromptBuilder

The `AgentPromptBuilder` is the abstract interface for generating system prompts. It's implemented by concrete builders like `ChatAgentPromptBuilder`.

### Interface Definition

```python
from abc import ABC, abstractmethod
from typing import Generic
from langchain_core.messages import BaseMessage
from langchain_core.runnables import RunnableConfig
from posthog.models import Team, User
from ee.hogai.context import AssistantContextManager
from ee.hogai.utils.types.base import AssistantState, StateType


class PromptBuilder(ABC, Generic[StateType]):
    @abstractmethod
    async def get_prompts(self, state: StateType, config: RunnableConfig) -> list[BaseMessage]:
        """
        Generate system prompts based on current state and configuration.

        Returns a list of BaseMessage objects that will be prepended to the conversation.
        Typically returns SystemMessage instances.
        """
        ...


class AgentPromptBuilder(PromptBuilder[AssistantState]):
    def __init__(self, team: Team, user: User, context_manager: AssistantContextManager):
        self._team = team
        self._user = user
        self._context_manager = context_manager

    @abstractmethod
    async def get_prompts(self, state: AssistantState, config: RunnableConfig) -> list[BaseMessage]:
        ...
```

### Concrete Implementation Example

Here's how `ChatAgentPromptBuilder` implements the interface:

```python
from langchain_core.messages import BaseMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import RunnableConfig
from ee.hogai.utils.prompt import format_prompt_string


class ChatAgentPromptBuilder(AgentPromptBuilder):
    async def get_prompts(self, state: AssistantState, config: RunnableConfig) -> list[BaseMessage]:
        # Gather dynamic data in parallel
        billing_context_prompt, core_memory, groups = await asyncio.gather(
            self._get_billing_prompt(),
            self._aget_core_memory_text(),
            self._context_manager.get_group_names(),
        )

        # Compose the main system prompt from template strings
        system_prompt = format_prompt_string(
            AGENT_PROMPT,
            role=ROLE_PROMPT,
            tone_and_style=TONE_AND_STYLE_PROMPT,
            writing_style=WRITING_STYLE_PROMPT,
            proactiveness=PROACTIVENESS_PROMPT,
            basic_functionality=BASIC_FUNCTIONALITY_PROMPT,
            switching_modes=SWITCHING_MODES_PROMPT if has_agent_modes_feature_flag(self._team, self._user) else "",
            task_management=TASK_MANAGEMENT_PROMPT,
            doing_tasks=DOING_TASKS_PROMPT,
            tool_usage_policy=TOOL_USAGE_POLICY_PROMPT,
        )

        # Return as LangChain ChatPromptTemplate messages
        return ChatPromptTemplate.from_messages(
            [
                ("system", system_prompt),
                ("system", AGENT_CORE_MEMORY_PROMPT),
            ],
            template_format="mustache",
        ).format_messages(
            groups_prompt=f" {format_prompt_string(ROOT_GROUPS_PROMPT, groups=', '.join(groups))}" if groups else "",
            billing_context=billing_context_prompt,
            core_memory=format_prompt_string(CORE_MEMORY_PROMPT, core_memory=core_memory),
        )
```

### Key Points

- `get_prompts()` is async to allow fetching runtime data (billing info, groups, core memory)
- Returns `list[BaseMessage]` - typically SystemMessage objects
- Called once per agent generation loop (see `AgentExecutable.arun()`)
- Prompts are assembled from multiple sources and cached via LangChain's cache control

---

## Mustache-style Templates

The prompt system uses Mustache-style templating with triple-brace `{{{variable}}}` syntax for unescaped HTML/text substitution.

### format_prompt_string() Function

```python
from typing import Literal
from langchain_core.prompts import PromptTemplate


def format_prompt_string(prompt: str, template_format: Literal["mustache", "f-string"] = "mustache", **kwargs) -> str:
    """
    Format a prompt template with dynamic values.

    Useful when tools need to dynamically inject content into their description or prompts
    based on runtime context (e.g., user permissions, team settings).

    Args:
        prompt: The prompt template string with variables to be replaced.
                Variables should be in mustache format {{{variable}}} or f-string format {variable}.
        template_format: The template format to use. Defaults to "mustache".
        **kwargs: Variables to inject into the template.

    Returns:
        The formatted prompt string with all variables replaced.

    Example:
        >>> prompt = "You have access to: {{{features}}}"
        >>> formatted = format_prompt_string(prompt, features="billing, search")
        >>> print(formatted)
        "You have access to: billing, search"
    """
    return (
        PromptTemplate.from_template(prompt, template_format=template_format)
        .format_prompt(**kwargs)
        .to_string()
        .strip()
    )
```

### Template Syntax

**Triple braces** `{{{variable}}}` - Unescaped substitution (default):
```python
prompt = "The current filters are: {{{current_filters}}}"
formatted = format_prompt_string(prompt, current_filters='{"status": "active"}')
# Result: The current filters are: {"status": "active"}
```

**Double braces** `{{variable}}` - Escaped substitution (rare in HogAI):
```python
prompt = "User said: {{user_input}}"
formatted = format_prompt_string(prompt, user_input="<script>alert('xss')</script>")
# Result: User said: &lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;
```

**Conditional sections** `{{#variable}}...{{/variable}}`:
```python
ROOT_INSIGHT_CONTEXT_PROMPT = """
{{{heading}}} Insight: {{{name}}}
{{#description}}

Description: {{.}}
{{/description}}
"""
# If description exists, section renders; otherwise it's omitted
```

### Example Template

```python
AGENT_PROMPT = """
{{{role}}}

{{{tone_and_style}}}

{{{writing_style}}}

{{{proactiveness}}}

{{{basic_functionality}}}

{{{switching_modes}}}

{{{task_management}}}

{{{doing_tasks}}}

{{{tool_usage_policy}}}

{{{billing_context}}}
""".strip()
```

Usage:
```python
system_prompt = format_prompt_string(
    AGENT_PROMPT,
    role=ROLE_PROMPT,
    tone_and_style=TONE_AND_STYLE_PROMPT,
    writing_style=WRITING_STYLE_PROMPT,
    # ... etc
)
```

---

## Context Prompt Template

The `context_prompt_template` is a tool-level attribute that allows individual tools to inject instructions into the **root agent's system prompt**. This is critical for steering when/whether the LLM should use a tool.

### Tool-Level Declaration

```python
from ee.hogai.tool import MaxTool


class ReadTaxonomyTool(MaxTool):
    name: Literal["read_taxonomy"] = "read_taxonomy"
    description: str = READ_TAXONOMY_TOOL_DESCRIPTION

    # This template will be injected into the root system prompt
    context_prompt_template: str = (
        "Explores the user's events, actions, properties, and property values (i.e. taxonomy)."
    )
```

### How It Works

1. **Tool provides template** via `context_prompt_template` attribute
2. **Context manager formats it** using `format_context_prompt_injection()`
3. **Injected into root prompt** as a ContextMessage before the conversation starts

### format_context_prompt_injection() Implementation

From `ee/hogai/tool.py`:

```python
def format_context_prompt_injection(self, context: dict[str, Any]) -> str | None:
    if not self.context_prompt_template:
        return None

    # Build initial context (convert dicts/lists to JSON strings)
    formatted_context = {
        key: (json.dumps(value) if isinstance(value, dict | list) else value)
        for key, value in context.items()
    }

    # Extract expected keys from template using Python's string.Formatter
    expected_keys = {
        field for _, field, _, _ in Formatter().parse(self.context_prompt_template)
        if field is not None
    }

    # Fill missing keys with None (for cached frontend context)
    for key in expected_keys:
        if key not in formatted_context:
            formatted_context[key] = None
            logger.warning(
                f"Context prompt template for {self.get_name()} expects key {key} "
                f"but it is not present in the context"
            )

    return self.context_prompt_template.format(**formatted_context)
```

### Context Injection Flow

From `ee/hogai/context/context.py`:

```python
async def _get_contextual_tools_prompt(self) -> str | None:
    from ee.hogai.registry import get_contextual_tool_class

    contextual_tools_prompt: list[str] = []

    # For each contextual tool available
    for tool_name, tool_context in self.get_contextual_tools().items():
        tool_class = get_contextual_tool_class(tool_name)
        if tool_class is None:
            continue

        # Create tool instance
        tool = await tool_class.create_tool_class(
            team=self._team,
            user=self._user,
            context_manager=self
        )

        # Format its context prompt injection
        tool_prompt = tool.format_context_prompt_injection(tool_context)
        contextual_tools_prompt.append(
            f"<{tool_name}>\n"
            f"{tool_prompt}\n"
            f"</{tool_name}>"
        )

    if contextual_tools_prompt:
        tools = "\n".join(contextual_tools_prompt)
        return CONTEXTUAL_TOOLS_REMINDER_PROMPT.format(tools=tools)
    return None
```

Result injected into system prompt:
```
<system_reminder>
Contextual tools that are available to you on this page are:
<read_taxonomy>
Explores the user's events, actions, properties, and property values (i.e. taxonomy).
</read_taxonomy>
IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system_reminder>
```

### Use Cases

- **Conditional availability**: "The user can create insights with the following visualization types: {{{viz_types}}}"
- **Permission-based**: "You have {{{permission_level}}} access to billing tools"
- **Dynamic schema**: "Available entity types: {{{entity_types}}}"

---

## Dynamic Prompt Generation

Tools can override `create_tool_class()` to dynamically modify their name, description, args schema, and more based on runtime context.

### The create_tool_class() Pattern

Base implementation from `ee/hogai/tool.py`:

```python
@classmethod
async def create_tool_class(
    cls,
    *,
    team: Team,
    user: User,
    node_path: tuple[NodePath, ...] | None = None,
    state: AssistantState | None = None,
    config: RunnableConfig | None = None,
    context_manager: AssistantContextManager | None = None,
) -> Self:
    """
    Factory that creates a tool class.

    Override this factory to dynamically modify the tool name, description,
    args schema, etc.
    """
    return cls(
        team=team,
        user=user,
        node_path=node_path,
        state=state,
        config=config,
        context_manager=context_manager
    )
```

### Example: Dynamic Entity Types

From `ee/hogai/tools/read_taxonomy.py`:

```python
class ReadTaxonomyTool(MaxTool):
    name: Literal["read_taxonomy"] = "read_taxonomy"
    description: str = READ_TAXONOMY_TOOL_DESCRIPTION

    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        node_path: tuple[NodePath, ...] | None = None,
        state: AssistantState | None = None,
        config: RunnableConfig | None = None,
        context_manager: AssistantContextManager | None = None,
    ) -> Self:
        context_manager = AssistantContextManager(team, user, config)

        # Fetch team-specific group names at runtime
        group_names = await context_manager.get_group_names()

        # Create Literal type with actual entity names
        EntityKind = Literal["person", "session", *group_names]  # type: ignore

        # Dynamically create Pydantic models with the team's group types
        ReadEntityPropertiesWithGroups = create_model(
            "ReadEntityProperties",
            __base__=ReadEntityProperties,
            entity=(
                EntityKind,
                Field(description=ReadEntityProperties.model_fields["entity"].description),
            ),
        )

        ReadEntitySamplePropertyValuesWithGroups = create_model(
            "ReadEntitySamplePropertyValues",
            __base__=ReadEntitySamplePropertyValues,
            entity=(
                EntityKind,
                Field(description=ReadEntitySamplePropertyValues.model_fields["entity"].description),
            ),
        )

        # Create discriminated union with dynamic entity types
        ReadTaxonomyQueryWithGroups = Union[
            ReadEvents,
            ReadEventProperties,
            ReadEventSamplePropertyValues,
            ReadEntityPropertiesWithGroups,  # type: ignore[valid-type]
            ReadEntitySamplePropertyValuesWithGroups,  # type: ignore[valid-type]
            ReadActionProperties,
            ReadActionSamplePropertyValues,
        ]

        class ReadTaxonomyToolArgsWithGroups(BaseModel):
            query: ReadTaxonomyQueryWithGroups = Field(..., discriminator="kind")

        # Return tool instance with customized args schema
        return cls(
            team=team,
            user=user,
            state=state,
            config=config,
            node_path=node_path,
            args_schema=ReadTaxonomyToolArgsWithGroups,  # Custom schema!
            context_manager=context_manager,
        )
```

**Result**: If a team has groups `["company", "project"]`, the LLM sees:
```json
{
  "query": {
    "kind": "entity_properties",
    "entity": "person" | "session" | "company" | "project"
  }
}
```

### Example: Dynamic Tool Description

From `ee/hogai/tools/todo_write.py`:

```python
class TodoWriteTool(MaxTool):
    name: Literal["todo_write"] = "todo_write"
    args_schema: type[BaseModel] = TodoWriteToolArgs

    POSITIVE_TODO_EXAMPLES: ClassVar[list[TodoWriteExample]] = [...]
    NEGATIVE_TODO_EXAMPLES: ClassVar[list[TodoWriteExample]] = [...]

    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        node_path: tuple[NodePath, ...] | None = None,
        state: AssistantState | None = None,
        config: RunnableConfig | None = None,
        context_manager: AssistantContextManager | None = None,
        positive_examples: Sequence[TodoWriteExample] | None = None,
        negative_examples: Sequence[TodoWriteExample] | None = None,
    ) -> Self:
        # Format the tool's description with examples
        formatted_prompt = format_prompt_string(
            TODO_WRITE_PROMPT,
            positive_todo_examples=_format_todo_write_examples(
                positive_examples or cls.POSITIVE_TODO_EXAMPLES
            ),
            negative_todo_examples=_format_todo_write_examples(
                negative_examples or cls.NEGATIVE_TODO_EXAMPLES
            ),
        )

        # Return tool with custom description
        return cls(
            team=team,
            user=user,
            node_path=node_path,
            state=state,
            config=config,
            context_manager=context_manager,
            description=formatted_prompt,  # Custom description!
        )
```

This allows mode-specific or toolkit-specific examples to be injected:

```python
# Mode toolkit can provide custom examples
class SessionReplayAgentToolkit(AgentToolkit):
    POSITIVE_TODO_EXAMPLES = [
        TodoWriteExample(
            example="User: Find sessions where users rage clicked...",
            reasoning="Assistant used todo list because finding rage clicks requires multiple filtering steps"
        )
    ]
```

---

## Example Patterns

The `TodoWriteExample` pattern demonstrates how to guide LLM behavior through few-shot prompting with positive/negative examples.

### TodoWriteExample Structure

```python
from pydantic import BaseModel


class TodoWriteExample(BaseModel):
    """
    Custom agent example to correct the agent's behavior through few-shot prompting.
    The example will be formatted as follows:
    ```
    <example>
    {example}

    <reasoning>
    {reasoning}
    </reasoning>
    </example>
    ```
    """
    example: str
    reasoning: str | None = None
```

### Template for Examples

```python
TODO_WRITE_EXAMPLE_PROMPT = """
<example>
{{{example}}}
<reasoning>
{{{reasoning}}}
</reasoning>
</example>
""".strip()
```

### Positive Example

```python
POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION = """
User: how many users have chatted with the AI assistant from the US?
Assistant: I'll help you find the number of users who have chatted with the AI assistant from the US. Let me create a todo list to track this implementation.
*Creates todo list with the following items:*
1. Find the relevant events to "chatted with the AI assistant"
2. Find the relevant properties of the events and persons to narrow down data to users from specific country
3. Retrieve the sample property values for found properties
4. Create the structured plan of the insight by using the data retrieved in the previous steps
5. Generate the insight
6. Analyze retrieved data
*Begins working on the first task*
""".strip()

POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION_REASONING = """
The assistant used the todo list because:
1. Creating an insight requires understanding the taxonomy: events, properties, and property values are relevant to the user's query.
2. The user query requests additional segmentation.
3. Property values might require retrieving sample property values to understand the data better.
4. Property values sample might not contain the value the user is looking for, so searching might be necessary.
5. Taxonomy might have multiple combinations of data that will equally answer the question.
""".strip()
```

### Negative Example

```python
NEGATIVE_EXAMPLE_SIMPLE_QUERY_EXPLANATION = """
User: What does this query do?
Assistant: Let me analyze the query you provided.
*Reads the attached context in the conversation history*
Assistant: The query is retrieving the sign-up count for the last 30 days.
""".strip()

NEGATIVE_EXAMPLE_SIMPLE_QUERY_EXPLANATION_REASONING = """
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step. There's no need to track multiple tasks or steps for such a straightforward request.
""".strip()
```

### Using Examples in Tools

```python
class TodoWriteTool(MaxTool):
    POSITIVE_TODO_EXAMPLES: ClassVar[list[TodoWriteExample]] = [
        TodoWriteExample(
            example=POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION,
            reasoning=POSITIVE_EXAMPLE_INSIGHT_WITH_SEGMENTATION_REASONING,
        ),
        TodoWriteExample(
            example=POSITIVE_EXAMPLE_COMPANY_CHURN_ANALYSIS,
            reasoning=POSITIVE_EXAMPLE_COMPANY_CHURN_ANALYSIS_REASONING
        ),
        TodoWriteExample(
            example=POSITIVE_EXAMPLE_MULTIPLE_METRICS_ANALYSIS,
            reasoning=POSITIVE_EXAMPLE_MULTIPLE_METRICS_ANALYSIS_REASONING,
        ),
    ]

    NEGATIVE_TODO_EXAMPLES: ClassVar[list[TodoWriteExample]] = [
        TodoWriteExample(
            example=NEGATIVE_EXAMPLE_SIMPLE_QUERY_EXPLANATION,
            reasoning=NEGATIVE_EXAMPLE_SIMPLE_QUERY_EXPLANATION_REASONING,
        ),
        TodoWriteExample(
            example=NEGATIVE_EXAMPLE_DOCUMENTATION_REQUEST,
            reasoning=NEGATIVE_EXAMPLE_DOCUMENTATION_REQUEST_REASONING
        ),
    ]
```

Examples are formatted and injected into the tool description:

```python
def _format_todo_write_examples(examples: Sequence[TodoWriteExample]) -> str:
    return "\n".join([
        format_prompt_string(
            TODO_WRITE_EXAMPLE_PROMPT,
            example=example.example,
            reasoning=example.reasoning
        )
        for example in examples
    ])
```

### Benefits

- **Behavioral steering**: Show LLM what "good" and "bad" usage looks like
- **Context-specific**: Different modes can provide different examples
- **Maintainable**: Examples are separate from tool logic
- **Testable**: Can validate example formatting independently

---

## System Prompt Structure

The final system prompt sent to the LLM is assembled from multiple layers:

### 1. Base Agent Prompt

Assembled from component templates:

```python
AGENT_PROMPT = """
{{{role}}}

{{{tone_and_style}}}

{{{writing_style}}}

{{{proactiveness}}}

{{{basic_functionality}}}

{{{switching_modes}}}

{{{task_management}}}

{{{doing_tasks}}}

{{{tool_usage_policy}}}

{{{billing_context}}}
""".strip()
```

Each component is a string constant:

```python
ROLE_PROMPT = """
You are PostHog AI, PostHog's AI agent, who helps users with their product management tasks. Use the instructions below and the tools available to you to assist the user.
""".strip()

TONE_AND_STYLE_PROMPT = """
<tone_and_style>
Use PostHog's distinctive voice - friendly and direct without corporate fluff.
Be helpful and straightforward with a touch of personality, but avoid being overly whimsical or flowery.
Get straight to the point.
Do NOT compliment the user with fluff like "Great question!" or "You're absolutely right!"
...
</tone_and_style>
""".strip()
```

### 2. Core Memory Prompt

Injected as a second system message:

```python
AGENT_CORE_MEMORY_PROMPT = """
{{{core_memory}}}
New memories will automatically be added to the core memory as the conversation progresses. If users ask to save, update, or delete the core memory, say you have done it. If the '/remember [information]' command is used, the information gets appended verbatim to core memory.

Available slash commands:
- '/init' - Set up knowledge about the user's product and business
- '/remember [information]' - Adds information to the project-level core memory
- '/usage' - Shows PostHog AI credit usage for the current conversation and billing period
""".strip()
```

Where `core_memory` is fetched from the database:

```python
CORE_MEMORY_PROMPT = """
You have access to the core memory about the user's company and product in the <core_memory> tag. Use this memory in your thinking.
<core_memory>
{{{core_memory}}}
</core_memory>
""".strip()
```

### 3. Runtime Context Messages

Injected **before the conversation starts** (before the first human message):

#### a) Mode Context

```python
CONTEXT_MODE_PROMPT = """
<system_reminder>{{{mode_prompt}}} {{{mode}}}.</system_reminder>
""".strip()

# mode_prompt is either:
CONTEXT_INITIAL_MODE_PROMPT = "Your initial mode is"
CONTEXT_MODE_SWITCH_PROMPT = "Your mode has been switched to"
```

#### b) Contextual Tools Context

```python
CONTEXTUAL_TOOLS_REMINDER_PROMPT = """
<system_reminder>
Contextual tools that are available to you on this page are:
{tools}
IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system_reminder>
""".strip()
```

#### c) UI Context (Dashboards/Insights)

```python
ROOT_UI_CONTEXT_PROMPT = """
<attached_context>
{{{ui_context_dashboard}}}
{{{ui_context_insights}}}
{{{ui_context_events}}}
{{{ui_context_actions}}}
</attached_context>
<system_reminder>
The user can provide additional context in the <attached_context> tag.
If the user's request is ambiguous, use the context to direct your answer as much as possible.
If the user's provided context has nothing to do with previous interactions, ignore any past interaction and use this new context instead. The user probably wants to change topic.
You can acknowledge that you are using this context to answer the user's request.
</system_reminder>
""".strip()
```

### 4. Full Assembly Process

From `ee/hogai/core/agent_modes/executables.py`:

```python
async def arun(self, state: AssistantState, config: RunnableConfig) -> PartialAssistantState:
    toolkit_manager = self._toolkit_manager_class(
        team=self._team, user=self._user, context_manager=self.context_manager
    )
    prompt_builder = self._prompt_builder_class(
        team=self._team, user=self._user, context_manager=self.context_manager
    )

    # Get tools and system prompts in parallel
    tools, system_prompts = await asyncio.gather(*[
        toolkit_manager.get_tools(state, config),
        prompt_builder.get_prompts(state, config)
    ])

    # Add context messages on start of the conversation
    messages_to_replace: Sequence[AssistantMessageUnion] = []
    if self._is_first_turn(state) and (
        updated_messages := await self.context_manager.get_state_messages_with_context(state)
    ):
        messages_to_replace = updated_messages

    # Construct message history
    langchain_messages = self._construct_messages(
        messages_to_replace or state.messages,
        state.root_conversation_start_id,
        state.root_tool_calls_count
    )

    # Mark the longest default prefix as cacheable
    system_prompts = cast(list[BaseMessage], system_prompts)
    add_cache_control(system_prompts[0], ttl="1h")

    # Invoke LLM with system prompts + conversation history
    message = await model.ainvoke(system_prompts + langchain_messages, config)
```

### Message Order

Final message order sent to LLM:

```
[System Message 1] Base agent prompt (CACHED)
[System Message 2] Core memory prompt
[Context Message] Mode context (if first turn or mode switched)
[Context Message] Contextual tools reminder (if contextual tools present)
[Context Message] UI context (if dashboards/insights attached)
[Human Message] User's first message
[Assistant Message] ...
[Tool Message] ...
[Human Message] User's next message
...
```

### Caching Strategy

From Anthropic's prompt caching:

1. **System prompt (1h TTL)**: The base agent prompt is marked cacheable
2. **Conversation prefix**: The last human/tool message is marked for ephemeral caching
3. **Context messages**: Injected before conversation start to be cached with system prompt

```python
# Mark system prompt as cacheable
add_cache_control(system_prompts[0], ttl="1h")

# Mark last conversation message as cacheable
for i in range(len(messages) - 1, -1, -1):
    if isinstance(messages[i], LangchainHumanMessage | LangchainAIMessage):
        maybe_content_arr = messages[i].content
        if isinstance(maybe_content_arr, list) and len(maybe_content_arr) > 0:
            maybe_content_arr[-1]["cache_control"] = {"type": "ephemeral"}
            break
```

---

## Implementation Checklist

To reimplement this system from scratch:

### 1. Template System

- [ ] Implement `format_prompt_string()` using LangChain's PromptTemplate
- [ ] Support Mustache-style `{{{variable}}}` syntax
- [ ] Support conditional sections `{{#var}}...{{/var}}`
- [ ] Handle missing variables gracefully

### 2. Prompt Builder

- [ ] Create abstract `PromptBuilder` interface with `get_prompts()`
- [ ] Implement concrete `AgentPromptBuilder` subclass
- [ ] Support async data fetching (groups, billing, core memory)
- [ ] Compose prompts from template strings
- [ ] Return list of BaseMessage (SystemMessage instances)

### 3. Tool Context Injection

- [ ] Add `context_prompt_template` attribute to tool base class
- [ ] Implement `format_context_prompt_injection()` on tools
- [ ] Extract variables from template using `string.Formatter`
- [ ] Format context as JSON for dict/list values
- [ ] Wrap tool contexts in XML tags (`<tool_name>...</tool_name>`)

### 4. Dynamic Tool Generation

- [ ] Make `create_tool_class()` async classmethod
- [ ] Fetch runtime data (group names, permissions, etc.)
- [ ] Dynamically create Pydantic models with `create_model()`
- [ ] Return tool instance with custom description/args_schema

### 5. Example System

- [ ] Create `Example` base model with `example` and `reasoning` fields
- [ ] Format examples with template wrapper
- [ ] Support positive and negative examples
- [ ] Inject into tool descriptions at creation time

### 6. Context Manager

- [ ] Implement `get_state_messages_with_context()`
- [ ] Fetch UI context (dashboards, insights) in parallel
- [ ] Format UI context with Mustache templates
- [ ] Inject context messages before conversation start
- [ ] Deduplicate context messages by content

### 7. Prompt Assembly

- [ ] Call `prompt_builder.get_prompts()` in agent loop
- [ ] Call `context_manager.get_state_messages_with_context()` on first turn
- [ ] Prepend system prompts to conversation history
- [ ] Add cache control to first system prompt
- [ ] Add ephemeral cache to last conversation message

---

## Key Insights

1. **Separation of concerns**: System prompt, tool context, and runtime context are separate layers
2. **Lazy evaluation**: Prompts are generated at runtime with access to fresh data
3. **Template composition**: Large prompts are built from small, testable components
4. **Tool-level steering**: Individual tools can guide when/how they should be used
5. **Dynamic schemas**: Pydantic schemas are generated at runtime based on team settings
6. **Example-driven**: LLM behavior is steered through positive/negative examples
7. **Caching-aware**: Prompts are structured to maximize Anthropic's cache hits

---

## Related Files

- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/core/agent_modes/prompt_builder.py` - Abstract interfaces
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/core/shared_prompts.py` - Shared prompt templates
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/utils/prompt.py` - `format_prompt_string()` implementation
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/tool.py` - MaxTool base class with context injection
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/context/context.py` - AssistantContextManager
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/chat_agent/mode_manager.py` - Concrete prompt builder
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/chat_agent/prompts.py` - Agent prompt templates
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/tools/todo_write.py` - Example system demo
- `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/tools/read_taxonomy.py` - Dynamic schema demo
