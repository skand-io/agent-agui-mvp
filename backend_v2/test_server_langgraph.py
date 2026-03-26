"""
Tests for AG-UI Protocol Compliance in LangGraph Backend.

Verifies all AG-UI event types are emitted correctly.
"""

import json
import uuid
import pytest
from unittest.mock import patch

from langchain_core.messages import AIMessage


# ============= HELPERS =============

def parse_sse_events(response_text: str) -> list[dict]:
    """Parse SSE events from response text into list of dicts."""
    events = []
    for line in response_text.split("\n"):
        if line.startswith("data:"):
            try:
                events.append(json.loads(line[5:].strip()))
            except json.JSONDecodeError:
                pass
    return events


def events_of_type(events: list[dict], event_type: str) -> list[dict]:
    """Filter events by type."""
    return [e for e in events if e.get("type") == event_type]


def assert_all_event_types(events: list[dict], expected_types: list[str], label: str = "") -> None:
    """Assert that all expected event types appear at least once."""
    event_types_seen = {e.get("type") for e in events}
    missing = [t for t in expected_types if t not in event_types_seen]
    assert not missing, f"{label}Missing event types: {missing}. Seen: {sorted(event_types_seen)}"


# All AG-UI event types emitted in a happy-path tool flow (initial + resume)
ALL_HAPPY_PATH_EVENTS = [
    # Lifecycle
    "RUN_STARTED",
    "RUN_FINISHED",
    "STEP_STARTED",
    "STEP_FINISHED",
    # Text message (from final LLM response after tools)
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    # Thinking (wraps LLM calls)
    "THINKING_START",
    "THINKING_END",
    "THINKING_TEXT_MESSAGE_START",
    "THINKING_TEXT_MESSAGE_CONTENT",
    "THINKING_TEXT_MESSAGE_END",
    # Tool call
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
    # State management
    "STATE_SNAPSHOT",
    "STATE_DELTA",
    "MESSAGES_SNAPSHOT",
    # Activity
    "ACTIVITY_SNAPSHOT",
    "ACTIVITY_DELTA",
    # Custom
    "CUSTOM",
]


# ============= PROTOCOL COMPLIANCE TESTS =============

