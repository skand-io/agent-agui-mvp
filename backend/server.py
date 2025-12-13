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
import os
import json
import uuid
import time
import hashlib
import httpx
import logging
from pathlib import Path

# Configure logging with timestamps and colors for terminal
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s.%(msecs)03d | %(levelname)-5s | %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI

# Import AG-UI types (Full Protocol Compliance)
from ag_ui.core import (
    EventType,
    # Lifecycle events
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    # Step events
    StepStartedEvent,
    StepFinishedEvent,
    # Text message events
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    # Tool call events
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    # State management events
    StateSnapshotEvent,
    StateDeltaEvent,
    # Special events
    CustomEvent,
)
from ag_ui.encoder import EventEncoder


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


# Backend tools - these execute on the server

# TodoWrite tool prompt - follows PostHog's ee/hogai pattern
def _todo_write_handler(todos: list) -> str:
    """
    Smart handler for todo_write that provides context-aware responses
    to guide the LLM through the proper workflow.
    """
    if not todos:
        return "Todo list cleared."

    # Count statuses
    completed = sum(1 for t in todos if t.get('status') == 'completed')
    in_progress = sum(1 for t in todos if t.get('status') == 'in_progress')
    pending = sum(1 for t in todos if t.get('status') == 'pending')
    total = len(todos)

    # All completed
    if completed == total:
        return f"All {total} tasks completed! Summarize the results for the user."

    # Has in_progress task - execute it
    if in_progress > 0:
        in_progress_task = next(t for t in todos if t.get('status') == 'in_progress')
        return f"Task '{in_progress_task.get('content', 'current task')}' is now in progress. Execute this task now, then call todo_write to mark it as completed."

    # Has pending tasks but none in progress - start the next one
    if pending > 0:
        next_pending = next(t for t in todos if t.get('status') == 'pending')
        return f"Todo list updated ({completed}/{total} completed). Now call todo_write to mark '{next_pending.get('content', 'next task')}' as in_progress, then execute it."

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


def get_weather(city: str) -> str:
    """
    Get real weather data for a city using Open-Meteo API (free, no API key needed).

    1. Geocode city name to coordinates using Open-Meteo Geocoding API
    2. Fetch current weather using Open-Meteo Weather API
    """
    try:
        # Step 1: Geocode the city name to get coordinates
        geocode_url = "https://geocoding-api.open-meteo.com/v1/search"
        geocode_params = {"name": city, "count": 1, "language": "en", "format": "json"}

        with httpx.Client(timeout=10.0) as client:
            geo_response = client.get(geocode_url, params=geocode_params)
            geo_response.raise_for_status()
            geo_data = geo_response.json()

            if not geo_data.get("results"):
                return f"Could not find location: {city}"

            location = geo_data["results"][0]
            lat = location["latitude"]
            lon = location["longitude"]
            location_name = location.get("name", city)
            country = location.get("country", "")

            # Step 2: Fetch current weather
            weather_url = "https://api.open-meteo.com/v1/forecast"
            weather_params = {
                "latitude": lat,
                "longitude": lon,
                "current": ["temperature_2m", "relative_humidity_2m", "apparent_temperature",
                           "weather_code", "wind_speed_10m", "wind_direction_10m"],
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
            }

            weather_response = client.get(weather_url, params=weather_params)
            weather_response.raise_for_status()
            weather_data = weather_response.json()

            current = weather_data.get("current", {})

            # Weather code to description mapping (WMO codes)
            weather_codes = {
                0: "Clear sky",
                1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
                45: "Foggy", 48: "Depositing rime fog",
                51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
                61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
                71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
                80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
                95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
            }

            weather_code = current.get("weather_code", 0)
            condition = weather_codes.get(weather_code, "Unknown")
            temp = current.get("temperature_2m", "N/A")
            feels_like = current.get("apparent_temperature", "N/A")
            humidity = current.get("relative_humidity_2m", "N/A")
            wind_speed = current.get("wind_speed_10m", "N/A")

            return (
                f"Weather in {location_name}, {country}:\n"
                f"• Condition: {condition}\n"
                f"• Temperature: {temp}°C (feels like {feels_like}°C)\n"
                f"• Humidity: {humidity}%\n"
                f"• Wind: {wind_speed} km/h"
            )

    except httpx.TimeoutException:
        return f"Weather service timed out. Please try again."
    except httpx.HTTPStatusError as e:
        return f"Weather service error: {e.response.status_code}"
    except Exception as e:
        return f"Error fetching weather: {str(e)}"


