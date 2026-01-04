"""
Test for LangGraph-based AG-UI Backend.

Tests mixed tool calls (backend + frontend) to ensure proper sequential routing.
"""

import json
import pytest
from unittest.mock import patch, MagicMock

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


class TestSequentialToolRouting:
    """Test that sequential tool calls are routed correctly: BE, BE, FE, BE, FE."""

    @pytest.mark.asyncio
    async def test_sequential_tool_routing(self):
        """
        E2E test: LLM returns [BE, BE, FE, BE, FE] tool calls.

        Simulates realistic flow:
        1. First LLM call returns all 5 tools
        2. Backend tools (BE1, BE2, BE3) are processed
        3. Agent loops back, second LLM call returns FE1 (model sees BE results)
        4. FE1 triggers interrupt
        """
        from fastapi.testclient import TestClient
        from server_langgraph import app

        # First LLM response: returns all 5 tool calls
        first_response = AIMessage(
            content="",
            tool_calls=[
                {"id": "be_1", "name": "get_weather", "args": {"city": "Tokyo"}},
                {"id": "be_2", "name": "get_weather", "args": {"city": "London"}},
                {"id": "fe_1", "name": "greet", "args": {"name": "Alice"}},
                {"id": "be_3", "name": "get_weather", "args": {"city": "Paris"}},
                {"id": "fe_2", "name": "greet", "args": {"name": "Bob"}},
            ],
        )

        # Second LLM response: after seeing backend results, calls frontend tool
        second_response = AIMessage(
            content="",
            tool_calls=[
                {"id": "fe_1", "name": "greet", "args": {"name": "Alice"}},
            ],
        )

        call_count = 0

        def mock_invoke(messages):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return first_response
            return second_response

        with patch("server_langgraph.model") as mock_model:
            mock_model.invoke.side_effect = mock_invoke

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

            # Verify tool calls were started (5 from first response + 1 from second)
            tool_call_starts = [e for e in events if e.get("type") == "TOOL_CALL_START"]
            assert len(tool_call_starts) == 6, f"Expected 6 tool calls, got {len(tool_call_starts)}: {[e.get('toolCallId') for e in tool_call_starts]}"

            # First 5 should be from initial response
            first_five = tool_call_starts[:5]
            first_five_ids = [e.get("toolCallId") for e in first_five]
            assert first_five_ids == ["be_1", "be_2", "fe_1", "be_3", "fe_2"], f"Wrong initial order: {first_five_ids}"

            # Verify all 3 backend tools got results
            tool_results = [e for e in events if e.get("type") == "TOOL_CALL_RESULT"]
            assert len(tool_results) == 3, f"Expected 3 backend results, got {len(tool_results)}"

            # Verify backend results are for the correct tools
            result_tool_ids = [e.get("toolCallId") for e in tool_results]
            assert set(result_tool_ids) == {"be_1", "be_2", "be_3"}, f"Wrong backend tools: {result_tool_ids}"

            # Verify frontend tool triggered interrupt
            interrupt_events = [
                e for e in events
                if e.get("type") == "CUSTOM" and e.get("name") in ("run_interrupted", "frontend_tool_required")
            ]
            assert len(interrupt_events) > 0, "Expected interrupt for frontend tool"

            # Verify the model was called twice (initial + after backend results)
            assert call_count == 2, f"Expected 2 model calls, got {call_count}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
