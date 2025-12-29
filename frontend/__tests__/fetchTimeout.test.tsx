import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

import { CopilotProvider } from '../src/context/CopilotContext';
import { PayloadProvider } from '../src/context/PayloadContext';
import { useChatWithContext } from '../src/hooks/useChat';
import { EventType } from '../src/types';

// Helper to wrap hooks with both providers
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CopilotProvider>
    <PayloadProvider>{children}</PayloadProvider>
  </CopilotProvider>
);

// Helper to create SSE stream data
function createSSEStream(events: Array<{ type: string; [key: string]: unknown }>) {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n');
  return new TextEncoder().encode(lines + '\n\n');
}

describe('Fetch timeout handling', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('should include abort signal in fetch call', async () => {
    let receivedSignal: AbortSignal | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      receivedSignal = options?.signal as AbortSignal;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            createSSEStream([
              { type: EventType.RUN_STARTED, runId: 'test' },
              { type: EventType.RUN_FINISHED, runId: 'test' },
            ])
          );
          controller.close();
        },
      });

      return { body: stream };
    });

    const { result } = renderHook(() => useChatWithContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage('Test signal');
    });

    // Verify fetch was called with an AbortSignal
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    // The signal should not be aborted since the request completed successfully
    expect(receivedSignal?.aborted).toBe(false);
  });

  it('should handle AbortError gracefully when fetch is aborted', async () => {
    // Create a fetch that is immediately aborted
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      const signal = options?.signal as AbortSignal;

      // Simulate the abort happening immediately
      if (signal) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      return { body: null };
    });

    const { result } = renderHook(() => useChatWithContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage('Test abort');
    });

    // Should not crash, and should show an error message
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Messages should contain an error message
    const messages = result.current.messages;
    const errorMessage = messages.find(
      (m) => m.role === 'assistant' && m.content.includes('Error')
    );
    expect(errorMessage).toBeDefined();
  });

  it('should clear timeout after successful response', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    globalThis.fetch = vi.fn().mockImplementation(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            createSSEStream([
              { type: EventType.RUN_STARTED, runId: 'test' },
              { type: EventType.TEXT_MESSAGE_START, messageId: 'msg1' },
              { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'Hello' },
              { type: EventType.TEXT_MESSAGE_END, messageId: 'msg1' },
              { type: EventType.RUN_FINISHED, runId: 'test' },
            ])
          );
          controller.close();
        },
      });

      return { body: stream };
    });

    const { result } = renderHook(() => useChatWithContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage('Test clearTimeout');
    });

    // clearTimeout should have been called to cancel the timeout
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });
});
