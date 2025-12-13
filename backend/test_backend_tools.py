"""
Backend Tool Tests for AG-UI Implementation
Tests server-side tool execution (get_weather, calculate)

Run with: python test_backend_tools.py
"""
import asyncio
import sys
import json
import httpx

from ag_ui.core import EventType
from test_utils import start_server, stop_server, stream_sse_events


async def test_backend_tool_get_weather():
    """Test backend tool execution (get_weather) via AG-UI protocol"""
    print("\n" + "="*60)
    print("TEST: Backend Tool - get_weather (AG-UI Protocol)")
    print("="*60)

    async with httpx.AsyncClient(timeout=60.0) as client:
        events = await stream_sse_events(client, {
            "messages": [
                {"role": "user", "content": "What is the weather in Tokyo? Use the get_weather tool."}
            ],
            "frontendTools": []
        })
        print(f"Received {len(events)} SSE events")

        run_started = None
        run_finished = None
        tool_call_start = None
        tool_call_result = None

        for event in events:
            etype = event.get("type")
            print(f"  [{etype}] {json.dumps({k:v for k,v in event.items() if k not in ['type', 'timestamp']})[:70]}")

            if etype == EventType.RUN_STARTED:
                run_started = event
            if etype == EventType.RUN_FINISHED:
                run_finished = event
            if etype == EventType.TOOL_CALL_START:
                tool_call_start = event
            if etype == EventType.TOOL_CALL_RESULT:
                tool_call_result = event

        assert run_started is not None, "Expected RUN_STARTED event"
        assert run_finished is not None, "Expected RUN_FINISHED event"
        assert tool_call_start is not None, "Expected TOOL_CALL_START event"
        assert tool_call_start.get("toolCallName") == "get_weather", f"Expected get_weather, got {tool_call_start.get('toolCallName')}"
        assert tool_call_result is not None, "Expected TOOL_CALL_RESULT event"
        assert "Tokyo" in tool_call_result.get("content", ""), "Expected Tokyo in result"

        print("\n✅ Backend get_weather test PASSED!")
        print(f"   Tool: {tool_call_start.get('toolCallName')}")
        print(f"   Result: {tool_call_result.get('content')}")
        return True


async def test_backend_tool_calculate():
    """Test backend tool execution (calculate) via AG-UI protocol"""
    print("\n" + "="*60)
    print("TEST: Backend Tool - calculate (AG-UI Protocol)")
    print("="*60)

    async with httpx.AsyncClient(timeout=60.0) as client:
        events = await stream_sse_events(client, {
            "messages": [
                {"role": "user", "content": "Calculate 15 * 7 using the calculate tool."}
            ],
            "frontendTools": []
        })
        print(f"Received {len(events)} SSE events")

        tool_call_start = None
        tool_call_result = None

        for event in events:
            etype = event.get("type")
            print(f"  [{etype}] {json.dumps({k:v for k,v in event.items() if k not in ['type', 'timestamp']})[:70]}")

            if etype == EventType.TOOL_CALL_START:
                tool_call_start = event
            if etype == EventType.TOOL_CALL_RESULT:
                tool_call_result = event

        assert tool_call_start is not None, "Expected TOOL_CALL_START event"
        assert tool_call_start.get("toolCallName") == "calculate", f"Expected calculate, got {tool_call_start.get('toolCallName')}"
        assert tool_call_result is not None, "Expected TOOL_CALL_RESULT event"
        assert "105" in tool_call_result.get("content", ""), "Expected 105 in result"

        print("\n✅ Backend calculate test PASSED!")
        print(f"   Tool: {tool_call_start.get('toolCallName')}")
        print(f"   Result: {tool_call_result.get('content')}")
        return True


async def run_backend_tests():
    """Run all backend tool tests"""
    print("\n" + "="*60)
    print("BACKEND TOOL TESTS (AG-UI Protocol)")
    print("="*60)

    results = {}
    tests = [
        ("get_weather", test_backend_tool_get_weather),
        ("calculate", test_backend_tool_calculate),
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

    print("\n" + "="*60)
    print("BACKEND TEST SUMMARY")
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

        success = asyncio.run(run_backend_tests())
        sys.exit(0 if success else 1)
    finally:
        stop_server()


if __name__ == "__main__":
    main()
