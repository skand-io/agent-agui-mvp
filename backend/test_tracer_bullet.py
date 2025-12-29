"""
Tracer Bullet E2E Test - Write this FIRST, it should FAIL.

This test defines the target behavior for FE/BE tool synchronization.
Run with: cd backend && uv run pytest test_tracer_bullet.py -v
"""
import json
import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch, MagicMock
from server import app


class TestTracerBullet:
    """
    E2E test for the complete FE/BE tool synchronization flow.

    Scenario: LLM calls [greet (FE), calculate (BE)] in one response
    Expected: Backend stops at greet, doesn't execute calculate yet
    """

    @pytest.fixture
    def client(self):
        return TestClient(app)

    def test_backend_stops_at_frontend_tool(self, client):
        """
        TRACER BULLET: Verify backend stops processing when it hits a FE tool.

        This is the core behavior we need to implement.
        The test should FAIL initially, then pass after Phase 1.
        """
        # Mock LLM to return both FE and BE tool calls
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].delta = MagicMock()

        # Create function mocks - need to set 'name' as a property, not constructor arg
        greet_function = MagicMock()
        greet_function.name = "greet"
        greet_function.arguments = '{"name":"John"}'

        calculate_function = MagicMock()
        calculate_function.name = "calculate"
        calculate_function.arguments = '{"expression":"5+3"}'

        mock_response.choices[0].delta.tool_calls = [
            MagicMock(index=0, id="call_fe_001", function=greet_function),
            MagicMock(index=1, id="call_be_001", function=calculate_function)
        ]
        mock_response.choices[0].delta.content = None
        mock_response.choices[0].finish_reason = "tool_calls"

        # Track which tools were executed
        executed_tools = []
        original_calculate = None

        def track_calculate(**kwargs):
            executed_tools.append("calculate")
            return "8"

        with patch('server.client.chat.completions.create') as mock_llm:
            mock_llm.return_value = iter([mock_response])

            # Patch calculate to track if it's called
            from server import BACKEND_TOOLS
            original_calculate = BACKEND_TOOLS["calculate"]["handler"]
            BACKEND_TOOLS["calculate"]["handler"] = track_calculate

            try:
                response = client.post(
                    "/chat",
                    json={
                        "messages": [{"role": "user", "content": "greet John and calculate 5+3"}],
                        "frontendTools": [{
                            "name": "greet",
                            "description": "Greet someone",
                            "parameters": {
                                "type": "object",
                                "properties": {"name": {"type": "string"}},
                                "required": ["name"]
                            }
                        }],
                        "threadId": "test-tracer",
                        "runId": "run-001"
                    },
                )

                # Parse SSE events
                events = []
                for line in response.iter_lines():
                    if line and line.startswith("data: "):
                        event_data = json.loads(line[6:])
                        events.append(event_data)

                # CRITICAL ASSERTION: calculate should NOT have been called
                # because backend should stop at greet (FE tool)
                assert "calculate" not in executed_tools, \
                    "Backend should NOT execute calculate when greet (FE) comes first!"

                # Verify we got TOOL_CALL_END for greet
                tool_call_ends = [e for e in events if e.get("type") == "TOOL_CALL_END"]
                greet_ended = any(e.get("toolCallId") == "call_fe_001" for e in tool_call_ends)
                assert greet_ended, "Should emit TOOL_CALL_END for greet"

                # Verify we got RUN_FINISHED
                run_finished = any(e.get("type") == "RUN_FINISHED" for e in events)
                assert run_finished, "Should emit RUN_FINISHED"

            finally:
                # Restore original handler
                BACKEND_TOOLS["calculate"]["handler"] = original_calculate

    def test_be_tools_execute_when_no_fe_tools(self, client):
        """
        Verify BE-only tools still execute normally.
        This should pass even before our changes (regression test).
        """
        response = client.post(
            "/chat",
            json={
                "messages": [{"role": "user", "content": "calculate 5+3"}],
                "frontendTools": [],
                "threadId": "test-be-only",
                "runId": "run-002"
            },
        )

        assert response.status_code == 200
        # Should get a response (existing behavior should work)

    def test_be_tool_before_fe_tool_still_stops(self, client):
        """
        Verify that when BE tool comes before FE tool, BE executes but stops at FE.

        Scenario: LLM calls [calculate (BE), greet (FE)]
        Expected: calculate executes, then stops at greet
        """
        # Mock LLM to return BE tool first, then FE tool
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].delta = MagicMock()

        # Create function mocks - need to set 'name' as a property, not constructor arg
        calc_function = MagicMock()
        calc_function.name = "calculate"
        calc_function.arguments = '{"expression":"5+3"}'

        greet_function = MagicMock()
        greet_function.name = "greet"
        greet_function.arguments = '{"name":"Jane"}'

        weather_function = MagicMock()
        weather_function.name = "get_weather"
        weather_function.arguments = '{"city":"Tokyo"}'

        mock_response.choices[0].delta.tool_calls = [
            MagicMock(index=0, id="call_be_first", function=calc_function),
            MagicMock(index=1, id="call_fe_second", function=greet_function),
            MagicMock(index=2, id="call_be_last", function=weather_function)
        ]
        mock_response.choices[0].delta.content = None
        mock_response.choices[0].finish_reason = "tool_calls"

        # Track which tools were executed
        executed_tools = []

        def track_calculate(**kwargs):
            executed_tools.append("calculate")
            return "8"

        def track_weather(**kwargs):
            executed_tools.append("get_weather")
            return "Weather: 20°C"

        with patch('server.client.chat.completions.create') as mock_llm:
            mock_llm.return_value = iter([mock_response])

            from server import BACKEND_TOOLS
            original_calculate = BACKEND_TOOLS["calculate"]["handler"]
            original_weather = BACKEND_TOOLS["get_weather"]["handler"]
            BACKEND_TOOLS["calculate"]["handler"] = track_calculate
            BACKEND_TOOLS["get_weather"]["handler"] = track_weather

            try:
                response = client.post(
                    "/chat",
                    json={
                        "messages": [{"role": "user", "content": "calculate 5+3, greet Jane, get weather Tokyo"}],
                        "frontendTools": [{
                            "name": "greet",
                            "description": "Greet someone",
                            "parameters": {
                                "type": "object",
                                "properties": {"name": {"type": "string"}},
                                "required": ["name"]
                            }
                        }],
                        "threadId": "test-be-fe-be",
                        "runId": "run-003"
                    },
                )

                # Parse SSE events
                events = []
                for line in response.iter_lines():
                    if line and line.startswith("data: "):
                        event_data = json.loads(line[6:])
                        events.append(event_data)

                # calculate (BE) should have executed since it comes before greet (FE)
                assert "calculate" in executed_tools, \
                    "calculate should execute since it comes before the FE tool"

                # get_weather (BE) should NOT have executed since it comes after greet (FE)
                assert "get_weather" not in executed_tools, \
                    "get_weather should NOT execute since it comes after greet (FE tool)"

            finally:
                BACKEND_TOOLS["calculate"]["handler"] = original_calculate
                BACKEND_TOOLS["get_weather"]["handler"] = original_weather
