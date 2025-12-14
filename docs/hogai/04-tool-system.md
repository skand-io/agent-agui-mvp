# PostHog HogAI Tool System Architecture

This document provides a comprehensive guide to the PostHog HogAI tool system, with enough detail to reimplement it from scratch.

## Table of Contents

1. [Overview](#overview)
2. [MaxTool Class](#maxtool-class)
3. [Tool Definition Pattern](#tool-definition-pattern)
4. [Factory Method](#factory-method)
5. [Auto-Registration System](#auto-registration-system)
6. [ToolMessagesArtifact](#toolmessagesartifact)
7. [Error Types](#error-types)
8. [MaxSubtool Pattern](#maxsubtool-pattern)
9. [Complete Example](#complete-example)

## Overview

The HogAI tool system is built on top of LangChain's `BaseTool` and provides a framework for creating AI assistant tools that can:

- Execute actions on behalf of the user
- Return both text content and structured artifacts
- Handle errors with intelligent retry strategies
- Track billing for LLM generations
- Auto-register themselves for discovery
- Inject contextual prompts to steer tool selection

## MaxTool Class

`MaxTool` is the base class for all HogAI tools. It extends LangChain's `BaseTool` and adds PostHog-specific functionality.

### Key Properties

```python
from ee.hogai.tool import MaxTool
from pydantic import BaseModel

class MaxTool(AssistantContextMixin, AssistantDispatcherMixin, BaseTool):
    # Always return both content and artifact (not just content)
    response_format: Literal["content_and_artifact"] = "content_and_artifact"

    # Whether LLM generations triggered by this tool count toward billing
    billable: bool = False

    # Template for context injection into root node's context messages
    # Formatted as f-string with tool context as variables
    context_prompt_template: str | None = None

    # Internal state
    _config: RunnableConfig
    _state: AssistantState
    _context_manager: AssistantContextManager
    _node_path: tuple[NodePath, ...]
```

### Response Format

Unlike LangChain's default (which only returns `"content"`), MaxTool always returns both:
- **content**: Text message visible to the LLM
- **artifact**: Structured data (becomes `ui_payload` in frontend)

This allows tools to return rich UI payloads while also providing textual context to the LLM.

### Billable Flag

```python
class CreateInsightTool(MaxTool):
    billable: bool = True  # LLM calls made by this tool count toward billing
```

When `billable=True`, any LLM generations triggered during tool execution are counted toward the user's billing quota.

### Context Prompt Template

The `context_prompt_template` is injected into the root node's context to help the LLM decide when to use the tool:

```python
class SearchTool(MaxTool):
    context_prompt_template: str = (
        "Searches documentation, insights, dashboards, cohorts, actions, "
        "experiments, feature flags, notebooks, error tracking issues, and surveys"
    )
```

The template is formatted as an f-string using the tool's context dictionary:

```python
def format_context_prompt_injection(self, context: dict[str, Any]) -> str | None:
    if not self.context_prompt_template:
        return None

    # JSON-encode complex values
    formatted_context = {
        key: (json.dumps(value) if isinstance(value, dict | list) else value)
        for key, value in context.items()
    }

    # Extract expected keys from template
    expected_keys = {
        field for _, field, _, _ in Formatter().parse(self.context_prompt_template)
        if field is not None
    }

    # Use None as default for missing keys
    for key in expected_keys:
        if key not in formatted_context:
            formatted_context[key] = None
            logger.warning(f"Context prompt template expects key {key} but it is not present")

    return self.context_prompt_template.format(**formatted_context)
```

### Constructor

```python
def __init__(
    self,
    *,
    team: Team,
    user: User,
    node_path: tuple[NodePath, ...] | None = None,
    state: AssistantState | None = None,
    config: RunnableConfig | None = None,
    name: str | None = None,
    description: str | None = None,
    args_schema: type[BaseModel] | None = None,
    context_manager: AssistantContextManager | None = None,
    **kwargs,
):
    # Build tool_kwargs for BaseTool
    tool_kwargs: dict[str, Any] = {}
    if name is not None:
        tool_kwargs["name"] = name
    if description is not None:
        tool_kwargs["description"] = description
    if args_schema is not None:
        tool_kwargs["args_schema"] = args_schema

    super().__init__(**tool_kwargs, **kwargs)

    # Initialize PostHog-specific fields
    self._team = team
    self._user = user
    self._node_path = node_path or get_node_path() or ()
    self._state = state if state else AssistantState(messages=[])
    self._config = config if config else RunnableConfig(configurable={})
    self._context_manager = context_manager or AssistantContextManager(team, user, self._config)
```

### Node Path Tracking

Each tool maintains a node path for execution tracking:

```python
@property
def node_name(self) -> str:
    return f"max_tool.{self.get_name()}"

@property
def node_path(self) -> tuple[NodePath, ...]:
    return (*self._node_path, NodePath(name=self.node_name))
```

This enables hierarchical execution tracking like:
- `root_node` → `max_tool.search` → `max_subtool.InkeepDocsSearchTool`

### Context Access

Tools can access their contextual configuration:

```python
@property
def context(self) -> dict:
    return self._context_manager.get_contextual_tools().get(self.get_name(), {})
```

This allows dynamic configuration based on frontend state or user preferences.

## Tool Definition Pattern

### Basic Structure

Every tool follows this pattern:

```python
from typing import Literal, Any
from pydantic import BaseModel, Field
from ee.hogai.tool import MaxTool

# 1. Define args schema using Pydantic
class MyToolArgs(BaseModel):
    param1: str = Field(description="Description of param1")
    param2: int = Field(default=10, description="Optional parameter")

# 2. Define the tool class
class MyTool(MaxTool):
    # Tool identifier (must match AssistantTool enum in schema)
    name: Literal["my_tool"] = "my_tool"

    # LLM-visible description (can be long, detailed)
    description: str = """
    Use this tool when you need to...

    Examples:
    - Example 1
    - Example 2
    """

    # Pydantic schema for arguments
    args_schema: type[BaseModel] = MyToolArgs

    # Context prompt template (optional)
    context_prompt_template: str = "Does X using {param}"

    # Billable flag (optional, default False)
    billable: bool = False

    # 3. Implement execution logic
    async def _arun_impl(self, param1: str, param2: int) -> tuple[str, Any]:
        """
        Tool execution that returns (content, artifact).

        Args:
            param1: First parameter (from args_schema)
            param2: Second parameter (from args_schema)

        Returns:
            tuple[str, Any]: (text_content_for_llm, ui_artifact_or_none)
        """
        result = await self._do_something(param1, param2)

        # Return both text for LLM and artifact for UI
        return f"Successfully processed {param1}", {"result": result}
```

### Argument Schema

Use Pydantic models with detailed field descriptions to guide the LLM:

```python
class ExecuteSQLToolArgs(BaseModel):
    query: str = Field(description="The final SQL query to be executed.")

class SearchToolArgs(BaseModel):
    kind: SearchKind = Field(description="Select the entity you want to find")
    query: str = Field(
        description="Describe what you want to find. Include as much details from the context as possible."
    )
```

### Union Types for Complex Args

For tools with multiple modes, use discriminated unions:

```python
from typing import Union, Literal
from pydantic import BaseModel, Field

class ReadEvents(BaseModel):
    kind: Literal["events"] = "events"

class ReadEventProperties(BaseModel):
    kind: Literal["event_properties"] = "event_properties"
    event_name: str = Field(description="The name of the event")

class ReadEntityProperties(BaseModel):
    kind: Literal["entity_properties"] = "entity_properties"
    entity: str = Field(description="The type of the entity")

# Discriminated union
ReadTaxonomyQuery = Union[
    ReadEvents,
    ReadEventProperties,
    ReadEntityProperties,
]

class ReadTaxonomyToolArgs(BaseModel):
    query: ReadTaxonomyQuery = Field(..., discriminator="kind")
```

The LLM will then call the tool like:

```json
{
  "query": {
    "kind": "event_properties",
    "event_name": "user_signed_up"
  }
}
```

### Implementation Methods

Tools must implement `_arun_impl` (async) or `_run_impl` (sync):

```python
# Async implementation (preferred)
async def _arun_impl(self, *args, **kwargs) -> tuple[str, Any]:
    """Tool execution, returns (content, artifact)"""
    raise NotImplementedError

# Sync implementation (deprecated, use _arun_impl)
def _run_impl(self, *args, **kwargs) -> tuple[str, Any]:
    """DEPRECATED. Use _arun_impl instead."""
    raise NotImplementedError
```

The `_run` and `_arun` methods (called by LangChain) automatically wrap your implementation with context management:

```python
async def _arun(self, *args, config: RunnableConfig, **kwargs):
    """LangChain default runner."""
    try:
        return await self._arun_with_context(*args, **kwargs)
    except NotImplementedError:
        pass
    return await super()._arun(*args, config=config, **kwargs)

async def _arun_with_context(self, *args, **kwargs):
    """Sets the context for the tool."""
    with set_node_path(self.node_path):
        return await self._arun_impl(*args, **kwargs)
```

### Return Type

All tools return `tuple[str, Any]`:

- **First element (str)**: Text content visible to the LLM
- **Second element (Any)**: Artifact for UI (or `None`)

Examples:

```python
# Simple text response, no artifact
return "Weather in SF: 72°F, sunny", None

# Text + structured artifact
return "Query executed successfully", {
    "query": sql_query,
    "rows": 150,
    "columns": ["name", "count"]
}

# Text + ToolMessagesArtifact (see below)
return "", ToolMessagesArtifact(messages=[msg1, msg2])
```

## Factory Method

The `create_tool_class` factory method allows dynamic tool configuration at runtime.

### Basic Pattern

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

    Override this factory to dynamically modify the tool name,
    description, args schema, etc.
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

### When to Override

Override `create_tool_class` when you need to:

1. **Dynamically generate descriptions** based on context
2. **Customize args_schema** based on team configuration
3. **Inject examples** specific to the user's data
4. **Format prompts** with team-specific information

### Example: Dynamic Description

```python
from ee.hogai.utils.prompt import format_prompt_string

class TodoWriteTool(MaxTool):
    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        positive_examples: Sequence[TodoWriteExample] | None = None,
        negative_examples: Sequence[TodoWriteExample] | None = None,
        **kwargs,
    ) -> Self:
        # Format prompt with examples
        formatted_prompt = format_prompt_string(
            TODO_WRITE_PROMPT,
            positive_todo_examples=_format_examples(
                positive_examples or cls.POSITIVE_TODO_EXAMPLES
            ),
            negative_todo_examples=_format_examples(
                negative_examples or cls.NEGATIVE_TODO_EXAMPLES
            ),
        )

        return cls(
            team=team,
            user=user,
            description=formatted_prompt,  # Override description
            **kwargs,
        )
```

### Example: Dynamic Args Schema

```python
from pydantic import create_model

class ReadTaxonomyTool(MaxTool):
    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        context_manager: AssistantContextManager | None = None,
        **kwargs,
    ) -> Self:
        # Fetch team-specific group names
        context_manager = AssistantContextManager(team, user, config)
        group_names = await context_manager.get_group_names()

        # Create dynamic Literal type with actual entity names
        EntityKind = Literal["person", "session", *group_names]  # type: ignore

        # Create modified Pydantic model with dynamic types
        ReadEntityPropertiesWithGroups = create_model(
            "ReadEntityProperties",
            __base__=ReadEntityProperties,
            entity=(
                EntityKind,
                Field(description="The type of the entity"),
            ),
        )

        # Build new union type
        ReadTaxonomyQueryWithGroups = Union[
            ReadEvents,
            ReadEventProperties,
            ReadEntityPropertiesWithGroups,  # type: ignore
            # ... other types
        ]

        class ReadTaxonomyToolArgsWithGroups(BaseModel):
            query: ReadTaxonomyQueryWithGroups = Field(..., discriminator="kind")

        return cls(
            team=team,
            user=user,
            args_schema=ReadTaxonomyToolArgsWithGroups,  # Override schema
            context_manager=context_manager,
            **kwargs,
        )
```

### Example: Dynamic Prompt Formatting

```python
from products.data_warehouse.backend.prompts import SQL_ASSISTANT_ROOT_SYSTEM_PROMPT

class ExecuteSQLTool(HogQLGeneratorMixin, MaxTool):
    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        **kwargs,
    ) -> Self:
        # Format prompt with SQL documentation
        prompt = format_prompt_string(
            EXECUTE_SQL_SYSTEM_PROMPT,
            sql_expressions_docs=SQL_EXPRESSIONS_DOCS,
            sql_supported_functions_docs=SQL_SUPPORTED_FUNCTIONS_DOCS,
            sql_supported_aggregations_docs=SQL_SUPPORTED_AGGREGATIONS_DOCS,
        )

        return cls(
            team=team,
            user=user,
            description=prompt,  # Override description
            context_prompt_template=SQL_ASSISTANT_ROOT_SYSTEM_PROMPT,
            **kwargs,
        )
```

## Auto-Registration System

The HogAI tool system uses a metaclass pattern to automatically register tools for discovery.

### Registration Mechanism

Tools auto-register in `__init_subclass__`:

```python
from posthog.schema import AssistantTool
from ee.hogai.registry import CONTEXTUAL_TOOL_NAME_TO_TOOL

class MaxTool(BaseTool):
    def __init_subclass__(cls, **kwargs):
        super().__init_subclass__(**kwargs)

        # 1. Enforce naming convention
        if not cls.__name__.endswith("Tool"):
            raise ValueError(
                "The name of a MaxTool subclass must end with 'Tool', for clarity"
            )

        # 2. Validate against schema
        try:
            accepted_name = AssistantTool(cls.name)
        except ValueError:
            raise ValueError(
                f"MaxTool name '{cls.name}' is not a recognized AssistantTool value. "
                f"Fix this name, or update AssistantTool in schema-assistant-messages.ts "
                f"and run `pnpm schema:build`"
            )

        # 3. Auto-register in global registry
        CONTEXTUAL_TOOL_NAME_TO_TOOL[accepted_name] = cls
```

This means:
- Creating a new `MaxTool` subclass automatically registers it
- No manual registration code needed
- Schema validation happens at import time
- Frontend/backend tool names are kept in sync

### Registry Structure

The registry is a simple dictionary in `/Users/kevinlu/Downloads/minimal-chat/posthog-master/ee/hogai/registry.py`:

```python
from typing import TYPE_CHECKING
from posthog.schema import AssistantTool

if TYPE_CHECKING:
    from ee.hogai.tool import MaxTool

# Global registry mapping tool names to classes
CONTEXTUAL_TOOL_NAME_TO_TOOL: dict[AssistantTool, type["MaxTool"]] = {}
```

### Tool Discovery

Tools are discovered dynamically by scanning product modules:

```python
import pkgutil
import importlib
import products

def _import_max_tools() -> None:
    """TRICKY: Dynamically import max_tools from all products"""
    for module_info in pkgutil.iter_modules(products.__path__):
        if module_info.name in ("conftest", "test"):
            continue  # Don't import test modules in prod

        try:
            importlib.import_module(f"products.{module_info.name}.backend.max_tools")
        except ModuleNotFoundError:
            pass  # Skip if backend or max_tools doesn't exist

def get_contextual_tool_class(tool_name: str) -> type["MaxTool"] | None:
    """Get the tool class for a given tool name, handling circular import."""
    _import_max_tools()  # Ensure max_tools are imported

    try:
        return CONTEXTUAL_TOOL_NAME_TO_TOOL[AssistantTool(tool_name)]
    except (KeyError, ValueError):
        return None
```

### Schema Validation

Tool names must be defined in the TypeScript schema (`schema-assistant-messages.ts`):

```typescript
export enum AssistantTool {
    SEARCH = 'search',
    READ_TAXONOMY = 'read_taxonomy',
    EXECUTE_SQL = 'execute_sql',
    TODO_WRITE = 'todo_write',
    // ... more tools
}
```

After modifying the schema, run `pnpm schema:build` to generate Python enums.

### Tool Organization

Tools are organized by product in the `products/` directory:

```
products/
├── data_warehouse/
│   └── backend/
│       └── max_tools.py         # ExecuteSQLTool
├── product_analytics/
│   └── backend/
│       └── max_tools.py         # CreateInsightTool, etc.
└── error_tracking/
    └── backend/
        └── max_tools.py         # ErrorTrackingTool
```

Each `max_tools.py` file imports and re-exports tools:

```python
# products/data_warehouse/backend/max_tools.py
from ee.hogai.tools.execute_sql import ExecuteSQLTool

__all__ = ["ExecuteSQLTool"]
```

## ToolMessagesArtifact

`ToolMessagesArtifact` allows tools to return multiple messages instead of a single response.

### Structure

```python
from pydantic import BaseModel
from collections.abc import Sequence
from ee.hogai.utils.types.base import AssistantMessageUnion

class ToolMessagesArtifact(BaseModel):
    """Return messages directly. Use with `artifact`."""
    messages: Sequence[AssistantMessageUnion]
```

### Use Cases

Use `ToolMessagesArtifact` when:

1. **Tool creates multiple UI artifacts** (e.g., query + visualization)
2. **Tool delegates to a sub-agent** that returns messages
3. **Tool needs to return structured conversation history**

### Example: Multiple Artifacts

```python
from uuid import uuid4
from posthog.schema import (
    AssistantToolCallMessage,
    ArtifactSource,
    ArtifactContentType
)
from ee.hogai.tool import ToolMessagesArtifact

class ExecuteSQLTool(MaxTool):
    async def _arun_impl(self, query: str) -> tuple[str, ToolMessagesArtifact | None]:
        # Parse and validate query
        parsed_query = self._parse_output({"query": query})

        # Create visualization artifact
        artifact = await self._context_manager.artifacts.create(
            content=VisualizationArtifactContent(query=parsed_query.query),
            name="SQL Query",
        )

        # Create artifact display message
        artifact_message = self._context_manager.artifacts.create_message(
            artifact_id=artifact.short_id,
            source=ArtifactSource.ARTIFACT,
            content_type=ArtifactContentType.VISUALIZATION,
        )

        # Execute query
        result = await execute_and_format_query(self._team, parsed_query.query)

        # Create result message
        result_message = AssistantToolCallMessage(
            content=result,
            id=str(uuid4()),
            tool_call_id=self.tool_call_id,
            ui_payload={self.get_name(): parsed_query.query.query},
        )

        # Return both messages
        return "", ToolMessagesArtifact(
            messages=[artifact_message, result_message]
        )
```

The frontend will receive both messages and can render them separately.

### Example: Sub-Agent Delegation

```python
from langchain_core.runnables import RunnableLambda
from ee.hogai.chat_agent.insights.nodes import InsightSearchNode

class InsightSearchTool(MaxSubtool):
    async def execute(self, query: str, tool_call_id: str) -> tuple[str, ToolMessagesArtifact | None]:
        # Create search node (a sub-agent)
        node = InsightSearchNode(self._team, self._user)

        # Update state with search query
        copied_state = self._state.model_copy(
            deep=True,
            update={
                "search_insights_query": query,
                "root_tool_call_id": tool_call_id
            }
        )

        # Run the sub-agent
        chain: RunnableLambda[AssistantState, PartialAssistantState | None] = RunnableLambda(node)
        result = await chain.ainvoke(copied_state)

        # Return the sub-agent's messages
        return "", ToolMessagesArtifact(messages=result.messages) if result else None
```

### Empty Content Pattern

When using `ToolMessagesArtifact`, the content (first element) is often empty:

```python
return "", ToolMessagesArtifact(messages=[...])
```

This is because the messages themselves contain the content. The empty string satisfies the return type but doesn't add redundant information.

## Error Types

The HogAI tool system has a sophisticated error hierarchy with retry strategies.

### Error Hierarchy

```python
from typing import Literal

class MaxToolError(Exception):
    """
    Base exception for MaxTool failures. All errors produce tool messages
    visible to LLM but not end users.

    Error Handling Strategy:
    - MaxToolFatalError: Show-stoppers that cannot be recovered from
    - MaxToolTransientError: Intermittent issues that can be retried without changes
    - MaxToolRetryableError: Solvable issues that can be fixed with adjusted inputs
    - Generic Exception: Unknown failures, treated as fatal (safety net)
    """

    def __init__(self, message: str):
        """
        Args:
            message: Detailed, actionable error message that helps the LLM
                     understand what went wrong
        """
        super().__init__(message)

    @property
    def retry_strategy(self) -> Literal["never", "once", "adjusted"]:
        """
        Returns the retry strategy for this error:
        - "never": Do not retry (fatal errors)
        - "once": Retry once without changes (transient errors)
        - "adjusted": Retry with adjusted inputs (solvable errors)
        """
        return "never"

    @property
    def retry_hint(self) -> str:
        """Returns the retry hint message to append to error messages for the LLM."""
        retry_hints = {
            "never": "",
            "once": " You may retry this operation once without changes.",
            "adjusted": " You may retry with adjusted inputs.",
        }
        return retry_hints[self.retry_strategy]

    def to_summary(self, max_length: int = 500) -> str:
        """
        Create a truncated summary for context management.

        Returns:
            Formatted string with exception class name and truncated message
        """
        exception_name = self.__class__.__name__
        exception_msg = str(self).strip()
        if len(exception_msg) > max_length:
            exception_msg = exception_msg[:max_length] + "…"
        return f"{exception_name}: {exception_msg}"
```

### MaxToolFatalError

**Never retry.** Used for unrecoverable errors.

```python
class MaxToolFatalError(MaxToolError):
    """
    Fatal error that cannot be recovered from. Do not retry.
    """

    @property
    def retry_strategy(self) -> Literal["never", "once", "adjusted"]:
        return "never"
```

**Examples:**

```python
# Missing configuration
if not settings.INKEEP_API_KEY:
    raise MaxToolFatalError(
        "Documentation search is not available: INKEEP_API_KEY environment "
        "variable is not configured."
    )

# Insufficient permissions
if not user.has_permission("create_insight"):
    raise MaxToolFatalError(
        "You do not have permission to create insights. Contact your admin."
    )

# Missing prerequisite data
try:
    insights = get_insights(team)
except NoInsightsException:
    raise MaxToolFatalError(
        "No insights available: The team has not created any insights yet. "
        "Insights must be created before they can be searched."
    )
```

### MaxToolTransientError

**Retry once without changes.** Used for temporary service issues.

```python
class MaxToolTransientError(MaxToolError):
    """
    Transient error due to temporary service issues.
    Can be retried once without changes.
    """

    @property
    def retry_strategy(self) -> Literal["never", "once", "adjusted"]:
        return "once"
```

**Examples:**

```python
# Rate limiting
if response.status_code == 429:
    raise MaxToolTransientError(
        "API rate limit exceeded. The request will be retried automatically."
    )

# Temporary network issues
if isinstance(error, TimeoutError):
    raise MaxToolTransientError(
        "Request timed out. This may be a temporary network issue."
    )

# Database lock
if "database is locked" in str(error):
    raise MaxToolTransientError(
        "Database is temporarily locked. Will retry shortly."
    )
```

### MaxToolRetryableError

**Retry with adjusted inputs.** Used for solvable errors where the LLM can fix the issue.

```python
class MaxToolRetryableError(MaxToolError):
    """
    Solvable error that can be fixed with adjusted inputs.
    Can be retried with corrections.
    """

    @property
    def retry_strategy(self) -> Literal["never", "once", "adjusted"]:
        return "adjusted"
```

**Examples:**

```python
# Invalid parameters
if kind not in VALID_KINDS:
    raise MaxToolRetryableError(
        f"Invalid entity kind: {kind}. Valid kinds are: {', '.join(VALID_KINDS)}. "
        "Please provide a valid entity kind."
    )

# Validation errors
try:
    validate_query(query)
except ValidationError as e:
    raise MaxToolRetryableError(
        f"Invalid query structure: {e}. Please adjust the query and try again."
    )

# SQL syntax errors
if "syntax error" in error_message:
    raise MaxToolRetryableError(
        f"SQL syntax error: {error_message}. Please fix the query syntax."
    )
```

### Error Handling Pattern

Tools should handle errors and convert them to appropriate error types:

```python
async def _arun_impl(self, query: str) -> tuple[str, Any]:
    try:
        # Attempt operation
        result = await self._execute_query(query)
        return f"Success: {result}", None

    except ValidationError as e:
        # Retryable: LLM can fix the input
        raise MaxToolRetryableError(
            f"Invalid query: {e}. Please adjust the query parameters."
        )

    except TimeoutError:
        # Transient: Retry without changes
        raise MaxToolTransientError(
            "Query timed out. This may be a temporary issue."
        )

    except PermissionError:
        # Fatal: Cannot be fixed
        raise MaxToolFatalError(
            "You do not have permission to execute queries."
        )

    except Exception as e:
        # Unknown: Treated as fatal by default
        logger.exception("Unexpected error in tool")
        raise MaxToolFatalError(
            f"Unexpected error: {e}. Please contact support."
        )
```

### Retry Hints in Error Messages

The `retry_hint` property automatically appends guidance to error messages:

```python
error = MaxToolRetryableError("Invalid parameter: foo")
print(error.retry_hint)
# Output: " You may retry with adjusted inputs."

error = MaxToolTransientError("Timeout")
print(error.retry_hint)
# Output: " You may retry this operation once without changes."

error = MaxToolFatalError("Missing API key")
print(error.retry_hint)
# Output: ""
```

### Error Summarization

For context management, errors can be summarized:

```python
error = MaxToolRetryableError("A" * 1000)  # Very long error message
summary = error.to_summary(max_length=50)
print(summary)
# Output: "MaxToolRetryableError: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA…"
```

## MaxSubtool Pattern

`MaxSubtool` is used for internal helper tools that are not directly exposed to the LLM.

### When to Use MaxSubtool

Use `MaxSubtool` when:

1. **Tool needs multiple implementations** (e.g., different search backends)
2. **Tool delegates to specialized helpers** (e.g., docs search vs entity search)
3. **Implementation complexity** requires separation of concerns
4. **Not directly called by LLM** (only called by parent tool)

### Structure

```python
from abc import ABC, abstractmethod
from ee.hogai.tool import MaxSubtool

class MaxSubtool(AssistantDispatcherMixin, ABC):
    _config: RunnableConfig

    def __init__(
        self,
        *,
        team: Team,
        user: User,
        state: AssistantState,
        config: RunnableConfig,
        context_manager: AssistantContextManager,
        node_path: tuple[NodePath, ...] | None = None,
    ):
        self._team = team
        self._user = user
        self._state = state
        self._context_manager = context_manager
        self._node_path = node_path or get_node_path() or ()

    @abstractmethod
    async def execute(self, *args, **kwargs) -> Any:
        """Subclasses must implement this method."""
        pass

    @property
    def node_name(self) -> str:
        return f"max_subtool.{self.__class__.__name__}"

    @property
    def node_path(self) -> tuple[NodePath, ...]:
        return self._node_path
```

### Example: Search Tool with Subtools

The `SearchTool` delegates to different subtools based on the search kind:

```python
from ee.hogai.tool import MaxTool, MaxSubtool, ToolMessagesArtifact

class SearchTool(MaxTool):
    name: Literal["search"] = "search"

    async def _arun_impl(self, kind: str, query: str) -> tuple[str, ToolMessagesArtifact | None]:
        # Delegate to docs search subtool
        if kind == "docs":
            docs_tool = InkeepDocsSearchTool(
                team=self._team,
                user=self._user,
                state=self._state,
                config=self._config,
                context_manager=self._context_manager,
            )
            return await docs_tool.execute(query, self.tool_call_id)

        # Delegate to insights search subtool
        if kind == "insights":
            insights_tool = InsightSearchTool(
                team=self._team,
                user=self._user,
                state=self._state,
                config=self._config,
                context_manager=self._context_manager,
            )
            return await insights_tool.execute(query, self.tool_call_id)

        # Delegate to entity search subtool
        entity_search_tool = EntitySearchTool(
            team=self._team,
            user=self._user,
            state=self._state,
            config=self._config,
            context_manager=self._context_manager,
        )
        response = await entity_search_tool.execute(query, FTSKind(kind))
        return response, None
```

### Example: Docs Search Subtool

```python
from django.conf import settings
from langchain_openai import ChatOpenAI
from langchain_core.output_parsers import SimpleJsonOutputParser
from langchain_core.prompts import ChatPromptTemplate

class InkeepDocsSearchTool(MaxSubtool):
    async def execute(self, query: str, tool_call_id: str) -> tuple[str, ToolMessagesArtifact | None]:
        # Create LLM with custom endpoint
        model = ChatOpenAI(
            model="inkeep-rag",
            base_url="https://api.inkeep.com/v1/",
            api_key=settings.INKEEP_API_KEY,
            streaming=False,
        )

        # Build chain
        prompt = ChatPromptTemplate.from_messages([("user", "{query}")])
        chain = prompt | model | SimpleJsonOutputParser()

        # Execute search
        rag_context_raw = await chain.ainvoke({"query": query})

        if not rag_context_raw or not rag_context_raw.get("content"):
            return DOCS_SEARCH_NO_RESULTS_TEMPLATE, None

        # Parse and format results
        rag_context = InkeepResponse.model_validate(rag_context_raw)
        docs = []
        for doc in rag_context.content:
            if doc.type != "document":
                continue
            text = doc.source.content[0].text if doc.source.content else ""
            docs.append(DOC_ITEM_TEMPLATE.format(
                title=doc.title,
                url=doc.url,
                text=text
            ))

        if not docs:
            return DOCS_SEARCH_NO_RESULTS_TEMPLATE, None

        formatted_docs = "\n\n---\n\n".join(docs)
        return DOCS_SEARCH_RESULTS_TEMPLATE.format(
            count=len(docs),
            docs=formatted_docs
        ), None
```

### Example: Entity Search Subtool

```python
from posthog.api.search import search_entities
from posthog.sync import database_sync_to_async

class EntitySearchTool(MaxSubtool):
    MAX_ENTITY_RESULTS = 10

    async def execute(self, query: str, search_kind: FTSKind) -> str:
        """Search for entities by query and kind."""
        try:
            if not query:
                return "No search query was provided"

            # Determine entity types to search
            if search_kind == FTSKind.ALL:
                entity_types = set(ENTITY_MAP.keys())
            elif search_kind in SEARCH_KIND_TO_DATABASE_ENTITY_TYPE:
                entity_types = {SEARCH_KIND_TO_DATABASE_ENTITY_TYPE[search_kind]}
            else:
                return f"Invalid entity kind: {search_kind}"

            # Execute search (sync function, run in thread)
            results, counts = await database_sync_to_async(
                search_entities,
                thread_sensitive=False
            )(
                entity_types,
                query,
                self._team.project_id,
                self,  # type: ignore
                ENTITY_MAP,
            )

            # Format results
            content = self._format_results_for_display(
                query, entity_types, results, counts
            )
            return content

        except Exception as e:
            capture_exception(e, distinct_id=self._user.distinct_id)
            return f"Error searching entities: {str(e)}"

    def _format_results_for_display(
        self,
        query: str,
        entity_types: set[str],
        results: dict,
        counts: dict
    ) -> str:
        # Implementation details...
        pass
```

### Key Differences from MaxTool

| Feature | MaxTool | MaxSubtool |
|---------|---------|------------|
| **LLM visibility** | Registered, callable by LLM | Internal only |
| **Auto-registration** | Yes (via `__init_subclass__`) | No |
| **Base class** | `BaseTool` (LangChain) | `ABC` (Python) |
| **Method signature** | `_arun_impl(*args, **kwargs)` | `execute(*args, **kwargs)` |
| **Context wrapping** | Automatic (via `_arun_with_context`) | Manual |
| **Node path** | Auto-extends parent path | Inherits from constructor |

## Complete Example

Here's a complete, production-ready tool implementation:

```python
"""
Weather lookup tool for HogAI.

This tool allows the LLM to fetch current weather data for a given location.
"""
from typing import Literal, Self
from pydantic import BaseModel, Field
from langchain_core.runnables import RunnableConfig

from posthog.models import Team, User
from ee.hogai.tool import MaxTool
from ee.hogai.tool_errors import (
    MaxToolFatalError,
    MaxToolRetryableError,
    MaxToolTransientError,
)
from ee.hogai.context.context import AssistantContextManager
from ee.hogai.utils.types.base import AssistantState, NodePath

# Third-party library
import httpx

# === 1. Define arguments schema ===

class GetWeatherToolArgs(BaseModel):
    """Arguments for the get_weather tool."""

    location: str = Field(
        description=(
            "The location to get weather for. Can be a city name, "
            "ZIP code, or 'latitude,longitude' coordinates."
        )
    )
    units: Literal["metric", "imperial"] = Field(
        default="metric",
        description="Temperature units (metric for Celsius, imperial for Fahrenheit)"
    )


# === 2. Define the tool ===

class GetWeatherTool(MaxTool):
    """
    Fetches current weather data for a given location.

    Uses the OpenWeatherMap API to retrieve temperature, conditions,
    humidity, and wind speed.
    """

    # Tool identifier (must exist in AssistantTool enum)
    name: Literal["get_weather"] = "get_weather"

    # Pydantic schema for arguments
    args_schema: type[BaseModel] = GetWeatherToolArgs

    # Context prompt template (for root node guidance)
    context_prompt_template: str = (
        "Retrieves current weather data including temperature, conditions, "
        "humidity, and wind speed for any location worldwide"
    )

    # This tool doesn't trigger billable LLM generations
    billable: bool = False

    # API configuration
    API_BASE_URL = "https://api.openweathermap.org/data/2.5/weather"
    TIMEOUT_SECONDS = 10

    # === 3. Factory method (optional, for dynamic configuration) ===

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
        Factory method for creating the tool.

        Can be overridden to customize behavior based on team/user context.
        """
        # Check if team has API key configured
        context_manager = context_manager or AssistantContextManager(team, user, config)
        tools_context = context_manager.get_contextual_tools()
        weather_context = tools_context.get("get_weather", {})

        if not weather_context.get("api_key"):
            # Tool will fail at runtime, but we still return it
            # (so LLM can see the error message)
            pass

        return cls(
            team=team,
            user=user,
            node_path=node_path,
            state=state,
            config=config,
            context_manager=context_manager,
        )

    # === 4. Implementation ===

    async def _arun_impl(
        self,
        location: str,
        units: Literal["metric", "imperial"]
    ) -> tuple[str, dict | None]:
        """
        Fetch weather data and return formatted response.

        Args:
            location: The location to get weather for
            units: Temperature units (metric or imperial)

        Returns:
            tuple[str, dict | None]: (text_content, ui_artifact)

        Raises:
            MaxToolFatalError: If API key is not configured
            MaxToolRetryableError: If location is invalid
            MaxToolTransientError: If API is temporarily unavailable
        """
        # Get API key from context
        api_key = self.context.get("api_key")
        if not api_key:
            raise MaxToolFatalError(
                "Weather API is not configured. Please contact your admin to "
                "set up the OpenWeatherMap API key."
            )

        # Validate location
        if not location or not location.strip():
            raise MaxToolRetryableError(
                "Location cannot be empty. Please provide a valid city name, "
                "ZIP code, or coordinates."
            )

        # Make API request
        try:
            weather_data = await self._fetch_weather(location, units, api_key)
        except MaxToolError:
            # Re-raise our custom errors
            raise
        except Exception as e:
            # Unexpected errors become fatal
            raise MaxToolFatalError(
                f"Unexpected error fetching weather data: {e}"
            )

        # Format response
        content = self._format_weather_response(weather_data, units)
        artifact = self._create_weather_artifact(weather_data, units)

        return content, artifact

    async def _fetch_weather(
        self,
        location: str,
        units: str,
        api_key: str
    ) -> dict:
        """
        Make HTTP request to weather API.

        Raises:
            MaxToolRetryableError: Invalid location
            MaxToolTransientError: Temporary API issues
            MaxToolFatalError: API key invalid
        """
        params = {
            "q": location,
            "units": units,
            "appid": api_key,
        }

        async with httpx.AsyncClient() as client:
            try:
                response = await client.get(
                    self.API_BASE_URL,
                    params=params,
                    timeout=self.TIMEOUT_SECONDS,
                )

                # Handle different error cases
                if response.status_code == 404:
                    raise MaxToolRetryableError(
                        f"Location '{location}' not found. Please check the spelling "
                        f"or try a different location format (e.g., 'London,UK')."
                    )

                if response.status_code == 401:
                    raise MaxToolFatalError(
                        "Weather API key is invalid. Please contact your admin."
                    )

                if response.status_code == 429:
                    raise MaxToolTransientError(
                        "Weather API rate limit exceeded. Please try again in a moment."
                    )

                if response.status_code >= 500:
                    raise MaxToolTransientError(
                        f"Weather API is temporarily unavailable (HTTP {response.status_code}). "
                        f"Please try again later."
                    )

                response.raise_for_status()
                return response.json()

            except httpx.TimeoutException:
                raise MaxToolTransientError(
                    f"Weather API request timed out after {self.TIMEOUT_SECONDS}s. "
                    f"Please try again."
                )

            except httpx.RequestError as e:
                raise MaxToolTransientError(
                    f"Network error while fetching weather data: {e}"
                )

    def _format_weather_response(self, data: dict, units: str) -> str:
        """Format weather data as human-readable text for LLM."""
        temp_unit = "°C" if units == "metric" else "°F"

        location_name = data["name"]
        country = data["sys"]["country"]
        temp = data["main"]["temp"]
        feels_like = data["main"]["feels_like"]
        condition = data["weather"][0]["description"]
        humidity = data["main"]["humidity"]
        wind_speed = data["wind"]["speed"]
        wind_unit = "m/s" if units == "metric" else "mph"

        return (
            f"Current weather in {location_name}, {country}:\n"
            f"- Temperature: {temp}{temp_unit} (feels like {feels_like}{temp_unit})\n"
            f"- Conditions: {condition}\n"
            f"- Humidity: {humidity}%\n"
            f"- Wind: {wind_speed} {wind_unit}"
        )

    def _create_weather_artifact(self, data: dict, units: str) -> dict:
        """Create structured artifact for UI display."""
        return {
            "location": {
                "name": data["name"],
                "country": data["sys"]["country"],
                "coordinates": {
                    "lat": data["coord"]["lat"],
                    "lon": data["coord"]["lon"],
                }
            },
            "current": {
                "temperature": data["main"]["temp"],
                "feels_like": data["main"]["feels_like"],
                "temp_min": data["main"]["temp_min"],
                "temp_max": data["main"]["temp_max"],
                "humidity": data["main"]["humidity"],
                "pressure": data["main"]["pressure"],
            },
            "conditions": {
                "main": data["weather"][0]["main"],
                "description": data["weather"][0]["description"],
                "icon": data["weather"][0]["icon"],
            },
            "wind": {
                "speed": data["wind"]["speed"],
                "deg": data["wind"].get("deg"),
            },
            "units": units,
            "timestamp": data["dt"],
        }


# === 5. Export ===

__all__ = ["GetWeatherTool", "GetWeatherToolArgs"]
```

### Using the Tool

The tool is automatically registered and can be used by the LLM:

```python
# The LLM will call it like this:
{
  "name": "get_weather",
  "arguments": {
    "location": "San Francisco",
    "units": "imperial"
  }
}

# The tool returns:
(
  "Current weather in San Francisco, US:\n"
  "- Temperature: 72°F (feels like 70°F)\n"
  "- Conditions: clear sky\n"
  "- Humidity: 65%\n"
  "- Wind: 8.5 mph",

  {
    "location": {"name": "San Francisco", "country": "US", ...},
    "current": {"temperature": 72, "feels_like": 70, ...},
    ...
  }
)
```

---

## Summary

The PostHog HogAI tool system provides:

1. **MaxTool** - Base class for LLM-callable tools with LangChain integration
2. **Tool Definition Pattern** - Pydantic schemas + `_arun_impl` method
3. **Factory Method** - Dynamic configuration via `create_tool_class`
4. **Auto-Registration** - Metaclass-based discovery and validation
5. **ToolMessagesArtifact** - Multi-message returns for complex responses
6. **Error Types** - Sophisticated retry strategies (fatal/transient/retryable)
7. **MaxSubtool** - Internal helper pattern for delegation

This architecture enables:
- Type-safe tool definitions
- Automatic frontend/backend synchronization
- Intelligent error handling
- Rich UI artifacts
- Flexible tool composition
- Comprehensive execution tracking

To add a new tool:

1. Define `args_schema` (Pydantic model)
2. Create tool class extending `MaxTool`
3. Implement `_arun_impl` method
4. Add tool name to `AssistantTool` enum
5. Place in `products/{product}/backend/max_tools.py`

The tool will automatically register and become available to the LLM.