BACKEND_TOOLS = {
    "get_weather": {
        "description": "Get the current weather for a city. Returns temperature, conditions, humidity, and wind speed.",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "The city name (e.g., 'Tokyo', 'New York', 'London')"}
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
                "expression": {"type": "string", "description": "Math expression to evaluate"}
            },
            "required": ["expression"]
        },
        "handler": lambda expression: str(eval(expression))
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
                            "id": {"type": "string", "description": "Unique identifier for the todo"},
                            "content": {"type": "string", "description": "Description of the task"},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"], "description": "Current status of the task"}
                        },
                        "required": ["id", "content", "status"]
                    }
                }
            },
            "required": ["todos"]
        },
        "handler": lambda todos: _todo_write_handler(todos)
    }
}


def to_openai_tool(name: str, tool: dict) -> dict:
    """Convert tool definition to OpenAI function format"""
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
    messages: list,
    context: str | None,
    thread_id: str | None = None
) -> list:
    """
    Build OpenAI messages with context injected BEFORE the latest user message.

    PostHog-style context injection:
    - Context is NOT stored in message history
    - Context is injected fresh each turn, right before the latest user message
    - This prevents stale context from polluting the conversation
    - Detects context changes and notifies the LLM

    Message order: [...history, context_message, latest_user_message]
    """
    openai_messages = []

    if not messages:
        return openai_messages

    # Find the index of the last user message
    last_user_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            last_user_idx = i
            break

    # Detect if context has changed since last turn
    context_changed = False
    if context and thread_id:
        context_hash = hashlib.md5(context.encode()).hexdigest()
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

        role = msg.get("role", "user")

        # Handle tool result messages (from previous tool executions in chained calls)
        if role == "tool":
            tool_call_id = msg.get("toolCallId") or msg.get("tool_call_id") or "unknown"
            openai_messages.append({
                "role": "tool",
                "content": msg.get("content", ""),
                "tool_call_id": tool_call_id,
            })
        # Handle assistant messages (may have tool_calls attached)
        elif role == "assistant":
            assistant_msg = {
                "role": "assistant",
                "content": msg.get("content", "")
            }
            # If the assistant message has tool_calls, include them for proper threading
            if msg.get("toolCalls") or msg.get("tool_calls"):
                tool_calls_data = msg.get("toolCalls") or msg.get("tool_calls") or []
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.get("id", "unknown"),
                        "type": "function",
                        "function": {
                            "name": tc.get("name", ""),
                            "arguments": tc.get("arguments", "{}")
                        }
                    }
                    for tc in tool_calls_data
                ]
            openai_messages.append(assistant_msg)
        else:
            # Regular user/system messages
            openai_messages.append({
                "role": role,
                "content": msg.get("content", "")
            })

    return openai_messages


