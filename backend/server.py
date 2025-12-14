"""
Minimal CopilotKit-like Backend Server using AG-UI Protocol
FastAPI + OpenRouter for LLM API with frontend + backend tool support

AG-UI Protocol Events (Full Compliance):
- RUN_STARTED/FINISHED/ERROR: Lifecycle events
- STEP_STARTED/FINISHED: Progress tracking
- TEXT_MESSAGE_START/CONTENT/END: Text streaming
- TOOL_CALL_START/ARGS/END/RESULT: Tool execution
- STATE_SNAPSHOT/STATE_DELTA: State management
- CUSTOM: Application-defined events
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
import uuid
from collections.abc import AsyncGenerator, Callable
from enum import Enum
from pathlib import Path
from typing import Any, cast

import httpx
from pydantic import BaseModel, Field, field_validator

# Configure logging with timestamps and colors for terminal
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)
# Import AG-UI types (Full Protocol Compliance)
from ag_ui.core import (
    # Special events
    RunErrorEvent,
    RunFinishedEvent,
    # Lifecycle events
    RunStartedEvent,
    StepFinishedEvent,
    # Step events
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    # Text message events
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    # Tool call events
    ToolCallStartEvent,
)
from ag_ui.encoder import EventEncoder
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from openai import OpenAI, Stream
from openai.types.chat import ChatCompletionChunk
from openai.types.chat.chat_completion_chunk import Choice, ChoiceDelta, ChoiceDeltaToolCall

# =============================================================================
# Pydantic Models - Strict Type Definitions
# =============================================================================


class TodoStatus(str, Enum):
    """Valid statuses for a todo item."""
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class TodoItem(BaseModel):
    """A single todo item with strict validation."""
    id: str = Field(..., min_length=1, description="Unique identifier for the todo")
    content: str = Field(..., min_length=1, description="Description of the task")
    status: TodoStatus = Field(..., description="Current status of the task")

    model_config = {"strict": True}


class TodoWriteInput(BaseModel):
    """Input for the todo_write tool."""
    todos: list[TodoItem] = Field(default_factory=list, description="The updated todo list")


class MessageRole(str, Enum):
    """Valid roles for chat messages."""
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL = "tool"


class ToolCallData(BaseModel):
    """Tool call data attached to assistant messages."""
    id: str = Field(..., description="Unique tool call ID")
    name: str = Field(..., description="Name of the tool")
    arguments: str = Field(default="{}", description="JSON-encoded arguments")


class ChatMessage(BaseModel):
    """A single chat message with optional tool call data."""
    role: MessageRole = Field(..., description="Role of the message sender")
    content: str = Field(default="", description="Message content")
    tool_calls: list[ToolCallData] | None = Field(
        default=None,
        alias="toolCalls",
        description="Tool calls made by assistant"
    )
    tool_call_id: str | None = Field(
        default=None,
        alias="toolCallId",
        description="ID of the tool call this message responds to"
    )

    model_config = {"populate_by_name": True}


class ToolParameterProperty(BaseModel):
    """Definition of a single tool parameter property."""
    type: str = Field(..., description="JSON Schema type")
    description: str = Field(default="", description="Parameter description")
    enum: list[str] | None = Field(default=None, description="Allowed values")


class ToolParameters(BaseModel):
    """JSON Schema for tool parameters."""
    type: str = Field(default="object")
    properties: dict[str, ToolParameterProperty | dict[str, Any]] = Field(default_factory=dict)
    required: list[str] = Field(default_factory=list)


class FrontendToolDefinition(BaseModel):
    """Definition of a frontend tool passed from client."""
    name: str = Field(..., min_length=1, description="Tool name")
    description: str = Field(default="", description="Tool description")
    parameters: ToolParameters | dict[str, Any] = Field(
        default_factory=lambda: ToolParameters(),
        description="Tool parameters schema"
    )


class ChatRequest(BaseModel):
    """Request body for the /chat endpoint."""
    messages: list[ChatMessage] = Field(default_factory=list, description="Chat history")
    frontend_tools: list[FrontendToolDefinition] = Field(
        default_factory=list,
        alias="frontendTools",
        description="Frontend tools available"
    )
    thread_id: str | None = Field(
        default=None,
        alias="threadId",
        description="Thread ID for conversation"
    )
    run_id: str | None = Field(
        default=None,
        alias="runId",
        description="Run ID for this request"
    )
    context: str | None = Field(
        default=None,
        description="Application context to inject"
    )

    model_config = {"populate_by_name": True}

    @field_validator("thread_id", "run_id", mode="before")
    @classmethod
    def generate_uuid_if_none(cls, v: str | None) -> str:
        return v if v else str(uuid.uuid4())


class HealthResponse(BaseModel):
    """Response for health check endpoint."""
    status: str = Field(default="ok")
    protocol: str = Field(default="ag-ui")
    version: str = Field(default="1.0")


class BackendToolDefinition(BaseModel):
    """Internal definition for a backend tool."""
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., str]

    model_config = {"arbitrary_types_allowed": True}


class OpenAIMessage(BaseModel):
    """Message format for OpenAI API."""
    role: str
    content: str
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


class ToolCallState(BaseModel):
    """State for tracking a tool call during streaming."""
    id: str
    name: str = ""
    arguments: str = ""


# =============================================================================
# Helper Functions
# =============================================================================


def get_timestamp() -> int:
    """Get current timestamp in milliseconds for AG-UI protocol events."""
    return int(time.time() * 1000)

app = FastAPI()

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load environment variables from .env file in parent directory
env_path = Path(__file__).parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

# OpenRouter client
client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ.get("OPENROUTER_API_KEY"),
)

MODEL = os.environ.get("MODEL", "deepseek/deepseek-v3.2")
print(f"Using model: {MODEL}")


# Initialize AG-UI event encoder
encoder = EventEncoder()


# =============================================================================
# Backend Tools - Execute on Server
# =============================================================================


def _todo_write_handler(todos: list[dict[str, Any]]) -> str:
    """
    Smart handler for todo_write that provides context-aware responses
    to guide the LLM through the proper workflow.

    Args:
        todos: List of todo items (raw dicts from JSON parsing)

    Returns:
        Context-aware guidance message for the LLM
    """
    if not todos:
        return "Todo list cleared."

    # Validate and convert to typed objects for safer access
    validated_todos: list[TodoItem] = []
    for t in todos:
        try:
            # Handle both enum value strings and raw strings
            status_value = t.get("status", "pending")
            if isinstance(status_value, str):
                status = TodoStatus(status_value)
            else:
                status = status_value
            validated_todos.append(TodoItem(
                id=t.get("id", str(uuid.uuid4())),
                content=t.get("content", ""),
                status=status
            ))
        except (ValueError, KeyError):
            # Skip invalid items but continue processing
            continue

    if not validated_todos:
        return "Todo list cleared (no valid items)."

    # Count statuses
    completed = sum(1 for t in validated_todos if t.status == TodoStatus.COMPLETED)
    in_progress = sum(1 for t in validated_todos if t.status == TodoStatus.IN_PROGRESS)
    pending = sum(1 for t in validated_todos if t.status == TodoStatus.PENDING)
    total = len(validated_todos)

    # All completed
    if completed == total:
        return f"All {total} tasks completed! Summarize the results for the user."

    # Has in_progress task - execute it
    if in_progress > 0:
        in_progress_task = next(t for t in validated_todos if t.status == TodoStatus.IN_PROGRESS)
        return f"Task '{in_progress_task.content}' is now in progress. Execute this task now, then call todo_write to mark it as completed."

    # Has pending tasks but none in progress - start the next one
    if pending > 0:
        next_pending = next(t for t in validated_todos if t.status == TodoStatus.PENDING)
        return f"Todo list updated ({completed}/{total} completed). Now call todo_write to mark '{next_pending.content}' as in_progress, then execute it."

    return f"Todo list updated ({completed}/{total} completed)."


TODO_WRITE_PROMPT = """
Use this tool to build and maintain a structured to-do list for the current session. It helps you monitor progress, organize complex work, and show thoroughness.

