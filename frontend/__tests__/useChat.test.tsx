import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';

import { CopilotProvider, useCopilotContext } from '../src/context/CopilotContext';
import { useCopilotAction } from '../src/hooks/useCopilotAction';
import { useChatWithContext } from '../src/hooks/useChat';
import { EventType } from '../src/types';

// Helper to wrap hooks with provider
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CopilotProvider>{children}</CopilotProvider>
);

// Helper to create SSE stream data
function createSSEStream(events: Array<{ type: string; [key: string]: unknown }>) {
  const lines = events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n');
  return new TextEncoder().encode(lines + '\n\n');
}

describe('useChat with auto follow-up', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('sends follow-up request after frontend tool execution', async () => {
    const fetchCalls: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    // First call: LLM makes a tool call
    // Second call: Follow-up after tool result
    const responses = [
      // First response: tool call
      createSSEStream([
        { type: EventType.RUN_STARTED, runId: 'run1' },
        { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'greet' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"name":"Alice"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
        { type: EventType.RUN_FINISHED, runId: 'run1' },
      ]),
      // Second response: follow-up text
      createSSEStream([
        { type: EventType.RUN_STARTED, runId: 'run2' },
        { type: EventType.TEXT_MESSAGE_START, messageId: 'msg1' },
        { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'Great, I greeted Alice!' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'msg1' },
        { type: EventType.RUN_FINISHED, runId: 'run2' },
      ]),
    ];

    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options?.body as string);
      fetchCalls.push(body);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(responses[callIndex++]);
          controller.close();
        },
      });

      return { body: stream };
    });

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'greet',
          description: 'Greet a person',
          parameters: [{ name: 'name', type: 'string', description: 'Name', required: true }],
          handler: ({ name }) => `Greeted ${name}`,
        });
        return useChatWithContext();
      },
      { wrapper }
    );

    await act(async () => {
      await result.current.sendMessage('Say hello to Alice');
    });

    // Wait for follow-up to complete
    await waitFor(() => {
      expect(fetchCalls.length).toBe(2);
    }, { timeout: 3000 });

    // First call should have user message
    expect(fetchCalls[0].messages).toContainEqual(
      expect.objectContaining({ role: 'user', content: 'Say hello to Alice' })
    );

    // Second call (follow-up) should include tool result
    expect(fetchCalls[1].messages).toContainEqual(
      expect.objectContaining({ role: 'tool' })
    );
  });

  it('respects disableFollowUp option', async () => {
    const fetchCalls: unknown[] = [];

    const responses = [
      createSSEStream([
        { type: EventType.RUN_STARTED, runId: 'run1' },
        { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'noFollowUp' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
        { type: EventType.RUN_FINISHED, runId: 'run1' },
      ]),
    ];

    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      fetchCalls.push(JSON.parse(options?.body as string));

      const stream = new ReadableStream({
        start(controller) {
          if (callIndex < responses.length) {
            controller.enqueue(responses[callIndex++]);
          }
          controller.close();
        },
      });

      return { body: stream };
    });

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'noFollowUp',
          description: 'Action without follow-up',
          parameters: [],
          handler: () => 'Done',
          disableFollowUp: true,
        });
        return useChatWithContext();
      },
      { wrapper }
    );

    await act(async () => {
      await result.current.sendMessage('Test');
    });

    // Wait a bit to make sure no follow-up happens
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Should only have one fetch call, no follow-up
    expect(fetchCalls.length).toBe(1);
  });

  it('respects MAX_FOLLOW_UP_DEPTH limit', async () => {
    const fetchCalls: unknown[] = [];

    // Create responses that always trigger tool calls (would cause infinite loop without limit)
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      fetchCalls.push(JSON.parse(options?.body as string));

      const response = createSSEStream([
        { type: EventType.RUN_STARTED, runId: `run${fetchCalls.length}` },
        { type: EventType.TOOL_CALL_START, toolCallId: `tc${fetchCalls.length}`, toolCallName: 'recursiveAction' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: `tc${fetchCalls.length}`, delta: '{}' },
        { type: EventType.TOOL_CALL_END, toolCallId: `tc${fetchCalls.length}` },
        { type: EventType.RUN_FINISHED, runId: `run${fetchCalls.length}` },
      ]);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(response);
          controller.close();
        },
      });

      return { body: stream };
    });

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'recursiveAction',
          description: 'Action that always triggers',
          parameters: [],
          handler: () => 'Result',
        });
        return useChatWithContext();
      },
      { wrapper }
    );

    await act(async () => {
      await result.current.sendMessage('Start');
    });

    // Wait for all follow-ups to complete
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    }, { timeout: 5000 });

    // Should stop at MAX_FOLLOW_UP_DEPTH (5) + 1 initial = 6 calls max
    expect(fetchCalls.length).toBeLessThanOrEqual(6);
  });

  it('handles async tool handlers', async () => {
    const fetchCalls: unknown[] = [];
    let handlerResolved = false;

    const responses = [
      createSSEStream([
        { type: EventType.RUN_STARTED, runId: 'run1' },
        { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'asyncAction' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"value":"test"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
        { type: EventType.RUN_FINISHED, runId: 'run1' },
      ]),
      createSSEStream([
        { type: EventType.RUN_STARTED, runId: 'run2' },
        { type: EventType.TEXT_MESSAGE_START, messageId: 'msg1' },
        { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'Async completed!' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'msg1' },
        { type: EventType.RUN_FINISHED, runId: 'run2' },
      ]),
    ];

    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      fetchCalls.push({});

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(responses[callIndex++]);
          controller.close();
        },
      });

      return { body: stream };
    });

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'asyncAction',
          description: 'Async action',
          parameters: [{ name: 'value', type: 'string', description: 'Value', required: true }],
          handler: async ({ value }) => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            handlerResolved = true;
            return `Async result: ${value}`;
          },
        });
        return useChatWithContext();
      },
      { wrapper }
    );

    await act(async () => {
      await result.current.sendMessage('Test async');
    });

    await waitFor(() => {
      expect(handlerResolved).toBe(true);
    }, { timeout: 3000 });

    // Follow-up should have been called after async handler resolved
    await waitFor(() => {
      expect(fetchCalls.length).toBe(2);
    }, { timeout: 3000 });
  });

  it('includes tool result in follow-up message', async () => {
    const fetchCalls: Array<{ messages: Array<{ role: string; content: string }> }> = [];

    const responses = [
      createSSEStream([
        { type: EventType.RUN_STARTED, runId: 'run1' },
        { type: EventType.TOOL_CALL_START, toolCallId: 'tc1', toolCallName: 'calculateAction' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"a":5,"b":3}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'tc1' },
        { type: EventType.RUN_FINISHED, runId: 'run1' },
      ]),
      createSSEStream([
        { type: EventType.RUN_STARTED, runId: 'run2' },
        { type: EventType.TEXT_MESSAGE_START, messageId: 'msg1' },
        { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'The result is 8' },
        { type: EventType.TEXT_MESSAGE_END, messageId: 'msg1' },
        { type: EventType.RUN_FINISHED, runId: 'run2' },
      ]),
    ];

    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, options) => {
      fetchCalls.push(JSON.parse(options?.body as string));

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(responses[callIndex++]);
          controller.close();
        },
      });

      return { body: stream };
    });

    const { result } = renderHook(
      () => {
        useCopilotAction({
          name: 'calculateAction',
          description: 'Add two numbers',
          parameters: [
            { name: 'a', type: 'number', description: 'First number', required: true },
            { name: 'b', type: 'number', description: 'Second number', required: true },
          ],
          handler: ({ a, b }) => `Result: ${Number(a) + Number(b)}`,
        });
        return useChatWithContext();
      },
      { wrapper }
    );

    await act(async () => {
      await result.current.sendMessage('Add 5 and 3');
    });

    await waitFor(() => {
      expect(fetchCalls.length).toBe(2);
    }, { timeout: 3000 });

    // Second call should include the tool result
    const followUpMessages = fetchCalls[1].messages;
    const toolResultMessage = followUpMessages.find((m) => m.role === 'tool');
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage?.content).toContain('Result: 8');
  });
});
