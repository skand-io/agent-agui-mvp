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
from typing import Annotated, Literal

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
from langgraph.types import Command, interrupt

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
class AgentState(dict):
    """State for the LangGraph agent."""

    messages: Annotated[list[BaseMessage], add_messages]


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


def route_tools(state: AgentState) -> Literal["frontend_handler", "backend_handler", "end"]:
    """Route based on tool type in the last message."""
    tracer.log_event("ROUTE_TOOLS_START")
    with tracer.trace("route_tools", state=state):
        last_message = state["messages"][-1]

        if not isinstance(last_message, AIMessage) or not last_message.tool_calls:
            tracer.log_routing("end", "no tool calls")
            return "end"

        # Get FIRST tool call only (sequential execution)
        tool_call = last_message.tool_calls[0]
        tool_name = tool_call["name"]

        if tool_name in FRONTEND_TOOLS:
            tracer.log_routing("frontend_handler", f"tool={tool_name} is frontend")
            return "frontend_handler"

        tracer.log_routing("backend_handler", f"tool={tool_name} is backend")
        return "backend_handler"


def frontend_handler(state: AgentState) -> dict:
    """Pause for frontend tool execution using interrupt()."""
    tracer.log_event("FRONTEND_HANDLER_START")
    with tracer.trace("frontend_handler", state=state):
        last_message = state["messages"][-1]
        tool_call = last_message.tool_calls[0]

        tracer.log_event("INTERRUPT", f"tool={tool_call['name']} args={tool_call['args']}")

        # INTERRUPT: Pause execution and wait for frontend
        # The value we pass here is sent to the client
        frontend_result = interrupt(
            {
                "type": "frontend_tool_call",
                "tool_call_id": tool_call["id"],
                "tool_name": tool_call["name"],
                "args": tool_call["args"],
            }
        )

        tracer.log_event("RESUME", f"result={str(frontend_result)[:100]}")

        # When resumed with Command(resume="..."), frontend_result contains that value
        result = {"messages": [ToolMessage(content=str(frontend_result), tool_call_id=tool_call["id"])]}
        tracer.log_output("frontend_handler", result)
        return result


async def backend_handler(state: AgentState) -> dict:
    """Execute backend tools immediately, skipping any frontend tools."""
    with tracer.trace("backend_handler", state=state):
        last_message = state["messages"][-1]
        results = []

        for tool_call in last_message.tool_calls:
            tool_name = tool_call["name"]

            # Skip frontend tools - they will be handled by frontend_handler
            if tool_name in FRONTEND_TOOLS:
                tracer.log_event("SKIP_FRONTEND_TOOL", f"tool={tool_name} (will be handled by frontend)")
                continue

            handler = BACKEND_TOOL_HANDLERS.get(tool_name)
            if handler:
                tracer.log_event("BACKEND_TOOL_EXECUTE", f"tool={tool_name} args={tool_call['args']}")
                result = await handler(**tool_call["args"])
                tracer.log_event("BACKEND_TOOL_RESULT", f"tool={tool_name} result={str(result)[:100]}")
                results.append(ToolMessage(content=result, tool_call_id=tool_call["id"]))

        output = {"messages": results}
        tracer.log_output("backend_handler", output)
        return output


# ============= BUILD GRAPH =============
workflow = StateGraph(AgentState)

workflow.add_node("agent", call_model)
workflow.add_node("frontend_handler", frontend_handler)
workflow.add_node("backend_handler", backend_handler)

workflow.add_edge(START, "agent")
workflow.add_conditional_edges(
    "agent",
    route_tools,
    {
        "frontend_handler": "frontend_handler",
        "backend_handler": "backend_handler",
        "end": END,
    },
)
workflow.add_edge("frontend_handler", "agent")  # Loop back after frontend result
workflow.add_edge("backend_handler", "agent")  # Loop back after backend result

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
                input_data = Command(resume=request.resume_value)
            else:
                # New message
                input_data = {"messages": [HumanMessage(content=request.message)]}

            message_id = str(uuid.uuid4())
            tool_log_idx = 0
            interrupted = False

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
                                tool_log_idx += 1

                            # End text message after tool calls
                            if msg.content:
                                tracer.log_agui("TEXT_MESSAGE_END", f"id={message_id[:8]}...")
                                yield encoder.encode(TextMessageEndEvent(message_id=message_id))

                elif node_name == "frontend_handler":
                    # Frontend tool was processed - this means we're returning from interrupt
                    # The tool was executed by the frontend
                    # Note: We don't update tool_logs here because the frontend already
                    # knows about the tool and its completion from the resume flow
                    pass

                elif node_name == "backend_handler":
                    # Backend tool results
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
                            # Update tool_log status
                            tracer.log_agui("STATE_DELTA", f"replace /tool_logs/{tool_log_idx - 1}/status=completed")
                            yield encoder.encode(
                                StateDeltaEvent(
                                    delta=[
                                        {
                                            "op": "replace",
                                            "path": f"/tool_logs/{tool_log_idx - 1}/status",
                                            "value": "completed",
                                        },
                                        {
                                            "op": "replace",
                                            "path": f"/tool_logs/{tool_log_idx - 1}/message",
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
                    if tool_log_idx > 0:
                        tracer.log_agui("STATE_DELTA", f"replace /tool_logs/{tool_log_idx - 1}/message=awaiting")
                        yield encoder.encode(
                            StateDeltaEvent(
                                delta=[
                                    {
                                        "op": "replace",
                                        "path": f"/tool_logs/{tool_log_idx - 1}/message",
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