# CRITICAL: Real-time Progress Updates

You MUST call todo_write to update the todo list at these specific moments:
1. **BEFORE starting a task**: Mark it as `in_progress`
2. **AFTER completing a task**: Mark it as `completed`

This creates a clear visual progress indicator for the user:
- todo_write (mark task 1 in_progress) → execute tool → todo_write (mark task 1 completed)
- todo_write (mark task 2 in_progress) → execute tool → todo_write (mark task 2 completed)
- ... and so on for each task

IMPORTANT: The user sees the todo list update in real-time. If you don't call todo_write after completing a task, the user won't see their progress!

# When to use this tool
Use it proactively in these situations:

1. Complex, multi-step work – when a task needs 3+ distinct steps or actions
2. Non-trivial tasks – work that requires careful planning or multiple operations
3. User explicitly asks for a to-do list – when they request it directly
4. User supplies multiple tasks – e.g., a numbered or comma-separated list
5. After new instructions arrive – immediately capture the requirements as to-dos
6. When you begin a task – set it to `in_progress` BEFORE starting; ideally only one `in_progress` item at a time
7. After finishing a task – mark it `completed` IMMEDIATELY and add any follow-ups discovered during execution

# When NOT to use this tool
Skip it when:
1. There's only a single, straightforward task
2. The task is trivial and tracking adds no organizational value
3. It can be finished in fewer than 3 trivial steps
4. The exchange is purely conversational or informational

