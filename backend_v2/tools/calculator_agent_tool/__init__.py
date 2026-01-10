"""
Calculator Agent Tool

A sub-agent that performs arithmetic operations using 4 internal tools:
add, subtract, multiply, divide.
"""

from __future__ import annotations

import os
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from tracing import tracer


# ============= INTERNAL MATH TOOLS =============
def add(a: float, b: float) -> float:
    """Add two numbers."""
    return a + b


def subtract(a: float, b: float) -> float:
    """Subtract b from a."""
    return a - b


def multiply(a: float, b: float) -> float:
    """Multiply two numbers."""
    return a * b


def divide(a: float, b: float) -> str | float:
    """Divide a by b. Returns error string if b is zero."""
    if b == 0:
        return "Error: Division by zero"
    return a / b


MATH_TOOL_HANDLERS = {
    "add": add,
    "subtract": subtract,
    "multiply": multiply,
    "divide": divide,
}

# Tool definitions for the sub-agent's LLM
MATH_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "add",
            "description": "Add two numbers together",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "number", "description": "First number"},
                    "b": {"type": "number", "description": "Second number"},
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "subtract",
            "description": "Subtract the second number from the first",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "number", "description": "Number to subtract from"},
                    "b": {"type": "number", "description": "Number to subtract"},
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "multiply",
            "description": "Multiply two numbers together",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "number", "description": "First number"},
                    "b": {"type": "number", "description": "Second number"},
                },
                "required": ["a", "b"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "divide",
            "description": "Divide the first number by the second",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {"type": "number", "description": "Dividend (number to divide)"},
                    "b": {"type": "number", "description": "Divisor (number to divide by)"},
                },
                "required": ["a", "b"],
            },
        },
    },
]


# ============= SUB-AGENT STATE =============
class CalculatorAgentState(TypedDict):
    """State for the calculator sub-agent."""
    messages: Annotated[list[BaseMessage], add_messages]
    request: str


CALCULATOR_SYSTEM_PROMPT = """You are a calculator assistant. You have access to 4 math tools: add, subtract, multiply, divide.

Given a math request, use these tools to compute the answer. You may need to chain multiple operations.

Rules:
- Always use the tools to perform calculations - never calculate in your head
- After getting all results, respond with ONLY the final numeric answer
- If there's a division by zero error, respond with the error message

Examples:
- "add 5 and 3" → use add(5, 3) → respond "8"
- "add 5 and 3, then multiply by 2" → use add(5, 3) → get 8 → use multiply(8, 2) → respond "16"
"""


# ============= GRAPH NODES =============
async def calculator_agent_node(state: CalculatorAgentState) -> dict:
    """LLM node that decides which math tools to call."""
    tracer.log_event("CALC_AGENT_NODE", f"messages={len(state['messages'])}")

    MODEL = os.getenv("MODEL", "amazon/nova-2-lite-v1:free")

    calc_model = ChatOpenAI(
        model=MODEL,
        base_url="https://openrouter.ai/api/v1",
        api_key=os.getenv("OPENROUTER_API_KEY"),
    ).bind_tools(MATH_TOOLS)

    # Build messages with system prompt
    messages = [{"role": "system", "content": CALCULATOR_SYSTEM_PROMPT}]

    # Add the initial request if this is the first call
    if len(state["messages"]) == 0:
        messages.append({"role": "user", "content": state["request"]})
    else:
        # Continue with existing conversation
        messages.extend(state["messages"])

    response = await calc_model.ainvoke(messages)
    tracer.log_event("CALC_AGENT_RESPONSE", f"content={str(response.content)[:50]}, tools={len(response.tool_calls or [])}")

    return {"messages": [response]}


def route_calculator_tools(state: CalculatorAgentState) -> str:
    """Route to tool executor or end based on whether there are tool calls."""
    last_message = state["messages"][-1]

    if isinstance(last_message, AIMessage) and last_message.tool_calls:
        tracer.log_event("CALC_ROUTE", "tool_executor")
        return "tool_executor"

    tracer.log_event("CALC_ROUTE", "end")
    return "end"


async def calculator_tool_executor(state: CalculatorAgentState) -> dict:
    """Execute all pending tool calls and return results."""
    last_message = state["messages"][-1]
    tool_messages = []

    for tc in last_message.tool_calls or []:
        tool_name = tc["name"]
        args = tc["args"]

        handler = MATH_TOOL_HANDLERS.get(tool_name)
        if handler:
            result = handler(**args)
            tracer.log_event("CALC_TOOL_EXEC", f"{tool_name}({args}) = {result}")
        else:
            result = f"Unknown tool: {tool_name}"

        tool_messages.append(ToolMessage(content=str(result), tool_call_id=tc["id"]))

    return {"messages": tool_messages}


# ============= BUILD SUB-AGENT GRAPH =============
calculator_workflow = StateGraph(CalculatorAgentState)

# Nodes
calculator_workflow.add_node("agent", calculator_agent_node)
calculator_workflow.add_node("tool_executor", calculator_tool_executor)

# Edges
calculator_workflow.add_edge(START, "agent")
calculator_workflow.add_conditional_edges(
    "agent",
    route_calculator_tools,
    {"tool_executor": "tool_executor", "end": END},
)
calculator_workflow.add_edge("tool_executor", "agent")  # Loop back to agent

calculator_agent = calculator_workflow.compile()


# ============= MAIN TOOL HANDLER =============
async def calculator_agent_tool(request: str) -> str:
    """
    Backend tool that invokes the calculator sub-agent.

    Args:
        request: Natural language math request (e.g., "add 5 and 3, then multiply by 2")

    Returns:
        The computed result as a string
    """
    tracer.log_event("CALCULATOR_TOOL", f"request={request}")

    input_state: CalculatorAgentState = {"messages": [], "request": request}
    result = await calculator_agent.ainvoke(input_state)

    # Extract final answer from the last message
    last_msg = result["messages"][-1]
    answer = last_msg.content if hasattr(last_msg, "content") else str(last_msg)

    tracer.log_event("CALCULATOR_RESULT", f"answer={answer}")
    return answer
