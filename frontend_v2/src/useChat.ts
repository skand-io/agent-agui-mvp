/**
 * AG-UI Chat Hook with Two-Tier State Synchronization
 * Tier 1: Message-based tracking (tool calls in messages array)
 * Tier 2: State-based tracking (UI-friendly tool_logs array)
 *
 * Supports LangGraph interrupt/resume for sequential tool calling:
 * - Frontend tools pause execution via interrupt()
 * - Client executes tool and sends resume request
 * - Graph continues from where it left off
 */

import { applyPatch } from 'fast-json-patch';
import { useCallback, useRef, useState } from 'react';
import type { AgentState } from './types';
import {
  EventType,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from './types';

// Frontend tool implementations
const FRONTEND_TOOLS: Record<string, (args: any) => string> = {
  greet: ({ name }: { name: string }) => {
    alert(`Hello, ${name}!`);
    return `Greeted ${name}`;
  },
};

export function useChat() {
  // Message-based tracking (Tier 1) - standard AG-UI messages array
  const [messages, setMessages] = useState<Message[]>([]);

  // State-based tracking (Tier 2) - custom tool_logs for UI
  const [agentState, setAgentState] = useState<AgentState>({ tool_logs: [] });

  // Activity tracking
  const [activity, setActivity] = useState<Record<string, any> | null>(null);

  const [isLoading, setIsLoading] = useState(false);

  // Refs for building messages during streaming
  const currentMessage = useRef<AssistantMessage | null>(null);
  const currentToolCall = useRef<Partial<ToolCall> | null>(null);

  // Track thread_id for resume functionality
  const currentThreadId = useRef<string | null>(null);

  // Ref to hold the processStream function for use in handleEvent
  const processStreamRef = useRef<((response: Response) => Promise<void>) | null>(null);

  /**
   * Handle a single AG-UI event
   */
  const handleEvent = useCallback(async (event: any) => {
    console.log('🔍 handleEvent:', event);
    switch (event.type) {
      // === LIFECYCLE ===
      case EventType.RUN_STARTED:
        console.log('🚀 RUN_STARTED:', event.runId || event.run_id);
        // Update thread_id if provided (for resume support)
        if (event.threadId || event.thread_id) {
          currentThreadId.current = event.threadId || event.thread_id;
        }
        setIsLoading(true);
        break;

      case EventType.RUN_FINISHED:
        console.log('🏁 RUN_FINISHED');
        console.log('🏁 currentMessage.current:', currentMessage.current);
        setIsLoading(false);
        // Finalize any pending message
        if (currentMessage.current) {
          setMessages((prev) => [...prev, currentMessage.current!]);
          currentMessage.current = null;
        }
        break;

      case EventType.RUN_ERROR:
        console.log('❌ RUN_ERROR:', event.message);
        setIsLoading(false);
        break;

      case EventType.STEP_STARTED:
        console.log('▶️ STEP_STARTED:', event.stepName || event.step_name);
        break;

      case EventType.STEP_FINISHED:
        console.log('⏸️ STEP_FINISHED:', event.stepName || event.step_name);
        break;

      // === STATE TRACKING (Tier 2 - UI progress) ===
      case EventType.STATE_SNAPSHOT:
        console.log('📊 STATE_SNAPSHOT:', event.snapshot);
        setAgentState(event.snapshot);
        break;

      case EventType.STATE_DELTA:
        console.log('📊 STATE_DELTA:', event.delta);
        setAgentState((prevState) => {
          const result = applyPatch(prevState, event.delta, true, false);
          return result.newDocument;
        });
        break;

      // === MESSAGE TRACKING (Tier 1 - messages array) ===
      case EventType.MESSAGES_SNAPSHOT:
        console.log('💬 MESSAGES_SNAPSHOT');
        setMessages(event.messages);
        break;

      case EventType.TEXT_MESSAGE_START:
        console.log('💬 TEXT_MESSAGE_START:', event.messageId || event.message_id);
        currentMessage.current = {
          id: event.messageId || event.message_id,
          role: 'assistant',
          content: '',
          toolCalls: [],
        };
        break;

      case EventType.TEXT_MESSAGE_CONTENT:
        console.log('💬 TEXT_MESSAGE_CONTENT:', event.delta);
        if (currentMessage.current) {
          // update the current message content
          currentMessage.current.content = (currentMessage.current.content || '') + event.delta;

          // Capture ref value to avoid null access in async callback
          const message = currentMessage.current;
          // Update message in real-time
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== message.id);
            return [...filtered, message];
          });
        }
        break;

      case EventType.TEXT_MESSAGE_END:
        console.log('💬 TEXT_MESSAGE_END');
        if (currentMessage.current) {
          // Capture ref value to avoid null access in async callback
          const message = currentMessage.current;
          console.log('💬 TEXT_MESSAGE_END currentMessage.current:', message);
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== message.id);
            return [...filtered, message];
          });
        }
        break;

      // === TOOL CALL TRACKING (Tier 1 - tool calls in messages) ===
      case EventType.TOOL_CALL_START:
        console.log('🔧 TOOL_CALL_START:', event.toolCallName || event.tool_call_name);
        currentToolCall.current = {
          id: event.toolCallId || event.tool_call_id,
          type: 'function',
          function: {
            name: event.toolCallName || event.tool_call_name,
            arguments: '',
          },
        };
        break;

      case EventType.TOOL_CALL_ARGS:
        console.log('🔧 TOOL_CALL_ARGS:', event.delta);
        if (currentToolCall.current?.function) {
          currentToolCall.current.function.arguments += event.delta;
        }
        break;

      case EventType.TOOL_CALL_END:
        console.log('🔧 TOOL_CALL_END');

        console.log('🔧 currentToolCall.current:', currentToolCall.current);
        console.log('🔧 currentMessage.current:', currentMessage.current);

        if (currentToolCall.current && currentMessage.current) {
          currentMessage.current.toolCalls = currentMessage.current.toolCalls || [];
          currentMessage.current.toolCalls.push(currentToolCall.current as ToolCall);

          // Capture ref value to avoid null access in async callback
          const message = currentMessage.current;

          // Update message with tool call
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== message.id);
            return [...filtered, message];
          });

          // NOTE: We no longer execute frontend tools here for the LangGraph backend.
          // Frontend tools are executed via the frontend_tool_required custom event.

          currentToolCall.current = null;
        }
        break;

      case EventType.TOOL_CALL_RESULT:
        console.log('🔧 TOOL_CALL_RESULT:', event.content);
        // Add tool result message (deduplicate by toolCallId)
        setMessages((prev) => {
          const toolCallId = event.toolCallId || event.tool_call_id;
          // Skip if we already have a result for this tool call
          const existingResult = prev.find(
            (m) => m.role === 'tool' && (m as any).toolCallId === toolCallId
          );
          if (existingResult) {
            console.log('🔧 Skipping duplicate TOOL_CALL_RESULT:', toolCallId);
            return prev;
          }
          return [
            ...prev,
            {
              id: event.messageId || event.message_id,
              role: 'tool',
              toolCallId,
              content: event.content,
            },
          ];
        });
        break;

      // === ACTIVITY TRACKING ===
      case EventType.ACTIVITY_SNAPSHOT:
        console.log('⚡ ACTIVITY_SNAPSHOT:', event.content);
        setActivity(event.content);
        break;

      case EventType.ACTIVITY_DELTA:
        console.log('⚡ ACTIVITY_DELTA:', event.patch);
        setActivity((prev) => {
          if (!prev) return event.patch;
          const result = applyPatch(prev, event.patch, true, false);
          return result.newDocument;
        });
        break;

      // === THINKING ===
      case EventType.THINKING_START:
        console.log('🧠 THINKING_START:', event.title);
        break;

      case EventType.THINKING_END:
        console.log('🧠 THINKING_END');
        break;

      case EventType.THINKING_TEXT_MESSAGE_START:
        console.log('🧠 THINKING_TEXT_MESSAGE_START');
        break;

      case EventType.THINKING_TEXT_MESSAGE_CONTENT:
        console.log('🧠 THINKING_TEXT_MESSAGE_CONTENT:', event.delta);
        break;

      case EventType.THINKING_TEXT_MESSAGE_END:
        console.log('🧠 THINKING_TEXT_MESSAGE_END');
        break;

      // === SPECIAL ===
      case EventType.CUSTOM:
        console.log('🎯 CUSTOM:', event.name, event.value);

        // Handle frontend tool required (LangGraph interrupt)
        if (event.name === 'frontend_tool_required') {
          const { tool_call_id, tool_name, args } = event.value;
          console.log('🔄 Frontend tool required:', { tool_call_id, tool_name, args });

          // Execute the frontend tool
          const handler = FRONTEND_TOOLS[tool_name];
          if (handler) {
            try {
              const result = handler(args);
              console.log('✅ Frontend tool executed:', { tool_name, result });

              // Resume the graph with the result
              const threadId = currentThreadId.current;
              if (threadId && processStreamRef.current) {
                console.log('🔄 Resuming graph with result:', { threadId, result });

                const response = await fetch('http://localhost:8000/chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    thread_id: threadId,
                    resume_value: result,
                    message: '', // Empty message for resume
                  }),
                });

                // Process the resumed stream
                await processStreamRef.current(response);
              } else {
                console.error('No thread_id or processStream available for resume');
              }
            } catch (error) {
              console.error('Failed to execute frontend tool:', error);
              // Resume with error message
              const threadId = currentThreadId.current;
              if (threadId && processStreamRef.current) {
                const response = await fetch('http://localhost:8000/chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    thread_id: threadId,
                    resume_value: `Error: ${error}`,
                    message: '',
                  }),
                });
                await processStreamRef.current(response);
              }
            }
          } else {
            console.error('Unknown frontend tool:', tool_name);
          }
        } else if (event.name === 'run_interrupted') {
          // Run was interrupted for frontend tool - keep loading state
          console.log('⏸️ Run interrupted, awaiting frontend tool execution');
          // Don't set isLoading to false here - the resume will complete
        } else if (event.name === 'run_paused') {
          console.log('⏸️ Run paused:', event.value);
        }
        break;

      default:
        console.log('❓ Unknown event type:', event.type);
    }
  }, []);

  /**
   * Process SSE stream from backend
   */
  const processStream = useCallback(
    async (response: Response) => {
      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;

          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);
              await handleEvent(event);
            } catch (e) {
              console.error('Failed to parse event:', e, data);
            }
          }
        }
      }
    },
    [handleEvent]
  );

  // Store processStream in ref so handleEvent can access it
  processStreamRef.current = processStream;

  const sendMessage = useCallback(
    async (content: string) => {
      setIsLoading(true);

      // Add user message
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
      };
      setMessages((prev) => [...prev, userMessage]);

      // Reset state
      currentMessage.current = null;
      currentToolCall.current = null;

      // Generate a thread_id for this conversation
      const threadId = crypto.randomUUID();
      currentThreadId.current = threadId;

      try {
        const response = await fetch('http://localhost:8000/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: content,
            thread_id: threadId,
          }),
        });

        await processStream(response);
      } catch (error) {
        console.error('Chat error:', error);
        setIsLoading(false);
      }
    },
    [processStream]
  );

  return { messages, isLoading, sendMessage, agentState, activity };
}