NOTE: If there's just one trivial task, don't use the tool–simply do the task directly.

# Examples of when to use the todo list

<example>
User: Get the weather for Tokyo and calculate 5+3
Assistant: I'll help you with these tasks. Let me create a todo list.

Step 1: Create todo list
*Calls todo_write with:*
- Task 1: Get weather for Tokyo (pending)
- Task 2: Calculate 5+3 (pending)

Step 2: Start first task
*Calls todo_write with:*
- Task 1: Get weather for Tokyo (in_progress)
- Task 2: Calculate 5+3 (pending)

Step 3: Execute first task
*Calls get_weather("Tokyo")*

Step 4: Complete first task
*Calls todo_write with:*
- Task 1: Get weather for Tokyo (completed)
- Task 2: Calculate 5+3 (pending)

Step 5: Start second task
*Calls todo_write with:*
- Task 1: Get weather for Tokyo (completed)
- Task 2: Calculate 5+3 (in_progress)

Step 6: Execute second task
*Calls calculate("5+3")*

Step 7: Complete second task
*Calls todo_write with:*
- Task 1: Get weather for Tokyo (completed)
- Task 2: Calculate 5+3 (completed)

<reasoning>
The assistant called todo_write BEFORE and AFTER each tool execution to show real-time progress.
</reasoning>
</example>

# Examples of when NOT to use the todo list

<example>
User: What does the useState hook do in React?
Assistant: useState is a React hook that lets you add state to functional components...

<reasoning>
The assistant did not use the todo list because this is a single, informational request. There's no implementation work to track.
</reasoning>
</example>

<example>
User: Fix the typo on line 42
Assistant: *Fixes the typo*

<reasoning>
The assistant did not use the todo list because this is a single, trivial task that can be completed in one step.
</reasoning>
</example>

# Task states and management

1. **Task States**: Use these states to track progress:
  - pending: Task not yet started
  - in_progress: Currently working on (limit to ONE task at a time)
  - completed: Finished successfully

2. **Managing Tasks**:
  - Update statuses in real time as you work
  - Mark tasks complete IMMEDIATELY when done–don't batch them
  - Keep only ONE task `in_progress` at any moment
  - Finish the current task before starting another
  - Remove tasks that are no longer relevant

