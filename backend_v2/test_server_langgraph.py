"""
Test for LangGraph-based AG-UI Backend with PostHog-style Send() pattern.

Tests that each tool call is processed individually via Send(), with:
- Backend tools executing immediately (one per Send)
- Frontend tools triggering interrupt
"""

import json
import pytest
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


class TestSendPatternToolRouting:
    """Test the PostHog-style Send() pattern for tool routing."""

    @pytest.mark.asyncio
    async def test_mixed_tools_be_be_fe_be_fe(self):
        """
        E2E test: LLM returns [BE, BE, FE, BE, FE] tool calls.

        With sequential execution:
        1. Tools execute one at a time in order
        2. BE1 executes → BE2 executes → FE1 triggers interrupt
        3. BE3 and FE2 are NOT reached (paused waiting for frontend)
        4. No errors occur
        """
        from fastapi.testclient import TestClient
        from server_langgraph import app

        # LLM returns 5 tool calls: BE, BE, FE, BE, FE
        mock_response = AIMessage(
            content="",
            tool_calls=[
                {"id": "be_1", "name": "get_weather", "args": {"city": "Tokyo"}},
                {"id": "be_2", "name": "get_weather", "args": {"city": "London"}},
                {"id": "fe_1", "name": "greet", "args": {"name": "Alice"}},
                {"id": "be_3", "name": "get_weather", "args": {"city": "Paris"}},
                {"id": "fe_2", "name": "greet", "args": {"name": "Bob"}},
            ],
        )

        with patch("server_langgraph.model") as mock_model:
            mock_model.invoke.return_value = mock_response

            client = TestClient(app)
            response = client.post(
                "/chat",
                json={"message": "get weather in Tokyo, London, Paris and greet Alice and Bob"},
            )

            assert response.status_code == 200

            # Parse SSE events
            events = []
            for line in response.text.split("\n"):
                if line.startswith("data:"):
                    try:
                        events.append(json.loads(line[5:].strip()))
                    except json.JSONDecodeError:
                        pass

            # Check for errors
            error_events = [e for e in events if e.get("type") == "CUSTOM" and e.get("name") == "error"]
            assert len(error_events) == 0, f"Got error events: {error_events}"

            # Verify all 5 tool calls were started
            tool_call_starts = [e for e in events if e.get("type") == "TOOL_CALL_START"]
            assert len(tool_call_starts) == 5, f"Expected 5 tool calls, got {len(tool_call_starts)}"

            # Verify tool call order matches: be_1, be_2, fe_1, be_3, fe_2
            tool_ids = [e.get("toolCallId") for e in tool_call_starts]
            assert tool_ids == ["be_1", "be_2", "fe_1", "be_3", "fe_2"], f"Wrong order: {tool_ids}"

            # With sequential execution, only 2 backend tools complete before FE1 interrupt
            tool_results = [e for e in events if e.get("type") == "TOOL_CALL_RESULT"]
            assert len(tool_results) == 2, f"Expected 2 backend results before interrupt, got {len(tool_results)}"

            # Verify backend results are for BE1 and BE2 (in order, before FE1)
            result_tool_ids = [e.get("toolCallId") for e in tool_results]
            assert result_tool_ids == ["be_1", "be_2"], f"Wrong backend tools or order: {result_tool_ids}"

            # Verify frontend tool triggered interrupt
            interrupt_events = [
                e for e in events
                if e.get("type") == "CUSTOM" and e.get("name") in ("run_interrupted", "frontend_tool_required")
            ]
            assert len(interrupt_events) > 0, "Expected interrupt for frontend tool"

            # Verify the interrupt is for fe_1 (the first frontend tool)
            fe_required = [e for e in events if e.get("type") == "CUSTOM" and e.get("name") == "frontend_tool_required"]
            assert len(fe_required) > 0, "Expected frontend_tool_required event"
            assert fe_required[0].get("value", {}).get("tool_call_id") == "fe_1"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
