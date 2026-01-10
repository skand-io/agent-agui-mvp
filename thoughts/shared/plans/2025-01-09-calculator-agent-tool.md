# Calculator Agent Tool Implementation Plan

## Overview

Create a `calculator_agent_tool` - a sub-agent that receives natural language math requests and uses 4 internal tools (add, subtract, multiply, divide) to compute results. The sub-agent can chain multiple tool calls to solve multi-step problems.

## Current State Analysis

- Tools live in `tools/<tool_name>/__init__.py` with one folder per tool
- `haiku_poet` is a sub-agent but has **no tools** - just an LLM with a system prompt
- Tool registration happens in:
  - `tools/definitions.py`: BACKEND_TOOLS set + TOOLS list (LLM schemas)
  - `tools/__init__.py`: imports handler and adds to BACKEND_TOOL_HANDLERS

### Key Discoveries:
- Sub-agent pattern: `tools/haiku_poet/__init__.py:60-65` builds a StateGraph and compiles it
- The haiku sub-agent is a single-node graph (no tool loop) - we need a multi-node graph with routing
- Main agent tool handler at `server_langgraph.py:264-273` calls handlers with `**tool_call["args"]`

## Desired End State

A working `calculator_agent_tool` that:
1. Accepts natural language like `"add 5 and 3, then multiply the result by 2"`
2. Uses an internal LLM to decide which math tools to call
3. Chains tool calls: add(5, 3) → 8, then multiply(8, 2) → 16
4. Returns final result as a string

### Verification:
- User asks main agent: "What is 10 plus 5 divided by 3?"
- Main agent calls `calculator_agent_tool(request="calculate 10 plus 5 divided by 3")`
- Sub-agent chains: add(10, 5) → 15, divide(15, 3) → 5
- Returns "5.0"

## What We're NOT Doing

- No frontend tool integration (this is backend-only)
- No persistent state between calculator invocations
- No advanced math (exponents, roots, etc.) - just the 4 basic operations
- No expression parsing - the LLM decides tool order

## Implementation Approach

Create a LangGraph sub-agent with:
1. **4 internal tools**: add, subtract, multiply, divide (pure Python functions)
2. **Tool-calling loop**: agent node → route → tool executor → back to agent (until no more tools)
3. **Single entry point**: `calculator_agent_tool(request: str) -> str`

---

## Phase 1: Create Calculator Tool Folder Structure

### Overview
Set up the folder and define the 4 internal math tools.

### Changes Required:

#### 1. Create tool folder
**File**: `tools/calculator_agent_tool/__init__.py`

```python
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
```

### Success Criteria:

#### Automated Verification:
- [x] File compiles: `uv run python -m py_compile tools/calculator_agent_tool/__init__.py`

---

## Phase 2: Implement Sub-Agent Graph with Tool Loop

### Overview
Add the LangGraph state, nodes, and routing to enable multi-step tool calling.

### Changes Required:

#### 1. Add state and graph to calculator tool
**File**: `tools/calculator_agent_tool/__init__.py` (append to file)

```python
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
```

### Success Criteria:

#### Automated Verification:
- [x] File compiles: `uv run python -m py_compile tools/calculator_agent_tool/__init__.py`
- [x] Imports work: `uv run python -c "from tools.calculator_agent_tool import calculator_agent_tool; print('OK')"`

---

## Phase 3: Register with Main Agent

### Overview
Add the calculator tool to the main agent's tool definitions and handlers.

### Changes Required:

#### 1. Update tool definitions
**File**: `tools/definitions.py`

Add `"calculator_agent_tool"` to BACKEND_TOOLS set:
```python
BACKEND_TOOLS = {"get_weather", "haiku_poet", "calculator_agent_tool"}
```

Add schema to TOOLS list:
```python
{
    "type": "function",
    "function": {
        "name": "calculator_agent_tool",
        "description": "Perform arithmetic calculations. Supports chained operations like 'add 5 and 3, then multiply by 2'. Use this for any math calculations.",
        "parameters": {
            "type": "object",
            "properties": {
                "request": {
                    "type": "string",
                    "description": "Natural language math request describing the calculation to perform",
                }
            },
            "required": ["request"],
        },
    },
},
```

#### 2. Update tool handlers
**File**: `tools/__init__.py`

Add import:
```python
from tools.calculator_agent_tool import calculator_agent_tool
```

Add to BACKEND_TOOL_HANDLERS:
```python
BACKEND_TOOL_HANDLERS = {
    "get_weather": get_weather,
    "haiku_poet": haiku_poet,
    "calculator_agent_tool": calculator_agent_tool,
}
```

### Success Criteria:

#### Automated Verification:
- [x] All files compile: `uv run python -m py_compile tools/definitions.py tools/__init__.py`
- [x] Full import works: `uv run python -c "from tools import BACKEND_TOOL_HANDLERS; print(list(BACKEND_TOOL_HANDLERS.keys()))"`
- [x] Server imports: `uv run python -c "import server_langgraph; print('OK')"`

#### Manual Verification:
- [ ] Start server: `uv run python server_langgraph.py`
- [ ] Ask: "What is 10 plus 5?" → Should invoke calculator and return "15"
- [ ] Ask: "Add 100 and 50, then divide by 3" → Should return "50.0"
- [ ] Ask: "Divide 10 by 0" → Should return error message

---

## Testing Strategy

### Unit Tests:
- Test each math function directly: `add(5, 3) == 8`
- Test divide by zero: `divide(10, 0) == "Error: Division by zero"`

### Integration Tests:
- Invoke `calculator_agent_tool("add 5 and 3")` directly
- Verify multi-step: `calculator_agent_tool("add 10 and 5, then multiply by 2")`

### Manual Testing Steps:
1. Start the server
2. Send chat message asking for a simple calculation
3. Verify the calculator sub-agent is invoked
4. Test chained operations
5. Test division by zero error handling

---

## File Structure After Implementation

```
tools/
├── __init__.py                    # Updated with calculator import
├── definitions.py                 # Updated with calculator schema
├── get_weather/
│   └── __init__.py
├── haiku_poet/
│   └── __init__.py
└── calculator_agent_tool/         # NEW
    └── __init__.py                # Sub-agent with 4 math tools
```

---

## References

- Existing sub-agent pattern: `tools/haiku_poet/__init__.py`
- Tool registration: `tools/__init__.py`, `tools/definitions.py`
- Main agent tool handler: `server_langgraph.py:264-273`
