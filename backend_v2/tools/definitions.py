"""
Tool definitions and schemas for the LLM.

This module contains:
- Sets defining which tools are frontend vs backend
- Tool schemas in OpenAI function format for binding to the LLM
"""

# Sets defining tool types
FRONTEND_TOOLS = {"greet"}
BACKEND_TOOLS = {"get_weather", "haiku_poet", "calculator_agent_tool"}

# Tool definitions for LLM (OpenAI function format)
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
    {
        "type": "function",
        "function": {
            "name": "haiku_poet",
            "description": "Write a beautiful love haiku about a given topic. Use this when the user asks for poetry, haikus, or creative writing about love.",
            "parameters": {
                "type": "object",
                "properties": {
                    "topic": {
                        "type": "string",
                        "description": "The topic to write a love haiku about",
                    }
                },
                "required": ["topic"],
            },
        },
    },
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
]
