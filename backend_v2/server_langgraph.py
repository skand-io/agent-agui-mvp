"""
LangGraph-based AG-UI Backend with Sequential Tool Calling

Uses LangGraph's interrupt() to pause execution and wait for frontend tool results.
This enables sequential tool calling where frontend tools execute before backend tools.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import AsyncGenerator
from typing import Annotated, Literal, TypedDict

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.types import Command, Send, interrupt
import pprint

from ag_ui.core import (
    CustomEvent,
    MessagesSnapshotEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateDeltaEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    Message,
)
from ag_ui.encoder import EventEncoder

from tracing import tracer


def log_message(msg: BaseMessage, label: str = "MESSAGE") -> None:
    """Log message content, tool_calls, and type for debugging."""
    tracer.log_event(label, f"type={type(msg).__name__}")
    tracer.log_event(label, f"content={pprint.pformat(msg.content)}")
    try:
        tracer.log_event(label, f"tool_calls={pprint.pformat(msg.tool_calls)}")
    except Exception:
        pass


# Load environment variables
load_dotenv()

# Initialize FastAPI app
app = FastAPI(title="AG-UI LangGraph Backend")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Event encoder
encoder = EventEncoder()


# ============= AGENT STATE =============
def _last_value(left: str | None, right: str | None) -> str | None:
    """Reducer that takes the last (rightmost) value. Used for parallel Send() merging."""
    return right


class AgentState(TypedDict):
    """State for the LangGraph agent."""

    messages: Annotated[list[BaseMessage], add_messages]
    root_tool_call_id: Annotated[str | None, _last_value]  # Identifies which specific tool call to process


# ============= TOOL DEFINITIONS =============
FRONTEND_TOOLS = {"greet"}
BACKEND_TOOLS = {"get_weather"}


async def get_weather(city: str) -> str:
    """Backend tool - get weather for a city."""
    await asyncio.sleep(0.5)  # Simulate API call
    return f"Weather in {city}: 22°C, Sunny"


BACKEND_TOOL_HANDLERS = {
    "get_weather": get_weather,
}

# Tool definitions for LLM
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "greet",
            "description": "Greet a person by name (shows browser alert)",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string", "description": "The person's name"}},
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "The city name"}},
                "required": ["city"],
            },
        },
    },
]

# ============= MODEL =============
MODEL = os.getenv("MODEL", "amazon/nova-2-lite-v1:free")
print(f"MODEL: {MODEL}")

# Using ChatOpenAI with OpenRouter base URL
model = ChatOpenAI(
    model=MODEL,
    base_url="https://openrouter.ai/api/v1",
    api_key=os.getenv("OPENROUTER_API_KEY"),
).bind_tools(TOOLS)


# ============= GRAPH NODES =============
def call_model(state: AgentState) -> dict:
    """LLM agent node - calls the model and returns the response."""
    tracer.log_event("CALL_MODEL_START")
    tracer.log_event("STATE MESSAGES")
    for msg in state["messages"]:
        log_message(msg)
    with tracer.trace("agent", state=state):
        tracer.log_event("LLM_INVOKE", f"model={MODEL}")
        response = model.invoke(state["messages"])

        # Log response details
        if hasattr(response, "content") and response.content:
            tracer.log_event("LLM_RESPONSE", f"content={str(response.content)[:100]}...")
        if hasattr(response, "tool_calls") and response.tool_calls:
            tool_names = [tc["name"] for tc in response.tool_calls]
            tracer.log_event("LLM_TOOL_CALLS", f"tools={tool_names}")

        result = {"messages": [response]}
        tracer.log_output("agent", result)
        return result


def route_tools(state: AgentState) -> list[Send] | Literal["end"]:
    """Route tools ONE AT A TIME in LLM-specified order for true sequential execution."""
    tracer.log_event("ROUTE_TOOLS_START")
    last_message = state["messages"][-1]

    if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
        tracer.log_routing("end", "no tool calls")
        return "end"

    # Find tool_call_ids that already have ToolMessage results (from previous execution)
    processed_tool_ids = {
        msg.tool_call_id
        for msg in state["messages"]
        if isinstance(msg, ToolMessage)
    }

    # Find the FIRST unprocessed tool call (preserves LLM order)
    next_tool = None
    for tc in last_message.tool_calls:
        if tc["id"] not in processed_tool_ids:
            next_tool = tc
            break

    if not next_tool:
        tracer.log_routing("end", "all tools already processed")
        return "end"

    tracer.log_routing("tool_handler", f"tool={next_tool['name']} (sequential)")

    # Return ONLY ONE Send() for the next tool
    return [Send("tool_handler", {**state, "root_tool_call_id": next_tool["id"]})]


def route_after_tool(state: AgentState) -> list[Send] | Literal["agent"]:
    """After tool_handler completes, check if more tools need processing."""
    tracer.log_event("ROUTE_AFTER_TOOL_START")

    # Find the last AIMessage with tool_calls
    last_ai_message = None
    for msg in reversed(state["messages"]):
        if isinstance(msg, AIMessage) and msg.tool_calls:
            last_ai_message = msg
            break

    if not last_ai_message:
        tracer.log_routing("agent", "no AI message with tools")
        return "agent"

    # Find tool_call_ids that already have ToolMessage results
    processed_tool_ids = {
        msg.tool_call_id
        for msg in state["messages"]
        if isinstance(msg, ToolMessage)
    }

    # Find the FIRST unprocessed tool call
    next_tool = None
    for tc in last_ai_message.tool_calls:
        if tc["id"] not in processed_tool_ids:
            next_tool = tc
            break

    if not next_tool:
        tracer.log_routing("agent", "all tools processed - getting final response")
        return "agent"

    tracer.log_routing("tool_handler", f"next tool={next_tool['name']}")
    return [Send("tool_handler", {**state, "root_tool_call_id": next_tool["id"]})]


async def tool_handler(state: AgentState) -> dict:
    """
    Process ONE tool call identified by root_tool_call_id.

    - Frontend tools: use interrupt() to pause for client execution
    - Backend tools: execute immediately and return result
    """
    tracer.log_event("TOOL_HANDLER_START")
    with tracer.trace("tool_handler", state=state):
        tool_call_id = state.get("root_tool_call_id")
        tracer.log_event("TOOL_CALL_ID", f"tool_call_id={tool_call_id}")

        # Guard: ensure we have a tool call ID
        if not tool_call_id:
            tracer.log_event("NO_TOOL_CALL_ID", "missing root_tool_call_id")
            return {"root_tool_call_id": None}

        # Find the AIMessage with tool_calls (may not be the last message after looping)
        ai_message = None
        for msg in reversed(state["messages"]):
            if isinstance(msg, AIMessage) and msg.tool_calls:
                ai_message = msg
                break

        if not ai_message:
            tracer.log_event("NO_AI_MESSAGE", "no AIMessage with tool_calls found")
            return {"root_tool_call_id": None}

        log_message(ai_message, "AI_MESSAGE")

        # Find the specific tool call we're responsible for
        tool_call = next(
            (tc for tc in ai_message.tool_calls or [] if tc["id"] == tool_call_id),
            None,
        )

        if not tool_call:
            tracer.log_event("TOOL_NOT_FOUND", f"id={tool_call_id}")
            return {"root_tool_call_id": None}

        tool_name = tool_call["name"]

        # === FRONTEND TOOL: Use interrupt() ===
        if tool_name in FRONTEND_TOOLS:
            tracer.log_event("FRONTEND_TOOL", f"tool={tool_name} - interrupting")

            # Interrupt execution, pass tool call info to client
            frontend_result = interrupt({
                "type": "frontend_tool_call",
                "tool_call_id": tool_call["id"],
                "tool_name": tool_name,
                "args": tool_call["args"],
            })

            tracer.log_event("RESUME", f"result={str(frontend_result)[:100]}")

            return {
                "messages": [ToolMessage(content=str(frontend_result), tool_call_id=tool_call["id"])],
                "root_tool_call_id": None,
            }

        # === BACKEND TOOL: Execute immediately ===
        handler = BACKEND_TOOL_HANDLERS.get(tool_name)
        if handler:
            tracer.log_event("BACKEND_TOOL", f"tool={tool_name} - executing")
            result = await handler(**tool_call["args"])
            tracer.log_event("BACKEND_TOOL_RESULT", f"result={str(result)[:100]}")

            return {
                "messages": [ToolMessage(content=result, tool_call_id=tool_call["id"])],
                "root_tool_call_id": None,
            }

        # Unknown tool
        tracer.log_event("UNKNOWN_TOOL", f"tool={tool_name}")
        return {
            "messages": [ToolMessage(content=f"Unknown tool: {tool_name}", tool_call_id=tool_call["id"])],
            "root_tool_call_id": None,
        }


# ============= BUILD GRAPH =============
workflow = StateGraph(AgentState)

# Nodes
workflow.add_node("agent", call_model)
workflow.add_node("tool_handler", tool_handler)  # Unified handler for all tools

# Edges
workflow.add_edge(START, "agent")
workflow.add_conditional_edges(
    "agent",
    route_tools,
    {"end": END},  # Send() targets are resolved dynamically
)
workflow.add_conditional_edges(
    "tool_handler",
    route_after_tool,
    {"agent": "agent"},  # Send() targets resolved dynamically
)

# CRITICAL: Checkpointer required for interrupt() to work
memory = InMemorySaver()
graph = workflow.compile(checkpointer=memory)


# ============= REQUEST/RESPONSE MODELS =============
class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None
    resume_value: str | None = None  # Value to resume with after frontend tool


# ============= CHAT ENDPOINT =============
@app.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    """Handle chat requests with SSE streaming of AG-UI events."""
    thread_id = request.thread_id or str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    async def generate() -> AsyncGenerator[str, None]:
        run_id = str(uuid.uuid4())

        # Lifecycle start
        tracer.log_agui("RUN_STARTED", f"thread={thread_id[:8]}... run={run_id[:8]}...")
        yield encoder.encode(RunStartedEvent(thread_id=thread_id, run_id=run_id))

        # Only send STATE_SNAPSHOT and MESSAGES_SNAPSHOT for new requests, not resumes
        if not request.resume_value:
            tracer.log_agui("STATE_SNAPSHOT", "tool_logs=[]")
            yield encoder.encode(StateSnapshotEvent(snapshot={"tool_logs": []}))
            messages: list[Message] = [
                {"id": str(uuid.uuid4()), "role": "user", "content": request.message}
            ]
            tracer.log_agui("MESSAGES_SNAPSHOT", f"count={len(messages)}")
            yield encoder.encode(MessagesSnapshotEvent(messages=messages))

        tracer.log_agui("STEP_STARTED", "langgraph_execution")
        yield encoder.encode(StepStartedEvent(step_name="langgraph_execution"))

        try:
            # Determine input
            if request.resume_value:
                # Resuming after frontend tool
                tracer.log_agui("GRAPH_RESUME", f"resume={request.resume_value}")
                input_data = Command(resume=request.resume_value)
            else:
                # New message
                input_data = {"messages": [HumanMessage(content=request.message)]}

            message_id = str(uuid.uuid4())
            tool_call_id_to_idx: dict[str, int] = {}  # Map tool_call_id to tool_logs index
            next_tool_log_idx = 0
            interrupted = False

            # Rebuild tool_call_id_to_idx mapping on resume (it resets to {} each request)
            if request.resume_value:
                graph_state = graph.get_state(config)
                if graph_state and graph_state.values:
                    for msg in graph_state.values.get("messages", []):
                        if isinstance(msg, AIMessage) and msg.tool_calls:
                            for idx, tc in enumerate(msg.tool_calls):
                                tool_call_id_to_idx[tc["id"]] = idx
                                next_tool_log_idx = max(next_tool_log_idx, idx + 1)
                tracer.log_event("MAPPING_REBUILT", f"tool_call_id_to_idx={list(tool_call_id_to_idx.keys())}")

            tracer.log_event("GRAPH_START", f"thread={thread_id[:8]}... resume={bool(request.resume_value)}")

            # Stream graph execution (async)
            async for event in graph.astream(input_data, config, stream_mode="updates"):
                node_name = list(event.keys())[0]
                node_output = event[node_name]

                tracer.log_event("STREAM_EVENT", f"node={node_name}")

                if node_name == "agent":
                    # Agent produced a message
                    for msg in node_output.get("messages", []):
                        if isinstance(msg, AIMessage):
                            # Stream text content
                            if msg.content:
                                tracer.log_agui("TEXT_MESSAGE_START", f"id={message_id[:8]}... role=assistant")
                                yield encoder.encode(
                                    TextMessageStartEvent(message_id=message_id, role="assistant")
                                )
                                # Stream content in chunks
                                content = str(msg.content)
                                chunk_size = 5
                                tracer.log_agui("TEXT_MESSAGE_CONTENT", f"chunks={len(content)//chunk_size + 1} total_len={len(content)}")
                                for i in range(0, len(content), chunk_size):
                                    chunk = content[i : i + chunk_size]
                                    yield encoder.encode(
                                        TextMessageContentEvent(message_id=message_id, delta=chunk)
                                    )
                                    await asyncio.sleep(0.02)

                            # Stream tool calls
                            for tc in msg.tool_calls or []:
                                tracer.log_agui("TOOL_CALL_START", f"tool={tc['name']} id={tc['id'][:8]}...")
                                yield encoder.encode(
                                    ToolCallStartEvent(
                                        tool_call_id=tc["id"],
                                        tool_call_name=tc["name"],
                                        parent_message_id=message_id,
                                    )
                                )
                                tracer.log_agui("TOOL_CALL_ARGS", f"args={json.dumps(tc['args'])}")
                                yield encoder.encode(
                                    ToolCallArgsEvent(
                                        tool_call_id=tc["id"],
                                        delta=json.dumps(tc["args"]),
                                    )
                                )
                                tracer.log_agui("TOOL_CALL_END", f"id={tc['id'][:8]}...")
                                yield encoder.encode(ToolCallEndEvent(tool_call_id=tc["id"]))

                                # Add to tool_logs (Tier 2 state tracking)
                                tracer.log_agui("STATE_DELTA", "add /tool_logs/- status=processing")
                                yield encoder.encode(
                                    StateDeltaEvent(
                                        delta=[
                                            {
                                                "op": "add",
                                                "path": "/tool_logs/-",
                                                "value": {
                                                    "id": tc["id"],
                                                    "message": f"Calling {tc['name']}...",
                                                    "status": "processing",
                                                },
                                            }
                                        ]
                                    )
                                )
                                # Track tool_call_id -> index mapping for updates
                                tool_call_id_to_idx[tc["id"]] = next_tool_log_idx
                                next_tool_log_idx += 1

                            # End text message after tool calls
                            if msg.content:
                                tracer.log_agui("TEXT_MESSAGE_END", f"id={message_id[:8]}...")
                                yield encoder.encode(TextMessageEndEvent(message_id=message_id))

                elif node_name == "tool_handler":
                    # Tool handler processed a tool (backend or resumed frontend)
                    for msg in node_output.get("messages", []):
                        if isinstance(msg, ToolMessage):
                            tracer.log_agui("TOOL_CALL_RESULT", f"id={msg.tool_call_id[:8]}... content={str(msg.content)[:50]}")
                            yield encoder.encode(
                                ToolCallResultEvent(
                                    message_id=str(uuid.uuid4()),
                                    tool_call_id=msg.tool_call_id,
                                    content=msg.content,
                                    role="tool",
                                )
                            )
                            # Update tool_log status using tool_call_id mapping
                            tool_idx = tool_call_id_to_idx.get(msg.tool_call_id)
                            if tool_idx is not None:
                                tracer.log_agui("STATE_DELTA", f"replace /tool_logs/{tool_idx}/status=completed")
                                yield encoder.encode(
                                    StateDeltaEvent(
                                        delta=[
                                            {
                                                "op": "replace",
                                                "path": f"/tool_logs/{tool_idx}/status",
                                                "value": "completed",
                                            },
                                            {
                                                "op": "replace",
                                                "path": f"/tool_logs/{tool_idx}/message",
                                                "value": f"Completed: {msg.content}",
                                            },
                                        ]
                                    )
                                )

                elif node_name == "__interrupt__":
                    tracer.log_event("INTERRUPT", "graph paused - frontend tool needed")
                    # Graph was interrupted - frontend tool needs execution
                    interrupted = True
                    # node_output is a list of Interrupt objects
                    # Each Interrupt has a "value" attribute with our data
                    raw_interrupt = node_output[0] if node_output else None
                    if hasattr(raw_interrupt, "value"):
                        interrupt_data = raw_interrupt.value
                    elif isinstance(raw_interrupt, dict):
                        interrupt_data = raw_interrupt.get("value", raw_interrupt)
                    else:
                        interrupt_data = raw_interrupt

                    # Send custom event to signal frontend tool required
                    tracer.log_agui("CUSTOM_EVENT", f"frontend_tool_required data={interrupt_data}")
                    yield encoder.encode(
                        CustomEvent(
                            name="frontend_tool_required",
                            value=interrupt_data,
                        )
                    )

                    # Update tool_log to show awaiting frontend
                    frontend_tool_call_id = interrupt_data.get("tool_call_id") if isinstance(interrupt_data, dict) else None
                    frontend_tool_idx = tool_call_id_to_idx.get(frontend_tool_call_id) if frontend_tool_call_id else None
                    if frontend_tool_idx is not None:
                        tracer.log_agui("STATE_DELTA", f"replace /tool_logs/{frontend_tool_idx}/message=awaiting")
                        yield encoder.encode(
                            StateDeltaEvent(
                                delta=[
                                    {
                                        "op": "replace",
                                        "path": f"/tool_logs/{frontend_tool_idx}/message",
                                        "value": "Awaiting frontend execution...",
                                    },
                                ]
                            )
                        )

                    # Send paused event
                    tracer.log_agui("CUSTOM_EVENT", "run_paused reason=awaiting_frontend_tool")
                    yield encoder.encode(
                        CustomEvent(name="run_paused", value={"reason": "awaiting_frontend_tool"})
                    )

            tracer.log_agui("STEP_FINISHED", "langgraph_execution")
            yield encoder.encode(StepFinishedEvent(step_name="langgraph_execution"))

            # Only send RUN_FINISHED if not interrupted
            if not interrupted:
                tracer.log_event("GRAPH_COMPLETE", f"thread={thread_id[:8]}...")
                tracer.log_agui("RUN_FINISHED", f"thread={thread_id[:8]}...")
                yield encoder.encode(RunFinishedEvent(thread_id=thread_id, run_id=run_id))
            else:
                tracer.log_event("GRAPH_INTERRUPTED", f"thread={thread_id[:8]}... awaiting frontend")
                # For interrupted runs, include thread_id for resume
                tracer.log_agui("CUSTOM_EVENT", f"run_interrupted thread={thread_id[:8]}...")
                yield encoder.encode(
                    CustomEvent(
                        name="run_interrupted",
                        value={"thread_id": thread_id, "reason": "frontend_tool_required"},
                    )
                )

        except Exception as e:
            import traceback

            traceback.print_exc()
            tracer.log_agui("CUSTOM_EVENT", f"error message={str(e)[:50]}")
            yield encoder.encode(CustomEvent(name="error", value={"message": str(e)}))
            tracer.log_agui("RUN_FINISHED", f"thread={thread_id[:8]}... (error)")
            yield encoder.encode(RunFinishedEvent(thread_id=thread_id, run_id=run_id))

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "ok", "backend": "langgraph"}


if __name__ == "__main__":
    import uvicorn

    print("Starting LangGraph AG-UI Backend on http://localhost:8000")
    print("Health check: http://localhost:8000/health")
    uvicorn.run("server_langgraph:app", host="0.0.0.0", port=8000, reload=True)
