"""
Shared test utilities for AG-UI E2E tests
"""
import subprocess
import time
import sys
import json
import httpx
from pathlib import Path
from typing import Optional

SERVER_URL = "http://localhost:8000"
SERVER_PROCESS: Optional[subprocess.Popen] = None

# Get the directory where this file is located (backend folder)
BACKEND_DIR = Path(__file__).parent.absolute()


def start_server():
    """Start the FastAPI server"""
    global SERVER_PROCESS
    print("Starting server...")
    SERVER_PROCESS = subprocess.Popen(
        [sys.executable, "server.py"],
        cwd=str(BACKEND_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    for _ in range(30):
        try:
            response = httpx.get(f"{SERVER_URL}/health", timeout=1)
            if response.status_code == 200:
                print("Server started successfully!")
                return True
        except:
            pass
        time.sleep(1)
    print("Failed to start server!")
    return False


def stop_server():
    """Stop the FastAPI server"""
    global SERVER_PROCESS
    if SERVER_PROCESS:
        print("Stopping server...")
        SERVER_PROCESS.terminate()
        SERVER_PROCESS.wait()
        SERVER_PROCESS = None


async def stream_sse_events(client: httpx.AsyncClient, payload: dict) -> list[dict]:
    """Stream SSE events from the server and collect them"""
    events = []
    async with client.stream(
        "POST",
        f"{SERVER_URL}/chat",
        json=payload,
        timeout=60.0
    ) as response:
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk
            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)
                for line in event_str.split("\n"):
                    if line.startswith("data: "):
                        try:
                            events.append(json.loads(line[6:]))
                        except json.JSONDecodeError:
                            pass
    return events