3. **Completion Rules**:
  - Mark a task `completed` only when it's FULLY done
  - If you hit errors, blockers, or can't finish, leave it `in_progress`
  - When blocked, add a new task describing what must be resolved

4. **Task Breakdown**:
  - Create specific, actionable items
  - Break complex tasks into smaller, manageable steps
  - Use clear, descriptive task names

When unsure, use this tool. Proactive task management shows attentiveness and helps ensure all requirements are met.
""".strip()


# WMO Weather codes mapping
WEATHER_CODES: dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Depositing rime fog",
    51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
    95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
}


def get_weather(city: str) -> str:
    """
    Get real weather data for a city using Open-Meteo API (free, no API key needed).

    Args:
        city: The city name to get weather for (e.g., 'Tokyo', 'New York')

    Returns:
        Formatted weather information string or error message
    """
    try:
        # Step 1: Geocode the city name to get coordinates
        geocode_url = "https://geocoding-api.open-meteo.com/v1/search"
        geocode_params: dict[str, str | int] = {
            "name": city,
            "count": 1,
            "language": "en",
            "format": "json"
        }

        with httpx.Client(timeout=10.0) as http_client:
            geo_response = http_client.get(geocode_url, params=geocode_params)
            geo_response.raise_for_status()
            geo_data: dict[str, Any] = geo_response.json()

            results: list[dict[str, Any]] = geo_data.get("results", [])
            if not results:
                return f"Could not find location: {city}"

            location = results[0]
            lat: float = location["latitude"]
            lon: float = location["longitude"]
            location_name: str = location.get("name", city)
            country: str = location.get("country", "")

            # Step 2: Fetch current weather
            weather_url = "https://api.open-meteo.com/v1/forecast"
            weather_params: dict[str, Any] = {
                "latitude": lat,
                "longitude": lon,
                "current": [
                    "temperature_2m", "relative_humidity_2m", "apparent_temperature",
                    "weather_code", "wind_speed_10m", "wind_direction_10m"
                ],
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
            }

            weather_response = http_client.get(weather_url, params=weather_params)
            weather_response.raise_for_status()
            weather_data: dict[str, Any] = weather_response.json()

            current: dict[str, Any] = weather_data.get("current", {})

            weather_code: int = current.get("weather_code", 0)
            condition: str = WEATHER_CODES.get(weather_code, "Unknown")
            temp: float | str = current.get("temperature_2m", "N/A")
            feels_like: float | str = current.get("apparent_temperature", "N/A")
            humidity: int | str = current.get("relative_humidity_2m", "N/A")
            wind_speed: float | str = current.get("wind_speed_10m", "N/A")

            return (
                f"Weather in {location_name}, {country}:\n"
                f"• Condition: {condition}\n"
                f"• Temperature: {temp}°C (feels like {feels_like}°C)\n"
                f"• Humidity: {humidity}%\n"
                f"• Wind: {wind_speed} km/h"
            )

    except httpx.TimeoutException:
        return "Weather service timed out. Please try again."
    except httpx.HTTPStatusError as e:
        return f"Weather service error: {e.response.status_code}"
    except Exception as e:
        return f"Error fetching weather: {str(e)}"


def _calculate_expression(expression: str) -> str:
    """
    Safely evaluate a mathematical expression.

    Args:
        expression: Math expression to evaluate (e.g., "2 + 2", "5 * 3")

    Returns:
        String representation of the result
    """
    # Note: eval is used here for simplicity, but in production
    # consider using a safer math parser like numexpr or ast.literal_eval
    return str(eval(expression))  # noqa: S307


# Backend tool definitions with type annotations
BACKEND_TOOLS: dict[str, dict[str, Any]] = {
    "get_weather": {
        "description": "Get the current weather for a city. Returns temperature, conditions, humidity, and wind speed.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "The city name (e.g., 'Tokyo', 'New York', 'London')"
                }
            },
            "required": ["city"]
        },
        "handler": get_weather
    },
    "calculate": {
        "description": "Perform a mathematical calculation",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "Math expression to evaluate"
                }
            },
            "required": ["expression"]
        },
        "handler": _calculate_expression
    },
    "todo_write": {
        "description": TODO_WRITE_PROMPT,
        "parameters": {
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "The updated todo list",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "Unique identifier for the todo"
                            },
                            "content": {
                                "type": "string",
                                "description": "Description of the task"
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "Current status of the task"
                            }
                        },
                        "required": ["id", "content", "status"]
                    }
                }
            },
            "required": ["todos"]
        },
        "handler": _todo_write_handler
    }
}


def to_openai_tool(name: str, tool: dict[str, Any]) -> dict[str, Any]:
    """
    Convert tool definition to OpenAI function format.

    Args:
        name: The tool name
        tool: Tool definition dict with description and parameters

    Returns:
        OpenAI-compatible function tool definition
    """
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": tool.get("description", ""),
            "parameters": tool.get("parameters", {"type": "object", "properties": {}})
        }
    }




# Cache for tracking context changes per thread
_context_cache: dict[str, str] = {}


def build_messages_with_context(
    messages: list[ChatMessage],
    context: str | None,
    thread_id: str | None = None
) -> list[dict[str, Any]]:
    """
    Build OpenAI messages with context injected BEFORE the latest user message.

    PostHog-style context injection:
    - Context is NOT stored in message history
    - Context is injected fresh each turn, right before the latest user message
    - This prevents stale context from polluting the conversation
    - Detects context changes and notifies the LLM

    Args:
        messages: List of ChatMessage objects from the request
        context: Optional application context string to inject
        thread_id: Optional thread ID for context change detection

    Returns:
        List of OpenAI-compatible message dictionaries

    Message order: [...history, context_message, latest_user_message]
    """
    openai_messages: list[dict[str, Any]] = []

    if not messages:
        return openai_messages

    # Find the index of the last user message
    last_user_idx: int = -1
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].role == MessageRole.USER:
            last_user_idx = i
            break

    # Detect if context has changed since last turn
    context_changed: bool = False
    if context and thread_id:
        # MD5 is fine here - used for change detection, not security
        context_hash = hashlib.md5(context.encode(), usedforsecurity=False).hexdigest()
        previous_hash = _context_cache.get(thread_id)
        if previous_hash and previous_hash != context_hash:
            context_changed = True
        _context_cache[thread_id] = context_hash

    # Build messages, injecting context before the last user message
    for i, msg in enumerate(messages):
        # Inject context right before the last user message
        if i == last_user_idx and context:
            context_preamble = """[CURRENT APPLICATION CONTEXT]
