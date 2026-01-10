"""
Haiku Poet Tool

Backend tool that invokes a sub-agent to generate love haikus about a given topic.
"""

from __future__ import annotations

import os
from typing import Annotated, TypedDict

from langchain_core.messages import BaseMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from tracing import tracer


# ============= HAIKU POET SUB-AGENT =============
class HaikuAgentState(TypedDict):
    """State for the haiku poet sub-agent."""

    messages: Annotated[list[BaseMessage], add_messages]
    topic: str


HAIKU_POET_SYSTEM_PROMPT = """You are a professional haiku poet specializing in love poems.

When given a topic, write a beautiful haiku (5-7-5 syllable structure) about it, with themes of love, beauty, or tenderness woven in.

Respond ONLY with the haiku itself, formatted with each line on a separate line. No explanations, no title, just the haiku."""


async def haiku_poet_node(state: HaikuAgentState) -> dict:
    """Generate a love haiku about the given topic."""
    topic = state.get("topic", "love")
    tracer.log_event("HAIKU_POET_START", f"topic={topic}")

    MODEL = os.getenv("MODEL", "amazon/nova-2-lite-v1:free")

    # Create a separate model instance for the sub-agent (no tools)
    haiku_model = ChatOpenAI(
        model=MODEL,
        base_url="https://openrouter.ai/api/v1",
        api_key=os.getenv("OPENROUTER_API_KEY"),
    )

    messages = [
        {"role": "system", "content": HAIKU_POET_SYSTEM_PROMPT},
        {"role": "user", "content": f"Write a love haiku about: {topic}"},
    ]

    response = await haiku_model.ainvoke(messages)
    tracer.log_event("HAIKU_POET_RESPONSE", f"content={str(response.content)[:100]}")

    return {"messages": [response]}


# Build and compile the haiku poet sub-agent graph
haiku_workflow = StateGraph(HaikuAgentState)
haiku_workflow.add_node("poet", haiku_poet_node)
haiku_workflow.add_edge(START, "poet")
haiku_workflow.add_edge("poet", END)
haiku_agent = haiku_workflow.compile()


# ============= TOOL HANDLER =============
async def haiku_poet(topic: str) -> str:
    """Backend tool that invokes the haiku poet sub-agent."""
    tracer.log_event("HAIKU_POET_TOOL", f"invoking sub-agent with topic={topic}")

    # Invoke the compiled sub-agent graph
    input_state: HaikuAgentState = {"messages": [], "topic": topic}
    result = await haiku_agent.ainvoke(input_state)

    # Extract haiku from the last message
    last_msg = result["messages"][-1]
    haiku = last_msg.content if hasattr(last_msg, "content") else str(last_msg)

    tracer.log_event("HAIKU_POET_RESULT", f"haiku={haiku[:50]}...")
    return haiku
