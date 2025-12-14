# PostHog HogAI Example Tool Implementations

This document analyzes four representative tool implementations from PostHog HogAI, showcasing different architectural patterns for building LangChain tools.

## Table of Contents

1. [SearchTool - Delegate Pattern](#1-searchtool---delegate-pattern)
2. [CreateInsightTool - Subgraph Execution Pattern](#2-createinsighttool---subgraph-execution-pattern)
3. [ExecuteSQLTool - Artifact Creation Pattern](#3-executesqltool---artifact-creation-pattern)
4. [SwitchModeTool - Dynamic Schema Generation Pattern](#4-switchmodetool---dynamic-schema-generation-pattern)
5. [Common Patterns and Best Practices](#common-patterns-and-best-practices)

---

## 1. SearchTool - Delegate Pattern

The SearchTool demonstrates a **delegation pattern** where a single tool routes to multiple specialized subtools based on input parameters.

### Key Characteristics

- **Pattern**: Router/Delegate
- **Purpose**: Unified search interface across documentation, insights, and entity types
- **Routing**: Based on `kind` parameter (docs, insights, or FTS entity types)
- **Subtools**: `InkeepDocsSearchTool`, `InsightSearchTool`, `EntitySearchTool`

### Complete Implementation

```python
from typing import Literal
from pydantic import BaseModel, Field
from ee.hogai.tool import MaxTool, MaxSubtool, ToolMessagesArtifact

# Dynamically build SearchKind from entity types
ENTITIES = [f"{entity}" for entity in FTSKind if entity != FTSKind.INSIGHTS]
SearchKind = Literal["insights", "docs", *ENTITIES]  # type: ignore

class SearchToolArgs(BaseModel):
    kind: SearchKind = Field(description="Select the entity you want to find")
    query: str = Field(
        description="Describe what you want to find. Include as much details from the context as possible."
    )

class SearchTool(MaxTool):
    name: Literal["search"] = "search"
    description: str = SEARCH_TOOL_PROMPT
    context_prompt_template: str = "Searches documentation, insights, dashboards, cohorts, actions..."
    args_schema: type[BaseModel] = SearchToolArgs

    async def _arun_impl(self, kind: str, query: str) -> tuple[str, ToolMessagesArtifact | None]:
        # Route to docs search
        if kind == "docs":
            if not settings.INKEEP_API_KEY:
                raise MaxToolFatalError(
                    "Documentation search is not available: INKEEP_API_KEY environment variable is not configured."
                )
            docs_tool = InkeepDocsSearchTool(
                team=self._team,
                user=self._user,
                state=self._state,
                config=self._config,
                context_manager=self._context_manager,
            )
            return await docs_tool.execute(query, self.tool_call_id)

        # Route to insights search (if feature flag disabled)
        if kind == "insights" and not self._has_insights_fts_search_feature_flag():
            insights_tool = InsightSearchTool(
                team=self._team,
                user=self._user,
                state=self._state,
                config=self._config,
                context_manager=self._context_manager,
            )
            return await insights_tool.execute(query, self.tool_call_id)

        # Validate entity kind
        if kind not in self._fts_entities:
            raise MaxToolRetryableError(INVALID_ENTITY_KIND_PROMPT.format(kind=kind))

        # Route to entity search
        entity_search_toolkit = EntitySearchTool(
            team=self._team,
            user=self._user,
            state=self._state,
            config=self._config,
            context_manager=self._context_manager,
        )
        response = await entity_search_toolkit.execute(query, FTSKind(kind))
        return response, None

    @property
    def _fts_entities(self) -> list[str]:
        entities = list(FTSKind)
        return [*entities, FTSKind.ALL]

    def _has_insights_fts_search_feature_flag(self) -> bool:
        return posthoganalytics.feature_enabled(
            "hogai-insights-fts-search",
            str(self._user.distinct_id),
            groups={"organization": str(self._team.organization_id)},
            group_properties={"organization": {"id": str(self._team.organization_id)}},
            send_feature_flag_events=False,
        )
```

### Subtool Example: InkeepDocsSearchTool

```python
class InkeepDocsSearchTool(MaxSubtool):
    async def execute(self, query: str, tool_call_id: str) -> tuple[str, ToolMessagesArtifact | None]:
        # Use Inkeep's RAG API
        model = ChatOpenAI(
            model="inkeep-rag",
            base_url="https://api.inkeep.com/v1/",
            api_key=settings.INKEEP_API_KEY,
            streaming=False,
            stream_usage=False,
            disable_streaming=True,
        )

        prompt = ChatPromptTemplate.from_messages([("user", "{query}")])
        chain = prompt | model | SimpleJsonOutputParser()
        rag_context_raw = await chain.ainvoke({"query": query})

        if not rag_context_raw or not rag_context_raw.get("content"):
            return DOCS_SEARCH_NO_RESULTS_TEMPLATE, None

        rag_context = InkeepResponse.model_validate(rag_context_raw)

        # Format docs for display
        docs = []
        for doc in rag_context.content:
            if doc.type != "document":
                continue
            text = doc.source.content[0].text if doc.source.content else ""
            docs.append(DOC_ITEM_TEMPLATE.format(title=doc.title, url=doc.url, text=text))

        if not docs:
            return DOCS_SEARCH_NO_RESULTS_TEMPLATE, None

        formatted_docs = "\n\n---\n\n".join(docs)
        return DOCS_SEARCH_RESULTS_TEMPLATE.format(count=len(docs), docs=formatted_docs), None
```

### Why This Pattern?

1. **Unified Interface**: Single `search` tool for LLM to call, reducing decision complexity
2. **Backend Flexibility**: Different search backends (Inkeep, PostgreSQL FTS, custom insight search) hidden from LLM
3. **Feature Flags**: Easy to A/B test different search implementations
4. **Extensibility**: Add new entity types by updating `FTSKind` enum and routing logic
5. **Error Handling**: Centralized validation and feature availability checks

### MaxSubtool Base Class

Subtools don't inherit from `BaseTool` - they're lightweight executors:

```python
class MaxSubtool(AssistantDispatcherMixin, ABC):
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
        pass
```

---

## 2. CreateInsightTool - Subgraph Execution Pattern

CreateInsightTool demonstrates **embedding a complete LangGraph within a tool**, where the tool orchestrates a multi-node workflow to generate and execute insights.

### Key Characteristics

- **Pattern**: Subgraph Orchestration
- **Purpose**: Generate insights from natural language plans, execute queries, return visualization
- **Workflow**: Plan → Schema Generation → Query Execution → Artifact Creation
- **Graph**: `InsightsGraph` with different generator nodes (trends/funnel/retention)

### Complete Implementation

```python
from typing import Literal
from pydantic import BaseModel, Field
from ee.hogai.tool import MaxTool, ToolMessagesArtifact
from ee.hogai.chat_agent.insights_graph.graph import InsightsGraph
from ee.hogai.utils.types.base import AssistantNodeName

InsightType = Literal["trends", "funnel", "retention"]

class CreateInsightToolArgs(BaseModel):
    title: str = Field(description="A short title for the insight.")
    query_description: str = Field(description="A plan of the query to generate based on the template.")
    insight_type: InsightType = Field(description="The type of insight to generate.")

class CreateInsightTool(MaxTool):
    name: Literal["create_insight"] = "create_insight"
    args_schema: type[BaseModel] = CreateInsightToolArgs
    context_prompt_template: str = INSIGHT_TOOL_CONTEXT_PROMPT_TEMPLATE

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
        # Dynamically format prompt with team's group names
        context_manager = context_manager or AssistantContextManager(team, user, config)
        prompt = format_prompt_string(
            INSIGHT_TOOL_PROMPT,
            groups=await context_manager.get_group_names(),
        )
        return cls(team=team, user=user, state=state, node_path=node_path, config=config, description=prompt)

    async def _arun_impl(
        self, title: str, query_description: str, insight_type: InsightType
    ) -> tuple[str, ToolMessagesArtifact | None]:
        # Build graph based on insight type
        graph_builder = InsightsGraph(self._team, self._user)
        match insight_type:
            case "trends":
                graph_builder.add_trends_generator().add_edge(
                    AssistantNodeName.START, AssistantNodeName.TRENDS_GENERATOR
                )
            case "funnel":
                graph_builder.add_funnel_generator().add_edge(
                    AssistantNodeName.START, AssistantNodeName.FUNNEL_GENERATOR
                )
            case "retention":
                graph_builder.add_retention_generator().add_edge(
                    AssistantNodeName.START, AssistantNodeName.RETENTION_GENERATOR
                )

        # Add query executor and compile graph
        graph = graph_builder.add_query_executor().compile()

        # Create new state for graph execution
        new_state = self._state.model_copy(
            update={
                "root_tool_call_id": self.tool_call_id,
                "plan": query_description,
                "visualization_title": title,
            },
            deep=True,
        )

        try:
            dict_state = await graph.ainvoke(new_state)
        except SchemaGenerationException as e:
            # Handle validation errors with formatted prompts
            return format_prompt_string(
                INSIGHT_TOOL_HANDLED_FAILURE_PROMPT,
                output=e.llm_output,
                error_message=e.validation_message,
                system_reminder=INSIGHT_TOOL_FAILURE_SYSTEM_REMINDER_PROMPT,
            ), None

        # Extract messages from graph execution
        updated_state = AssistantState.model_validate(dict_state)
        maybe_viz_message, tool_call_message = updated_state.messages[-2:]

        if not isinstance(tool_call_message, AssistantToolCallMessage):
            return format_prompt_string(
                INSIGHT_TOOL_UNHANDLED_FAILURE_PROMPT,
                system_reminder=INSIGHT_TOOL_FAILURE_SYSTEM_REMINDER_PROMPT
            ), None

        # If previous message isn't visualization, agent requested human feedback
        if not is_visualization_artifact_message(maybe_viz_message):
            return "", ToolMessagesArtifact(messages=[tool_call_message])

        # Retrieve visualization artifact content
        visualization_content = await self._context_manager.artifacts.aget_content_by_short_id(
            maybe_viz_message.artifact_id
        )

        # If editing mode, add UI payload to tool call message
        if self.is_editing_mode(self._context_manager):
            tool_call_message = AssistantToolCallMessage(
                content=tool_call_message.content,
                ui_payload={self.get_name(): visualization_content.query.model_dump(exclude_none=True)},
                id=tool_call_message.id,
                tool_call_id=tool_call_message.tool_call_id,
            )

        return "", ToolMessagesArtifact(messages=[maybe_viz_message, tool_call_message])

    @classmethod
    def is_editing_mode(cls, context_manager: AssistantContextManager) -> bool:
        """Determines if the tool is in editing mode."""
        return AssistantTool.CREATE_INSIGHT.value in context_manager.get_contextual_tools()
```

### Why This Pattern?

1. **Complex Workflows**: Insight generation involves multiple steps (schema generation, validation, execution)
2. **Type Safety**: Different insight types (trends/funnel/retention) have different schemas and validation rules
3. **State Isolation**: Graph gets a copied state, preventing pollution of main conversation state
4. **Error Recovery**: Structured error handling with prompts that guide LLM to retry
5. **Composability**: Graph nodes are reusable across different tools
6. **Context Preservation**: Uses `root_tool_call_id` to track which tool triggered the graph

### Graph Structure Example

```python
# Simplified InsightsGraph structure
class InsightsGraph:
    def add_trends_generator(self):
        # Adds node that generates trends query schema from natural language
        # Uses LLM to convert plan → PostHog trends query JSON
        return self

    def add_query_executor(self):
        # Adds node that executes query and formats results
        # Handles errors, rate limits, formatting
        return self

    def compile(self):
        # Returns executable LangGraph
        return self.graph.compile()
```

### Message Artifact Pattern

Tools return `ToolMessagesArtifact` to inject multiple messages:

```python
class ToolMessagesArtifact(BaseModel):
    """Return messages directly. Use with `artifact`."""
    messages: Sequence[AssistantMessageUnion]

# Usage:
return "", ToolMessagesArtifact(messages=[
    visualization_message,  # Shows chart to user
    tool_call_message,      # Contains query results for LLM
])
```

---

## 3. ExecuteSQLTool - Artifact Creation Pattern

ExecuteSQLTool demonstrates **creating and managing artifacts** (persistent objects that represent query results, visualizations, etc).

### Key Characteristics

- **Pattern**: Artifact Creation and Management
- **Purpose**: Execute HogQL queries and return results as visualization artifacts
- **Artifacts**: `VisualizationArtifactContent` with query and results
- **UI Integration**: Artifacts can be displayed, edited, shared

### Complete Implementation

```python
from uuid import uuid4
from pydantic import BaseModel, Field
from posthog.schema import ArtifactContentType, ArtifactSource, AssistantToolCallMessage, VisualizationArtifactContent
from ee.hogai.tool import MaxTool, ToolMessagesArtifact
from ee.hogai.chat_agent.sql.mixins import HogQLGeneratorMixin

class ExecuteSQLToolArgs(BaseModel):
    query: str = Field(description="The final SQL query to be executed.")

class ExecuteSQLTool(HogQLGeneratorMixin, MaxTool):
    name: str = "execute_sql"
    args_schema: type[BaseModel] = ExecuteSQLToolArgs
    context_prompt_template: str = SQL_ASSISTANT_ROOT_SYSTEM_PROMPT
    show_tool_call_message: bool = False  # Hide intermediate message from UI

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
        # Format prompt with SQL documentation
        prompt = format_prompt_string(
            EXECUTE_SQL_SYSTEM_PROMPT,
            sql_expressions_docs=SQL_EXPRESSIONS_DOCS,
            sql_supported_functions_docs=SQL_SUPPORTED_FUNCTIONS_DOCS,
            sql_supported_aggregations_docs=SQL_SUPPORTED_AGGREGATIONS_DOCS,
        )
        return cls(team=team, user=user, state=state, node_path=node_path, config=config, description=prompt)

    async def _arun_impl(self, query: str) -> tuple[str, ToolMessagesArtifact | None]:
        # Parse and validate query using mixin
        parsed_query = self._parse_output({"query": query})
        try:
            await self._quality_check_output(output=parsed_query)
        except PydanticOutputParserException as e:
            return format_prompt_string(EXECUTE_SQL_RECOVERABLE_ERROR_PROMPT, error=str(e)), None

        # Create artifact for the visualization
        artifact = await self._context_manager.artifacts.create(
            content=VisualizationArtifactContent(query=parsed_query.query),
            name="SQL Query",
        )

        # Create message to display artifact to user
        artifact_message = self._context_manager.artifacts.create_message(
            artifact_id=artifact.short_id,
            source=ArtifactSource.ARTIFACT,
            content_type=ArtifactContentType.VISUALIZATION,
        )

        # Execute query and format results
        try:
            result = await execute_and_format_query(self._team, parsed_query.query)
        except MaxToolRetryableError as e:
            return format_prompt_string(EXECUTE_SQL_RECOVERABLE_ERROR_PROMPT, error=str(e)), None
        except Exception:
            return EXECUTE_SQL_UNRECOVERABLE_ERROR_PROMPT, None

        # Return both artifact message (for UI) and tool call message (for LLM)
        return "", ToolMessagesArtifact(
            messages=[
                artifact_message,
                AssistantToolCallMessage(
                    content=result,  # Formatted query results for LLM
                    id=str(uuid4()),
                    tool_call_id=self.tool_call_id,
                    ui_payload={self.get_name(): parsed_query.query.query},  # Raw query for UI
                ),
            ]
        )
```

### Mixin: HogQLGeneratorMixin

The mixin provides query parsing and validation:

```python
class HogQLGeneratorMixin:
    def _parse_output(self, output: dict) -> ParsedQuery:
        """Parse LLM output into structured query."""
        # Validates query syntax, structure
        pass

    async def _quality_check_output(self, output: ParsedQuery):
        """Validate query quality and safety."""
        # Checks for dangerous operations, validates schema
        pass
```

### Why This Pattern?

1. **Persistent Results**: Artifacts survive beyond conversation (shareable, editable)
2. **UI Integration**: `artifact_message` tells UI to render visualization component
3. **Dual Payload**: LLM sees formatted results text, UI sees structured query
4. **Quality Gates**: Parsing and validation before execution prevents bad queries
5. **Error Recovery**: Retryable vs unrecoverable errors guide LLM behavior
6. **Mixins**: Reusable validation logic across SQL-related tools

### Artifact Lifecycle

```python
# 1. Create artifact
artifact = await context_manager.artifacts.create(
    content=VisualizationArtifactContent(query=parsed_query),
    name="SQL Query"
)

# 2. Create message referencing artifact
artifact_message = context_manager.artifacts.create_message(
    artifact_id=artifact.short_id,
    source=ArtifactSource.ARTIFACT,
    content_type=ArtifactContentType.VISUALIZATION,
)

# 3. Later: retrieve artifact
artifact = await context_manager.artifacts.aget_content_by_short_id(artifact.short_id)
```

---

## 4. SwitchModeTool - Dynamic Schema Generation Pattern

SwitchModeTool demonstrates **dynamic schema generation** where the tool's argument schema is generated at runtime based on available modes.

### Key Characteristics

- **Pattern**: Dynamic Schema with `create_model()`
- **Purpose**: Switch between specialized agent modes (product_analytics, sql, etc)
- **Schema**: Generated using Pydantic's `create_model()` with `Literal` type from mode registry
- **Factory**: Requires `create_tool_class` to build schema before instantiation

### Complete Implementation

```python
from typing import Literal, cast
from pydantic import BaseModel, Field, create_model
from posthog.schema import AgentMode
from ee.hogai.tool import MaxTool

SwitchModeToolType = Literal["switch_mode"]
SWITCH_MODE_TOOL_NAME: SwitchModeToolType = "switch_mode"

class SwitchModeTool(MaxTool):
    name: SwitchModeToolType = SWITCH_MODE_TOOL_NAME
    _mode_registry: dict[AgentMode, "AgentModeDefinition"]

    async def _arun_impl(self, new_mode: str) -> tuple[str, AgentMode | None]:
        # Validate mode exists
        if new_mode not in self._mode_registry:
            available = ", ".join(self._mode_registry.keys())
            return (
                format_prompt_string(
                    SWITCH_MODE_FAILURE_PROMPT,
                    new_mode=new_mode,
                    available_modes=available
                ),
                self._state.agent_mode,
            )

        # Return new mode as artifact
        return format_prompt_string(SWITCH_MODE_TOOL_PROMPT, new_mode=new_mode), cast(AgentMode, new_mode)

    @classmethod
    async def create_tool_class(
        cls,
        *,
        team: Team,
        user: User,
        mode_registry: dict[AgentMode, "AgentModeDefinition"] | None = None,
        default_tool_classes: list[type["MaxTool"]] | None = None,
        node_path: tuple[NodePath, ...] | None = None,
        state: AssistantState | None = None,
        config: RunnableConfig | None = None,
        context_manager: AssistantContextManager | None = None,
    ) -> Self:
        if mode_registry is None or default_tool_classes is None:
            raise ValueError("SwitchModeTool requires mode_registry and default_tool_classes parameters")

        # Build context manager
        context_manager = AssistantContextManager(team, user, config)

        # Generate prompts describing available tools and modes
        default_tools, available_modes = await asyncio.gather(
            _get_default_tools_prompt(
                team=team,
                user=user,
                state=state,
                config=config,
                default_tool_classes=default_tool_classes
            ),
            _get_modes_prompt(
                team=team,
                user=user,
                state=state,
                config=config,
                context_manager=context_manager,
                mode_registry=mode_registry,
            ),
        )

        # Format description with available modes and tools
        description_prompt = format_prompt_string(
            SWITCH_MODE_PROMPT,
            default_tools=default_tools,
            available_modes=available_modes
        )

        # Store registry as class variable
        cls._mode_registry = mode_registry

        # Dynamically create Literal type from mode registry keys
        ModeKind = Literal[*mode_registry.keys()]  # type: ignore

        # Dynamically create args schema
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

### Dynamic Schema Generation

```python
# Before: hardcoded schema
class SwitchModeToolArgs(BaseModel):
    new_mode: Literal["product_analytics", "sql"] = Field(...)

# After: dynamic schema from registry
mode_registry = {
    AgentMode.PRODUCT_ANALYTICS: product_analytics_definition,
    AgentMode.SQL: sql_definition,
    AgentMode.WEB_ANALYTICS: web_analytics_definition,
}

ModeKind = Literal[*mode_registry.keys()]  # Literal["product_analytics", "sql", "web_analytics"]

args_schema = create_model(
    "SwitchModeToolArgs",
    __base__=BaseModel,
    new_mode=(ModeKind, Field(description="The name of the mode to switch to.")),
)
```

### Helper Functions

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

    # Instantiate all tools from all modes in parallel
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

    # Wait for all tools to be created
    resolved_tools = await asyncio.gather(*all_futures)

    # Format mode descriptions with their tools
    formatted_modes: list[str] = []
    for definition, tools in zip(mode_registry.values(), resolved_tools):
        formatted_modes.append(
            f"- {definition.mode.value} – {definition.mode_description}. "
            f"[Mode tools: {', '.join([tool.get_name() for tool in tools])}]"
        )

    return "\n".join(formatted_modes)

async def _get_default_tools_prompt(
    *,
    team: Team,
    user: User,
    state: AssistantState | None = None,
    config: RunnableConfig | None = None,
    default_tool_classes: list[type["MaxTool"]],
) -> str:
    """Get the prompt containing the description of the default tools."""
    resolved_tools = await asyncio.gather(
        *[
            tool_class.create_tool_class(team=team, user=user, state=state, config=config)
            for tool_class in default_tool_classes
            if tool_class != SwitchModeTool
        ]
    )
    return ", ".join([tool.get_name() for tool in resolved_tools]) + ", switch_mode"
```

### Why This Pattern?

1. **Extensibility**: Add new modes without modifying tool code
2. **Type Safety**: LLM constrained to valid modes via `Literal` type
3. **Self-Documenting**: Description includes all modes and their tools
4. **Registry Pattern**: Central source of truth for available modes
5. **Lazy Evaluation**: Tools only instantiated when needed
6. **Context Awareness**: Description shows which tools are available in which mode

### Mode Registry Structure

```python
@dataclass
class AgentModeDefinition:
    mode: AgentMode
    mode_description: str
    toolkit_class: type[BaseToolkit]
    # ... other configuration

mode_registry = {
    AgentMode.PRODUCT_ANALYTICS: AgentModeDefinition(
        mode=AgentMode.PRODUCT_ANALYTICS,
        mode_description="Analyze product usage with trends, funnels, retention",
        toolkit_class=ProductAnalyticsToolkit,
    ),
    AgentMode.SQL: AgentModeDefinition(
        mode=AgentMode.SQL,
        mode_description="Query data using SQL",
        toolkit_class=SQLToolkit,
    ),
}
```

---

## Common Patterns and Best Practices

### 1. Tool Return Types

All tools return `tuple[str, Any]`:

```python
async def _arun_impl(self, ...) -> tuple[str, ToolMessagesArtifact | None]:
    # Return (content_for_llm, artifact_for_system)
    return "Query executed successfully", ToolMessagesArtifact(messages=[...])

    # Or just content
    return "No results found", None
```

### 2. Error Handling Strategy

**Retryable Errors**: LLM can fix by adjusting parameters

```python
raise MaxToolRetryableError(
    "Invalid property name 'xyz'. Available properties: abc, def"
)
```

**Fatal Errors**: Configuration/permission issues

```python
raise MaxToolFatalError(
    "Database connection failed. Contact administrator."
)
```

**Guided Recovery**: Return prompt suggesting next steps

```python
return format_prompt_string(
    RECOVERABLE_ERROR_PROMPT,
    error=str(e),
    suggestion="Try simplifying the query"
), None
```

### 3. Factory Pattern with `create_tool_class`

Override when tool needs runtime configuration:

```python
@classmethod
async def create_tool_class(
    cls,
    *,
    team: Team,
    user: User,
    state: AssistantState | None = None,
    config: RunnableConfig | None = None,
    context_manager: AssistantContextManager | None = None,
) -> Self:
    # Fetch dynamic data
    available_properties = await get_team_properties(team)

    # Format description
    description = f"Available properties: {', '.join(available_properties)}"

    return cls(
        team=team,
        user=user,
        state=state,
        config=config,
        description=description,
    )
```

### 4. Context Manager for Shared Resources

All tools receive `AssistantContextManager`:

```python
# Artifact management
artifact = await self._context_manager.artifacts.create(...)

# Contextual tools (editing mode, etc)
if self.is_editing_mode(self._context_manager):
    # Add UI payload for editing

# Team configuration
groups = await self._context_manager.get_group_names()
```

### 5. State Management

**Never mutate state directly**:

```python
# WRONG
self._state.plan = query_description

# CORRECT
new_state = self._state.model_copy(
    update={"plan": query_description},
    deep=True,
)
```

### 6. Prompt Engineering

**Use templates with formatting**:

```python
TOOL_PROMPT = """
Use this tool to {{{purpose}}}.

Available options:
{{{options}}}
""".strip()

# Format at runtime
description = format_prompt_string(
    TOOL_PROMPT,
    purpose="search entities",
    options="\n".join(f"- {opt}" for opt in options)
)
```

### 7. UI Payload Pattern

Tools can return data for UI separately from LLM:

```python
AssistantToolCallMessage(
    content=formatted_results,  # LLM sees this
    ui_payload={
        self.get_name(): {
            "query": raw_query,
            "results": structured_results,
        }
    },  # UI sees this
    id=str(uuid4()),
    tool_call_id=self.tool_call_id,
)
```

### 8. Async Concurrency

Use `asyncio.gather` for parallel operations:

```python
# Fetch multiple resources in parallel
default_tools, available_modes, user_permissions = await asyncio.gather(
    _get_default_tools_prompt(...),
    _get_modes_prompt(...),
    _get_user_permissions(...),
)
```

### 9. Type Safety with Pydantic

**Args schema defines interface**:

```python
class MyToolArgs(BaseModel):
    query: str = Field(description="The search query", min_length=1)
    limit: int = Field(description="Max results", ge=1, le=100, default=10)
    filters: dict[str, Any] = Field(default_factory=dict)

class MyTool(MaxTool):
    args_schema: type[BaseModel] = MyToolArgs

    async def _arun_impl(self, query: str, limit: int, filters: dict[str, Any]):
        # Types are validated by Pydantic
        pass
```

### 10. Tool Naming Convention

All tools must end with `Tool`:

```python
class SearchTool(MaxTool):  # ✓ Good
    pass

class Search(MaxTool):  # ✗ Bad - raises ValueError
    pass
```

### 11. Subtool vs Tool Decision

**Use MaxTool when**:
- LLM should be able to call it directly
- Need tool calling protocol (args schema, etc)
- Want it to appear in tool list

**Use MaxSubtool when**:
- Internal implementation detail
- Called by parent tool based on routing logic
- Doesn't need LangChain tool interface

### 12. Context Prompt Template

Inject context into root node's decision making:

```python
class MyTool(MaxTool):
    context_prompt_template: str = "The user is currently viewing {current_page}"

    # At runtime, if context = {"current_page": "dashboard"}:
    # → "The user is currently viewing dashboard"
```

---

## Summary

| Pattern | Tool | When to Use |
|---------|------|-------------|
| **Delegate** | SearchTool | Multiple backends, unified interface, routing logic |
| **Subgraph** | CreateInsightTool | Complex multi-step workflows, LangGraph orchestration |
| **Artifact** | ExecuteSQLTool | Persistent results, UI integration, shareable outputs |
| **Dynamic Schema** | SwitchModeTool | Runtime configuration, extensible options, registry pattern |

Each pattern solves different architectural challenges. Choose based on:

- **Complexity**: Simple routing → Delegate; Complex workflow → Subgraph
- **Persistence**: Need shareable results → Artifact
- **Extensibility**: Need runtime configuration → Dynamic Schema
- **UI Integration**: Need visual components → Artifact
- **Type Safety**: Constrained options → Dynamic Schema with Literal types
