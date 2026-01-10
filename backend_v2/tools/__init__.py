"""
Tools module for AG-UI LangGraph Backend.

Exports:
- Tool definitions (TOOLS, FRONTEND_TOOLS, BACKEND_TOOLS)
- Backend tool handlers (BACKEND_TOOL_HANDLERS)
"""

from tools.definitions import FRONTEND_TOOLS, BACKEND_TOOLS, TOOLS
from tools.get_weather import get_weather
from tools.haiku_poet import haiku_poet
from tools.calculator_agent_tool import calculator_agent_tool

# Handler mapping for backend tools
BACKEND_TOOL_HANDLERS = {
    "get_weather": get_weather,
    "haiku_poet": haiku_poet,
    "calculator_agent_tool": calculator_agent_tool,
}

__all__ = [
    "FRONTEND_TOOLS",
    "BACKEND_TOOLS",
    "TOOLS",
    "BACKEND_TOOL_HANDLERS",
]