This is the current state of the application. It is injected fresh each turn and reflects the CURRENT state.
Important: This context may have changed since earlier messages. Always use this current context, not any previously mentioned state."""

            if context_changed:
                context_preamble += "\n\n⚠️ NOTE: The application context has CHANGED since the previous turn. Please use this updated context."

            openai_messages.append({
                "role": "system",
                "content": f"{context_preamble}\n\n{context}"
            })

        role: str = msg.role.value

        # Handle tool result messages (from previous tool executions in chained calls)
        if role == "tool":
            tool_call_id = msg.tool_call_id or "unknown"
            openai_messages.append({
                "role": "tool",
                "content": msg.content,
                "tool_call_id": tool_call_id,
            })
        # Handle assistant messages (may have tool_calls attached)
        elif role == "assistant":
            assistant_msg: dict[str, Any] = {
                "role": "assistant",
                "content": msg.content
            }
            # If the assistant message has tool_calls, include them for proper threading
            if msg.tool_calls:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": tc.arguments
                        }
                    }
                    for tc in msg.tool_calls
                ]
            openai_messages.append(assistant_msg)
        else:
            # Regular user/system messages
            openai_messages.append({
                "role": role,
                "content": msg.content
            })

    return openai_messages


@app.post("/chat")
async def chat(request: Request) -> StreamingResponse:
    """
    Main chat endpoint - handles streaming responses with AG-UI protocol.

    Context Handling (PostHog-style):
    - Context is injected BEFORE the latest user message, not at the start
    - Context is regenerated fresh each turn, never stored in history
    - This prevents stale context from accumulating in the conversation

    Args:
        request: FastAPI Request object containing JSON body

    Returns:
        StreamingResponse with SSE events
    """
    request_start: float = time.time()
    logger.info("=" * 60)
    logger.info("📥 REQUEST RECEIVED")

    # Parse and validate request body using Pydantic model
    data = await request.json()
    chat_request = ChatRequest.model_validate(data)

    # Extract validated fields
    messages: list[ChatMessage] = chat_request.messages
    frontend_tools: list[FrontendToolDefinition] = chat_request.frontend_tools
    thread_id: str = chat_request.thread_id or str(uuid.uuid4())
    run_id: str = chat_request.run_id or str(uuid.uuid4())
    context: str | None = chat_request.context

    # Log request details
    logger.info(f"   Thread: {thread_id[:8]}... | Run: {run_id[:8]}...")
    logger.info(f"   Messages: {len(messages)} | Frontend tools: {len(frontend_tools)} | Context: {'yes' if context else 'no'}")
    if messages:
        last_msg = messages[-1]
        content_preview = last_msg.content[:50] if last_msg.content else ""
        logger.info(f"   Last message ({last_msg.role.value}): {content_preview}...")

    # Build tool list: backend tools + frontend tools
    all_tools: list[dict[str, Any]] = []
    frontend_tool_names: set[str] = set()

    # Add backend tools
    for name, tool in BACKEND_TOOLS.items():
        all_tools.append(to_openai_tool(name, tool))

    # Add frontend tools (we just need their schemas for the LLM)
    frontend_tool: FrontendToolDefinition
    for frontend_tool in frontend_tools:
        tool_dict = frontend_tool.model_dump(by_alias=True)
        all_tools.append(to_openai_tool(frontend_tool.name, tool_dict))
        frontend_tool_names.add(frontend_tool.name)

    logger.info(f"   Total tools: {len(all_tools)} (backend: {len(BACKEND_TOOLS)}, frontend: {len(frontend_tool_names)})")

    # Build messages with context injected before the latest user message
    build_start: float = time.time()
    openai_messages: list[dict[str, Any]] = build_messages_with_context(messages, context, thread_id)
    build_time: float = (time.time() - build_start) * 1000
    logger.info(f"   Message building: {build_time:.1f}ms | Total messages to LLM: {len(openai_messages)}")

    import pprint
    logger.info(f"   OPENAI MESSAGES: {pprint.pformat(openai_messages)}")

    async def generate() -> AsyncGenerator[str, None]:
        nonlocal request_start
        stream_start: float = time.time()

        try:
            logger.info("🚀 STARTING STREAM")

            # RUN_STARTED event (AG-UI protocol)
            # Note: input field requires RunAgentInput type which is complex,
            # so we omit it for simplicity (it's optional per spec)
            yield encoder.encode(RunStartedEvent(
                thread_id=thread_id,
                run_id=run_id,
                timestamp=get_timestamp()
            ))

            # STEP_STARTED: LLM inference
            yield encoder.encode(StepStartedEvent(
                step_name="llm_inference",
                timestamp=get_timestamp()
            ))

            # Call OpenRouter with streaming
            logger.info(f"🤖 CALLING LLM: {MODEL}")
            llm_call_start: float = time.time()

            # Stream returns an iterator of ChatCompletionChunk objects
            # Each chunk contains incremental content (delta) rather than full message
            # Note: cast is needed because the overload doesn't narrow properly with stream=True
            stream: Stream[ChatCompletionChunk] = cast(
                Stream[ChatCompletionChunk],
                client.chat.completions.create(
                    model=MODEL,
                    messages=openai_messages,  # type: ignore[arg-type]
                    tools=all_tools if all_tools else None,  # type: ignore[arg-type]
                    stream=True
                )
            )

            current_tool_calls: dict[int, dict[str, str]] = {}  # Track tool calls by index
            message_id: str | None = None
            text_started: bool = False
            first_chunk_received: bool = False
            chunk_count: int = 0

            # Process each chunk from the stream
            # ChatCompletionChunk structure:
            #   - id: str
            #   - choices: list[Choice]
            #   - created: int
            #   - model: str
            #   - object: Literal["chat.completion.chunk"]
            chunk: ChatCompletionChunk
            for chunk in stream:
                import pprint
                logger.info(f"      COUNT: {chunk_count}")
                logger.info(f"      CHOICES: {pprint.pformat(chunk.choices)}")
                logger.info(f"      CREATED: {chunk.created}")
                logger.info(f"      MODEL: {chunk.model}")
                logger.info(f"      USAGE: {chunk.usage}")
                logger.info(f"      OBJECT: {chunk.object}")

                chunk_count += 1

                # Log time to first chunk
                if not first_chunk_received:
                    first_chunk_time: float = (time.time() - llm_call_start) * 1000
                    logger.info(f"   ⚡ First chunk received: {first_chunk_time:.0f}ms")
                    first_chunk_received = True
                if not chunk.choices:
                    continue

                # Choice structure:
                #   - delta: ChoiceDelta (content, role, tool_calls, etc.)
                #   - finish_reason: Optional["stop", "length", "tool_calls", ...]
                #   - index: int
                choice: Choice = chunk.choices[0]
                delta: ChoiceDelta = choice.delta
                finish_reason: str | None = choice.finish_reason


                # Handle text content
                if delta.content:
                    if not text_started:
                        message_id = str(uuid.uuid4())
                        yield encoder.encode(TextMessageStartEvent(
                            message_id=message_id,
                            role="assistant"
                        ))
                        text_started = True
                    # message_id is guaranteed to be set here since text_started is True
                    assert message_id is not None
                    yield encoder.encode(TextMessageContentEvent(
                        message_id=message_id,
                        delta=delta.content
                    ))

                # Handle tool calls
                # ChoiceDeltaToolCall structure:
                #   - index: int (position in tool_calls array)
                #   - id: Optional[str] (tool call ID, only in first chunk)
                #   - function: Optional[ChoiceDeltaToolCallFunction]
                #       - name: Optional[str] (function name, only in first chunk)
                #       - arguments: Optional[str] (streamed argument chunks)
                #   - type: Optional[Literal["function"]]
                if delta.tool_calls:
                    tc: ChoiceDeltaToolCall
                    for tc in delta.tool_calls:
                        idx: int = tc.index

                        # Initialize new tool call
                        if idx not in current_tool_calls:
                            tool_call_id: str = tc.id or str(uuid.uuid4())
                            current_tool_calls[idx] = {
                                "id": tool_call_id,
                                "name": "",
                                "arguments": ""
                            }

                        tool_call: dict[str, str] = current_tool_calls[idx]

                        # Update tool call ID if provided
                        if tc.id:
                            tool_call["id"] = tc.id

                        # Update function name if provided and emit TOOL_CALL_START
                        if tc.function and tc.function.name:
                            tool_call["name"] = tc.function.name
                            logger.info(f"   🔧 Tool call detected: {tool_call['name']}")
                            yield encoder.encode(ToolCallStartEvent(
                                tool_call_id=tool_call["id"],
                                tool_call_name=tool_call["name"],
                                parent_message_id=message_id
                            ))

                        # Accumulate arguments and stream them
                        if tc.function and tc.function.arguments:
                            tool_call["arguments"] += tc.function.arguments
                            logger.info(f"   🔧 Tool call: {tool_call['name']} | Arguments: {tc.function.arguments}")
                            yield encoder.encode(ToolCallArgsEvent(
                                tool_call_id=tool_call["id"],
                                delta=tc.function.arguments
                            ))

                # Handle finish
                if finish_reason == "stop" and text_started:
                    assert message_id is not None  # Guaranteed by text_started
                    yield encoder.encode(TextMessageEndEvent(message_id=message_id))

            # Log LLM streaming complete
            llm_total_time = (time.time() - llm_call_start) * 1000
            logger.info(f"   ✅ LLM streaming complete: {llm_total_time:.0f}ms ({chunk_count} chunks)")

            # STEP_FINISHED: LLM inference complete
            yield encoder.encode(StepFinishedEvent(
                step_name="llm_inference",
                timestamp=get_timestamp()
            ))

            # Process completed tool calls
            if current_tool_calls:
                logger.info(f"🔧 EXECUTING {len(current_tool_calls)} TOOL(S)")
                # STEP_STARTED: Tool execution
                yield encoder.encode(StepStartedEvent(
                    step_name="tool_execution",
                    timestamp=get_timestamp()
                ))

            for _idx, tool_call in current_tool_calls.items():
                tool_name = tool_call["name"]
                tool_call_id = tool_call["id"]

                # Signal end of tool call arguments
                yield encoder.encode(ToolCallEndEvent(tool_call_id=tool_call_id))

                # Execute backend tools and stream result
                if tool_name in BACKEND_TOOLS:
                    tool_start = time.time()
                    logger.info(f"   🔨 Executing: {tool_name}")
                    try:
                        args = json.loads(tool_call["arguments"]) if tool_call["arguments"] else {}
                        handler = BACKEND_TOOLS[tool_name]["handler"]
                        result = handler(**args)

                        tool_time = (time.time() - tool_start) * 1000
                        result_preview = result[:50] if len(result) > 50 else result
                        logger.info(f"   ✅ {tool_name} completed: {tool_time:.0f}ms | Result: {result_preview}...")

                        # TOOL_CALL_RESULT with result
                        result_message_id = str(uuid.uuid4())
                        yield encoder.encode(ToolCallResultEvent(
                            message_id=result_message_id,
                            tool_call_id=tool_call_id,
                            content=result,
                            role="tool"
                        ))
                    except Exception as e:
                        tool_time = (time.time() - tool_start) * 1000
                        logger.error(f"   ❌ {tool_name} failed: {tool_time:.0f}ms | Error: {str(e)}")
                        result_message_id = str(uuid.uuid4())
                        yield encoder.encode(ToolCallResultEvent(
                            message_id=result_message_id,
                            tool_call_id=tool_call_id,
                            content=f"Error: {str(e)}",
                            role="tool"
                        ))
                else:
                    # Frontend tools: no result from server (client executes them)
                    logger.info(f"   📤 Frontend tool: {tool_name} (client will execute)")

            # STEP_FINISHED: Tool execution complete
            if current_tool_calls:
                yield encoder.encode(StepFinishedEvent(
                    step_name="tool_execution",
                    timestamp=get_timestamp()
                ))

            # Final summary
            total_time: float = (time.time() - request_start) * 1000
            stream_time: float = (time.time() - stream_start) * 1000
            logger.info("📤 STREAM COMPLETE")
            logger.info(f"   Total request time: {total_time:.0f}ms")
            logger.info(f"   Stream duration: {stream_time:.0f}ms")
            logger.info(f"   Tool calls: {len(current_tool_calls)}")
            logger.info("=" * 60)

            # RUN_FINISHED event with result and timestamp (AG-UI protocol compliance)
            yield encoder.encode(RunFinishedEvent(
                thread_id=thread_id,
                run_id=run_id,
                timestamp=get_timestamp(),
                result={
                    "message_id": message_id,
                    "tool_calls_count": len(current_tool_calls),
                    "tool_names": [tc["name"] for tc in current_tool_calls.values()] if current_tool_calls else []
                }
            ))

        except Exception as e:
            logger.error(f"❌ STREAM ERROR: {str(e)}")
            yield encoder.encode(RunErrorEvent(message=str(e), code="RUNTIME_ERROR"))

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Health check endpoint for monitoring."""
    return HealthResponse()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