class TestAGUIProtocolCompliance:
    """Validates AG-UI protocol compliance for the LangGraph backend."""

    @pytest.mark.asyncio
    async def test_all_event_types_emitted(self):
        """
        Full flow: initial request (tools) + resume (text) must emit
        ALL AG-UI event types across both requests combined.

        Mock LLM responses include reasoning_content to trigger real
        THINKING events (as they would with a reasoning model like DeepSeek R1).
        """
        from fastapi.testclient import TestClient
        from server_langgraph import app

        thread_id = str(uuid.uuid4())
        run_id = str(uuid.uuid4())

        # Mock LLM: 1st call returns tool calls + reasoning, 2nd call returns text + reasoning
        first_response = AIMessage(
            content="",
            additional_kwargs={
                "reasoning_content": "The user wants weather for Tokyo and to greet Alice. I'll call get_weather and greet tools.",
            },
            tool_calls=[
                {"id": "tc_be_1", "name": "get_weather", "args": {"city": "Tokyo"}},
                {"id": "tc_fe_1", "name": "greet", "args": {"name": "Alice"}},
            ],
        )
        second_response = AIMessage(
            content="Weather is sunny and Alice has been greeted!",
            additional_kwargs={
                "reasoning_content": "Both tools completed. Weather result shows sunny in Tokyo. Greet result confirmed. I'll summarize.",
            },
        )

        call_count = 0

        def mock_invoke(messages):
            nonlocal call_count
            call_count += 1
            return first_response if call_count == 1 else second_response

        with patch("server_langgraph.model") as mock_model:
            mock_model.invoke.side_effect = mock_invoke

            client = TestClient(app)

            # === Phase 1: Initial request ===
            response = client.post(
                "/chat",
                json={
                    "thread_id": thread_id,
                    "run_id": run_id,
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "Get weather in Tokyo and greet Alice"}
                    ],
                    "tools": [],
                    "context": [],
                },
            )
            assert response.status_code == 200
            phase1_events = parse_sse_events(response.text)

            # === Phase 2: Resume with ToolMessage ===
            mock_model.invoke.side_effect = lambda msgs: second_response

            resume_response = client.post(
                "/chat",
                json={
                    "thread_id": thread_id,
                    "run_id": str(uuid.uuid4()),
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "Get weather in Tokyo and greet Alice"},
                        {"id": str(uuid.uuid4()), "role": "tool", "tool_call_id": "tc_fe_1", "content": "Greeted Alice"},
                    ],
                    "tools": [],
                    "context": [],
                },
            )
            assert resume_response.status_code == 200
            phase2_events = parse_sse_events(resume_response.text)

            # === Verify ALL event types across both phases ===
            all_events = phase1_events + phase2_events
            assert_all_event_types(all_events, ALL_HAPPY_PATH_EVENTS, "Combined flow: ")

    @pytest.mark.asyncio
    async def test_phase1_events(self):
        """Verify the specific events emitted during initial request with tools."""
        from fastapi.testclient import TestClient
        from server_langgraph import app

        thread_id = str(uuid.uuid4())
        run_id = str(uuid.uuid4())

        mock_response = AIMessage(
            content="",
            additional_kwargs={
                "reasoning_content": "User wants weather and greeting. Using get_weather for Tokyo and greet for Alice.",
            },
            tool_calls=[
                {"id": "tc_be_1", "name": "get_weather", "args": {"city": "Tokyo"}},
                {"id": "tc_fe_1", "name": "greet", "args": {"name": "Alice"}},
            ],
        )

        with patch("server_langgraph.model") as mock_model:
            mock_model.invoke.return_value = mock_response

            client = TestClient(app)
            response = client.post(
                "/chat",
                json={
                    "thread_id": thread_id,
                    "run_id": run_id,
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "Get weather in Tokyo and greet Alice"}
                    ],
                    "tools": [],
                    "context": [],
                },
            )
            assert response.status_code == 200
            events = parse_sse_events(response.text)

            # Lifecycle
            run_started = events_of_type(events, "RUN_STARTED")
            assert len(run_started) == 1
            assert run_started[0]["threadId"] == thread_id
            assert run_started[0]["runId"] == run_id

            # State/messages snapshots early
            assert len(events_of_type(events, "STATE_SNAPSHOT")) >= 1
            assert len(events_of_type(events, "MESSAGES_SNAPSHOT")) >= 1
            first_snapshot_idx = next(i for i, e in enumerate(events) if e.get("type") == "STATE_SNAPSHOT")
            first_tool_idx = next((i for i, e in enumerate(events) if e.get("type") == "TOOL_CALL_START"), len(events))
            assert first_snapshot_idx < first_tool_idx

            # Custom event (model_info)
            custom_events = events_of_type(events, "CUSTOM")
            assert any(e.get("name") == "model_info" for e in custom_events)

            # Thinking events
            assert len(events_of_type(events, "THINKING_START")) >= 1
            assert len(events_of_type(events, "THINKING_END")) >= 1
            assert len(events_of_type(events, "THINKING_TEXT_MESSAGE_START")) >= 1
            assert len(events_of_type(events, "THINKING_TEXT_MESSAGE_CONTENT")) >= 1
            assert len(events_of_type(events, "THINKING_TEXT_MESSAGE_END")) >= 1

            # Tool calls: both emitted
            tool_starts = events_of_type(events, "TOOL_CALL_START")
            assert len(tool_starts) == 2
            assert tool_starts[0]["toolCallId"] == "tc_be_1"
            assert tool_starts[1]["toolCallId"] == "tc_fe_1"
            assert len(events_of_type(events, "TOOL_CALL_ARGS")) == 2
            assert len(events_of_type(events, "TOOL_CALL_END")) == 2

            # TOOL_CALL_RESULT only for backend tool
            tool_results = events_of_type(events, "TOOL_CALL_RESULT")
            assert len(tool_results) == 1
            assert tool_results[0]["toolCallId"] == "tc_be_1"

            # Activity events
            assert len(events_of_type(events, "ACTIVITY_SNAPSHOT")) >= 1
            assert len(events_of_type(events, "ACTIVITY_DELTA")) >= 1

            # STATE_DELTA for tool_logs
            assert len(events_of_type(events, "STATE_DELTA")) >= 1

            # Steps
            assert len(events_of_type(events, "STEP_STARTED")) >= 1
            assert len(events_of_type(events, "STEP_FINISHED")) >= 1

            # RUN_FINISHED (not custom interrupt)
            assert len(events_of_type(events, "RUN_FINISHED")) == 1
            assert not any(e.get("name") == "frontend_tool_required" for e in custom_events)
            assert not any(e.get("name") == "run_interrupted" for e in custom_events)
            assert not any(e.get("name") == "run_paused" for e in custom_events)

    @pytest.mark.asyncio
    async def test_phase2_resume_events(self):
        """Verify events emitted during resume produce text content + thinking."""
        from fastapi.testclient import TestClient
        from server_langgraph import app

        thread_id = str(uuid.uuid4())

        first_response = AIMessage(
            content="",
            additional_kwargs={
                "reasoning_content": "Need weather and greet tools.",
            },
            tool_calls=[
                {"id": "tc_be_1", "name": "get_weather", "args": {"city": "Tokyo"}},
                {"id": "tc_fe_1", "name": "greet", "args": {"name": "Alice"}},
            ],
        )
        second_response = AIMessage(
            content="Done! Tokyo is sunny and Alice was greeted.",
            additional_kwargs={
                "reasoning_content": "All tools done. Summarizing results for the user.",
            },
        )

        call_count = 0

        def mock_invoke(messages):
            nonlocal call_count
            call_count += 1
            return first_response if call_count == 1 else second_response

        with patch("server_langgraph.model") as mock_model:
            mock_model.invoke.side_effect = mock_invoke

            client = TestClient(app)

            # Phase 1: set up the interrupted graph state
            client.post(
                "/chat",
                json={
                    "thread_id": thread_id,
                    "run_id": str(uuid.uuid4()),
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "weather and greet"}
                    ],
                    "tools": [],
                    "context": [],
                },
            )

            # Phase 2: resume
            mock_model.invoke.side_effect = lambda msgs: second_response
            resume_response = client.post(
                "/chat",
                json={
                    "thread_id": thread_id,
                    "run_id": str(uuid.uuid4()),
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "tool", "tool_call_id": "tc_fe_1", "content": "Greeted Alice"},
                    ],
                    "tools": [],
                    "context": [],
                },
            )
            assert resume_response.status_code == 200
            events = parse_sse_events(resume_response.text)

            # Text content from final LLM response
            assert len(events_of_type(events, "TEXT_MESSAGE_START")) >= 1
            assert len(events_of_type(events, "TEXT_MESSAGE_CONTENT")) >= 1
            assert len(events_of_type(events, "TEXT_MESSAGE_END")) >= 1

            # Thinking events around LLM call
            assert len(events_of_type(events, "THINKING_START")) >= 1
            assert len(events_of_type(events, "THINKING_END")) >= 1

            # RUN_FINISHED
            assert len(events_of_type(events, "RUN_FINISHED")) == 1

    @pytest.mark.asyncio
    async def test_error_emits_run_error(self):
        """Mock LLM exception → RUN_ERROR event (not CUSTOM error)."""
        from fastapi.testclient import TestClient
        from server_langgraph import app

        with patch("server_langgraph.model") as mock_model:
            mock_model.invoke.side_effect = Exception("LLM connection failed")

            client = TestClient(app)
            response = client.post(
                "/chat",
                json={
                    "thread_id": str(uuid.uuid4()),
                    "run_id": str(uuid.uuid4()),
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "Hello"}
                    ],
                    "tools": [],
                    "context": [],
                },
            )
            assert response.status_code == 200
            events = parse_sse_events(response.text)

            # RUN_ERROR emitted
            run_errors = events_of_type(events, "RUN_ERROR")
            assert len(run_errors) == 1
            assert "LLM connection failed" in run_errors[0]["message"]

            # No CUSTOM error
            custom_errors = [e for e in events_of_type(events, "CUSTOM") if e.get("name") == "error"]
            assert len(custom_errors) == 0

    @pytest.mark.asyncio
    async def test_legacy_format_still_works(self):
        """POST with old {message, thread_id} format should still work."""
        from fastapi.testclient import TestClient
        from server_langgraph import app

        mock_response = AIMessage(content="Hello! How can I help?")

        with patch("server_langgraph.model") as mock_model:
            mock_model.invoke.return_value = mock_response

            client = TestClient(app)
            response = client.post(
                "/chat",
                json={"message": "Hello", "thread_id": str(uuid.uuid4())},
            )
            assert response.status_code == 200
            events = parse_sse_events(response.text)

            assert len(events_of_type(events, "RUN_STARTED")) == 1
            assert len(events_of_type(events, "RUN_FINISHED")) == 1
            assert len(events_of_type(events, "TEXT_MESSAGE_CONTENT")) >= 1