@app.post("/chat")
async def chat(request: Request):
    """
    Main chat endpoint - handles streaming responses with AG-UI protocol

    Request body:
    {
        "messages": [{"role": "user", "content": "..."}],
        "frontendTools": [{"name": "greet", "description": "...", "parameters": {...}}],
        "threadId": "optional-thread-id",
        "runId": "optional-run-id",
        "context": "optional app context string to inject into system prompt"
    }

    Context Handling (PostHog-style):
    - Context is injected BEFORE the latest user message, not at the start
    - Context is regenerated fresh each turn, never stored in history
    - This prevents stale context from accumulating in the conversation
    """
    request_start = time.time()
    logger.info("=" * 60)
    logger.info("📥 REQUEST RECEIVED")

    data = await request.json()
    messages = data.get("messages", [])
    frontend_tools = data.get("frontendTools", [])
    thread_id = data.get("threadId", str(uuid.uuid4()))
    run_id = data.get("runId", str(uuid.uuid4()))
    context = data.get("context")  # App context from frontend (injected fresh each turn)

    # Log request details
    logger.info(f"   Thread: {thread_id[:8]}... | Run: {run_id[:8]}...")
    logger.info(f"   Messages: {len(messages)} | Frontend tools: {len(frontend_tools)} | Context: {'yes' if context else 'no'}")
    if messages:
        last_msg = messages[-1]
        content_preview = last_msg.get('content', '')[:50]
        logger.info(f"   Last message ({last_msg.get('role')}): {content_preview}...")

    # Build tool list: backend tools + frontend tools
    all_tools = []
    frontend_tool_names = set()

    # Add backend tools
    for name, tool in BACKEND_TOOLS.items():
        all_tools.append(to_openai_tool(name, tool))

    # Add frontend tools (we just need their schemas for the LLM)
    for tool in frontend_tools:
        all_tools.append(to_openai_tool(tool["name"], tool))
        frontend_tool_names.add(tool["name"])

    logger.info(f"   Total tools: {len(all_tools)} (backend: {len(BACKEND_TOOLS)}, frontend: {len(frontend_tool_names)})")

    # Build messages with context injected before the latest user message
    build_start = time.time()
    openai_messages = build_messages_with_context(messages, context, thread_id)
    build_time = (time.time() - build_start) * 1000
    logger.info(f"   Message building: {build_time:.1f}ms | Total messages to LLM: {len(openai_messages)}")

    async def generate():
        nonlocal request_start
        stream_start = time.time()

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
            llm_call_start = time.time()

            stream = client.chat.completions.create(
                model=MODEL,
                messages=openai_messages,
                tools=all_tools if all_tools else None,
                stream=True
            )

            current_tool_calls = {}  # Track multiple tool calls by index
            message_id = None
            text_started = False
            first_chunk_received = False
            chunk_count = 0

            for chunk in stream:
                chunk_count += 1

                # Log time to first chunk
                if not first_chunk_received:
                    first_chunk_time = (time.time() - llm_call_start) * 1000
                    logger.info(f"   ⚡ First chunk received: {first_chunk_time:.0f}ms")
                    first_chunk_received = True
                if not chunk.choices:
                    continue

                delta = chunk.choices[0].delta
                finish_reason = chunk.choices[0].finish_reason

                # Handle text content
                if delta.content:
                    if not text_started:
                        message_id = str(uuid.uuid4())
                        yield encoder.encode(TextMessageStartEvent(
                            message_id=message_id,
                            role="assistant"
                        ))
                        text_started = True
                    yield encoder.encode(TextMessageContentEvent(
                        message_id=message_id,
                        delta=delta.content
                    ))

                # Handle tool calls
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index

                        # Initialize new tool call
                        if idx not in current_tool_calls:
                            tool_call_id = tc.id or str(uuid.uuid4())
                            current_tool_calls[idx] = {
                                "id": tool_call_id,
                                "name": "",
                                "arguments": ""
                            }

                        tool_call = current_tool_calls[idx]

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
                            yield encoder.encode(ToolCallArgsEvent(
                                tool_call_id=tool_call["id"],
                                delta=tc.function.arguments
                            ))

                # Handle finish
                if finish_reason == "stop" and text_started:
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

            for idx, tool_call in current_tool_calls.items():
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
            total_time = (time.time() - request_start) * 1000
            stream_time = (time.time() - stream_start) * 1000
            logger.info(f"📤 STREAM COMPLETE")
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


@app.get("/health")
async def health():
    return {"status": "ok", "protocol": "ag-ui", "version": "1.0"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
