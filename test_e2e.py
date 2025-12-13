"""
E2E Tests for Minimal AG-UI Implementation
Runs all backend and frontend tool tests via SSE streaming

AG-UI Protocol Events:
- RUN_STARTED/FINISHED: Lifecycle
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