class TestSendPatternToolRouting:
    """Test the PostHog-style Send() pattern for tool routing."""

    @pytest.mark.asyncio
    async def test_mixed_tools_be_be_fe_be_fe(self):
        """
        LLM returns [BE, BE, FE, BE, FE] tool calls.
        Sequential execution: BE1 → BE2 → FE1 (interrupt → RUN_FINISHED).
        """
        from fastapi.testclient import TestClient
        from server_langgraph import app

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
                json={"message": "get weather and greet people"},
            )
            assert response.status_code == 200
            events = parse_sse_events(response.text)

            # No errors
            assert not any(e.get("type") == "RUN_ERROR" for e in events)

            # All 5 tool calls started
            tool_starts = events_of_type(events, "TOOL_CALL_START")
            assert len(tool_starts) == 5
            assert [e["toolCallId"] for e in tool_starts] == ["be_1", "be_2", "fe_1", "be_3", "fe_2"]

            # Only 2 BE results before FE interrupt
            tool_results = events_of_type(events, "TOOL_CALL_RESULT")
            assert len(tool_results) == 2
            assert [e["toolCallId"] for e in tool_results] == ["be_1", "be_2"]

            # RUN_FINISHED emitted
            assert len(events_of_type(events, "RUN_FINISHED")) == 1

            # No legacy custom interrupt events
            custom_events = events_of_type(events, "CUSTOM")
            assert not any(e.get("name") == "frontend_tool_required" for e in custom_events)
            assert not any(e.get("name") == "run_interrupted" for e in custom_events)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
