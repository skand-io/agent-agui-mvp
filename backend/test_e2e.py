"""
E2E Tests for Minimal AG-UI Implementation
Runs all backend and frontend tool tests via SSE streaming

AG-UI Protocol Events (Full Compliance):
- RUN_STARTED/FINISHED: Lifecycle with input/result fields
- STEP_STARTED/FINISHED: Progress tracking
- TEXT_MESSAGE_START/CONTENT/END: Text streaming
- TOOL_CALL_START/ARGS/END/RESULT: Tool execution

Run with: python test_e2e.py
Or run individual test files:
  - python test_backend_tools.py
  - python test_frontend_tools.py
"""
import asyncio
import sys
import json
import httpx

from ag_ui.core import EventType
from test_utils import start_server, stop_server, stream_sse_events
from test_backend_tools import test_backend_tool_get_weather, test_backend_tool_calculate
from test_frontend_tools import test_frontend_tool_greet, test_frontend_tool_setTheme


async def test_protocol_compliance():
    """Test AG-UI protocol compliance: timestamps, result field, and step events"""
    print("\n" + "="*60)
    print("TEST: AG-UI Protocol Compliance")
    print("="*60)

    async with httpx.AsyncClient(timeout=60.0) as client:
        events = await stream_sse_events(client, {
            "messages": [
                {"role": "user", "content": "Say hi"}
            ],
            "frontendTools": []
        })
        print(f"Received {len(events)} SSE events")

        # Check RUN_STARTED has timestamp
        run_started = next((e for e in events if e.get("type") == "RUN_STARTED"), None)
        assert run_started is not None, "Expected RUN_STARTED event"
        assert "timestamp" in run_started, "RUN_STARTED should have 'timestamp' field (AG-UI spec)"
        print(f"  ✓ RUN_STARTED has timestamp: {run_started.get('timestamp')}")

        # Check STEP events for llm_inference
        step_started_events = [e for e in events if e.get("type") == "STEP_STARTED"]
        step_finished_events = [e for e in events if e.get("type") == "STEP_FINISHED"]

        assert len(step_started_events) >= 1, "Expected at least one STEP_STARTED event"
        assert len(step_finished_events) >= 1, "Expected at least one STEP_FINISHED event"

        # AG-UI library uses camelCase in JSON output (stepName not step_name)
        llm_step_started = next((e for e in step_started_events if e.get("stepName") == "llm_inference"), None)
        llm_step_finished = next((e for e in step_finished_events if e.get("stepName") == "llm_inference"), None)

        assert llm_step_started is not None, "Expected STEP_STARTED for 'llm_inference'"
        assert llm_step_finished is not None, "Expected STEP_FINISHED for 'llm_inference'"
        assert "timestamp" in llm_step_started, "STEP_STARTED should have timestamp"
        print(f"  ✓ STEP_STARTED/FINISHED for llm_inference present with timestamps")

        # Check RUN_FINISHED has result and timestamp
        run_finished = next((e for e in events if e.get("type") == "RUN_FINISHED"), None)
        assert run_finished is not None, "Expected RUN_FINISHED event"
        assert "result" in run_finished, "RUN_FINISHED should have 'result' field (AG-UI spec)"
        assert "timestamp" in run_finished, "RUN_FINISHED should have 'timestamp' field"
        print(f"  ✓ RUN_FINISHED has result: {list(run_finished.get('result', {}).keys())}")
        print(f"  ✓ RUN_FINISHED has timestamp: {run_finished.get('timestamp')}")

        print("\n✅ Protocol compliance test PASSED!")
        return True


async def test_text_response():
    """Test regular text response (no tools) via AG-UI protocol"""
    print("\n" + "="*60)
    print("TEST: Text Response (AG-UI Protocol)")
    print("="*60)

    async with httpx.AsyncClient(timeout=60.0) as client:
        events = await stream_sse_events(client, {
            "messages": [
                {"role": "user", "content": "Say hello in exactly 3 words."}
            ],
            "frontendTools": []
        })
        print(f"Received {len(events)} SSE events")

        text_start = None
        text_content = []
        text_end = None

        for event in events:
            etype = event.get("type")
            if etype == EventType.TEXT_MESSAGE_START:
                text_start = event
            if etype == EventType.TEXT_MESSAGE_CONTENT:
                text_content.append(event.get("delta", ""))
            if etype == EventType.TEXT_MESSAGE_END:
                text_end = event

        full_text = "".join(text_content)
        print(f"  Response: {full_text}")

        assert text_start is not None, "Expected TEXT_MESSAGE_START event"
        assert len(full_text) > 0, "Expected non-empty text response"
        assert text_end is not None, "Expected TEXT_MESSAGE_END event"

        print("\n✅ Text response test PASSED!")
        return True


async def run_all_tests():
    """Run all e2e tests"""
    print("\n" + "="*60)
    print("AG-UI PROTOCOL E2E TESTS")
    print("="*60)

    results = {}

    tests = [
        # Protocol compliance (run first to verify basic structure)
        ("protocol_compliance", test_protocol_compliance),
        # Backend tools
        ("backend_get_weather", test_backend_tool_get_weather),
        ("backend_calculate", test_backend_tool_calculate),
        # Frontend tools
        ("frontend_greet", test_frontend_tool_greet),
        ("frontend_setTheme", test_frontend_tool_setTheme),
        # Text response
        ("text_response", test_text_response),
    ]

    for i, (name, test_fn) in enumerate(tests):
        if i > 0:
            print("\n⏳ Waiting 15s to avoid rate limiting...")
            await asyncio.sleep(15)
        try:
            results[name] = await test_fn()
        except Exception as e:
            print(f"\n❌ {name} test FAILED: {e}")
            results[name] = False

    # Summary
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)

    passed = sum(1 for v in results.values() if v)
    total = len(results)

    for test_name, passed_test in results.items():
        status = "✅ PASSED" if passed_test else "❌ FAILED"
        print(f"  {test_name}: {status}")

    print(f"\n{passed}/{total} tests passed")
    return all(results.values())


def main():
    """Main entry point"""
    try:
        if not start_server():
            print("Could not start server. Exiting.")
            sys.exit(1)

        success = asyncio.run(run_all_tests())
        sys.exit(0 if success else 1)
    finally:
        stop_server()


if __name__ == "__main__":
    main()
