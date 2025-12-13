"""
Frontend Tool Tests for AG-UI Implementation
Tests client-side tool calls (greet, setTheme) - server streams call, NO result

Run with: python test_frontend_tools.py
"""
import asyncio
import sys
import json
import httpx

from ag_ui.core import EventType
from test_utils import start_server, stop_server, stream_sse_events


async def test_frontend_tool_greet():
    """Test frontend tool (greet) - server streams call, NO result (client executes)"""
    print("\n" + "="*60)
    print("TEST: Frontend Tool - greet (AG-UI Protocol)")
    print("="*60)

    async with httpx.AsyncClient(timeout=60.0) as client:
        events = await stream_sse_events(client, {
            "messages": [
                {"role": "user", "content": "Please greet Alice using the greet tool."}
            ],
            "frontendTools": [
                {
                    "name": "greet",
                    "description": "Greet a person by name with a friendly message",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "The name of the person to greet"}
                        },
                        "required": ["name"]
                    }
                }
            ]
        })
        print(f"Received {len(events)} SSE events")

        tool_call_start = None
        tool_call_args = []
        tool_call_end = None
        tool_call_result = None

        for event in events:
            etype = event.get("type")
            print(f"  [{etype}] {json.dumps({k:v for k,v in event.items() if k not in ['type', 'timestamp']})[:70]}")

            if etype == EventType.TOOL_CALL_START:
                tool_call_start = event
            if etype == EventType.TOOL_CALL_ARGS:
                tool_call_args.append(event)
            if etype == EventType.TOOL_CALL_END:
                tool_call_end = event
            if etype == EventType.TOOL_CALL_RESULT:
                tool_call_result = event

        assert tool_call_start is not None, "Expected TOOL_CALL_START event"
        assert tool_call_start.get("toolCallName") == "greet", f"Expected greet, got {tool_call_start.get('toolCallName')}"
        assert tool_call_end is not None, "Expected TOOL_CALL_END event"
        # Frontend tools should NOT have TOOL_CALL_RESULT from server
        assert tool_call_result is None, "Frontend tools should NOT have TOOL_CALL_RESULT from server"

        full_args = "".join(e.get("delta", "") for e in tool_call_args)
        print("\n✅ Frontend greet test PASSED!")
        print(f"   Tool: {tool_call_start.get('toolCallName')}")
        print(f"   Args: {full_args}")
        print("   (No server result - frontend would execute this)")
        return True


async def test_frontend_tool_setTheme():
    """Test frontend tool (setTheme) via AG-UI protocol"""
    print("\n" + "="*60)
    print("TEST: Frontend Tool - setTheme (AG-UI Protocol)")
    print("="*60)

    async with httpx.AsyncClient(timeout=60.0) as client:
        events = await stream_sse_events(client, {
            "messages": [
                {"role": "user", "content": "Change the theme to lightblue using the setTheme tool."}
            ],
            "frontendTools": [
                {
                    "name": "setTheme",
                    "description": "Change the page theme/background color",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "color": {"type": "string", "description": "The background color"}
                        },
                        "required": ["color"]
                    }
                }
            ]
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
        assert tool_call_start.get("toolCallName") == "setTheme", f"Expected setTheme, got {tool_call_start.get('toolCallName')}"
        assert tool_call_result is None, "Frontend tools should NOT have TOOL_CALL_RESULT"

        print("\n✅ Frontend setTheme test PASSED!")
        print(f"   Tool: {tool_call_start.get('toolCallName')}")
        return True


async def run_frontend_tests():
    """Run all frontend tool tests"""
    print("\n" + "="*60)
    print("FRONTEND TOOL TESTS (AG-UI Protocol)")
    print("="*60)

    results = {}
    tests = [
        ("greet", test_frontend_tool_greet),
        ("setTheme", test_frontend_tool_setTheme),
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
    print("FRONTEND TEST SUMMARY")
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

        success = asyncio.run(run_frontend_tests())
        sys.exit(0 if success else 1)
    finally:
        stop_server()


if __name__ == "__main__":
    main()
