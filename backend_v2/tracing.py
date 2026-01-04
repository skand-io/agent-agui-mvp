"""
Tracing utilities for LangGraph function instrumentation.

Usage:
    from tracing import tracer

    # In a function:
    with tracer.trace("my_function", state=state):
        tracer.log_event("PROCESSING", "details here")
        result = do_something()
        tracer.log_output("my_function", result)
        return result

Toggle tracing via environment variable:
    TRACE=1 (enabled, default)
    TRACE=0 (disabled)
"""

from __future__ import annotations

import json
import os
import time
from contextlib import contextmanager
from typing import Any


class Tracer:
    """Simple tracer for instrumenting LangGraph function calls."""

    # ANSI color codes
    COLORS = {
        "reset": "\033[0m",
        "bold": "\033[1m",
        "dim": "\033[2m",
        "red": "\033[91m",
        "green": "\033[92m",
        "yellow": "\033[93m",
        "blue": "\033[94m",
        "magenta": "\033[95m",
        "cyan": "\033[96m",
        "white": "\033[97m",
    }

    # Node-specific colors
    NODE_COLORS = {
        "agent": "cyan",
        "route_tools": "yellow",
        "frontend_handler": "magenta",
        "backend_handler": "green",
        "__interrupt__": "red",
    }

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self.depth = 0
        self.call_count = 0

    def _color(self, text: str, color: str) -> str:
        return f"{self.COLORS.get(color, '')}{text}{self.COLORS['reset']}"

    def _indent(self) -> str:
        return "  " * self.depth

    def _format_value(self, value: Any, max_len: int = 200) -> str:
        """Format a value for logging, truncating if needed."""
        if isinstance(value, dict):
            # Special handling for state with messages
            if "messages" in value:
                msgs = value["messages"]
                msg_summary = []
                for m in msgs[-3:]:  # Show last 3 messages
                    if hasattr(m, "content"):
                        content = str(m.content)[:50]
                        msg_type = type(m).__name__
                        tool_calls = ""
                        if hasattr(m, "tool_calls") and m.tool_calls:
                            tc_names = [tc["name"] for tc in m.tool_calls]
                            tool_calls = f" tools={tc_names}"
                        msg_summary.append(f"{msg_type}({content!r}...{tool_calls})")
                    else:
                        msg_summary.append(str(m)[:50])
                return f"{{messages: [{', '.join(msg_summary)}] ({len(msgs)} total)}}"
            s = json.dumps(value, default=str)
        else:
            s = str(value)
        if len(s) > max_len:
            return s[: max_len - 3] + "..."
        return s

    @contextmanager
    def trace(self, func_name: str, **inputs):
        """Context manager for tracing function execution."""
        if not self.enabled:
            yield
            return

        self.call_count += 1
        call_id = self.call_count
        color = self.NODE_COLORS.get(func_name, "white")

        # Log entry
        timestamp = time.strftime("%H:%M:%S")
        header = self._color(f"[{timestamp}] #{call_id}", "dim")
        func_display = self._color(f"→ {func_name}", color)
        print(f"{self._indent()}{header} {func_display}")

        # Log inputs
        if inputs:
            for key, val in inputs.items():
                formatted = self._format_value(val)
                print(f"{self._indent()}  {self._color('input', 'dim')} {key}: {formatted}")

        self.depth += 1
        start_time = time.perf_counter()

        try:
            yield
        finally:
            elapsed = (time.perf_counter() - start_time) * 1000
            self.depth -= 1

            # Log exit
            time_str = self._color(f"({elapsed:.1f}ms)", "dim")
            exit_display = self._color(f"← {func_name}", color)
            print(f"{self._indent()}{header} {exit_display} {time_str}")

    def log_output(self, func_name: str, output: Any):
        """Log function output."""
        if not self.enabled:
            return
        node_color = self.NODE_COLORS.get(func_name, "white")
        formatted = self._format_value(output)
        print(f"{self._indent()}{self._color('output', node_color)}: {formatted}")

    def log_event(self, event_type: str, details: str = ""):
        """Log a stream event."""
        if not self.enabled:
            return
        timestamp = time.strftime("%H:%M:%S")
        header = self._color(f"[{timestamp}]", "dim")
        event_display = self._color(f"◆ {event_type}", "blue")
        print(f"{self._indent()}{header} {event_display} {details}")

    def log_routing(self, decision: str, reason: str = ""):
        """Log a routing decision."""
        if not self.enabled:
            return
        arrow = self._color("⤷", "yellow")
        decision_display = self._color(decision, "yellow")
        reason_display = self._color(f"({reason})", "dim") if reason else ""
        print(f"{self._indent()}  {arrow} routing to: {decision_display} {reason_display}")

    def log_agui(self, event_type: str, details: str = ""):
        """Log an AG-UI event being sent to the client."""
        if not self.enabled:
            return
        timestamp = time.strftime("%H:%M:%S")
        header = self._color(f"[{timestamp}]", "dim")
        # Use a different symbol and color for AG-UI events
        event_display = self._color(f"⟫ {event_type}", "green")
        details_display = self._color(details, "dim") if details else ""
        print(f"{self._indent()}{header} {event_display} {details_display}")


# Global tracer instance (toggle with TRACE=1 or TRACE=0)
tracer = Tracer(enabled=os.getenv("TRACE", "1") == "1")

