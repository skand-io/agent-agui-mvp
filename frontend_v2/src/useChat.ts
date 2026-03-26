/**
 * AG-UI Chat Hook with Two-Tier State Synchronization
 * Tier 1: Message-based tracking (tool calls in messages array)
 * Tier 2: State-based tracking (UI-friendly tool_logs array)
 *
 * AG-UI protocol compliant:
 * - Sends RunAgentInput format requests
 * - Executes frontend tools on RUN_FINISHED (pending tool detection)
 * - Resumes with ToolMessage in messages array
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

// Pending tool call info for frontend execution
interface PendingToolCall {
  toolCallId: string;
  toolName: string;
  args: string; // JSON string of arguments
}

export function useChat() {
  // Message-based tracking (Tier 1) - standard AG-UI messages array
  const [messages, setMessages] = useState<Message[]>([]);

  // State-based tracking (Tier 2) - custom tool_logs for UI
  const [agentState, setAgentState] = useState<AgentState>({ tool_logs: [] });

  // Activity tracking
  const [activity, setActivity] = useState<Record<string, any> | null>(null);

  const [isLoading, setIsLoading] = useState(false);

  // Current event being processed (for live UI indicator)
  const [currentEvent, setCurrentEvent] = useState<string | null>(null);

  // Thinking content from reasoning model
  const [thinkingContent, setThinkingContent] = useState<string | null>(null);

  // Refs for building messages during streaming
  const currentMessage = useRef<AssistantMessage | null>(null);
  const currentToolCall = useRef<Partial<ToolCall> | null>(null);

  // Track thread_id and run_id for resume functionality
  const currentThreadId = useRef<string | null>(null);

  // Track pending tool calls: added on TOOL_CALL_END, removed on TOOL_CALL_RESULT
  const pendingToolCalls = useRef<Map<string, PendingToolCall>>(new Map());

  // Ref to hold the processStream function for use in handleEvent
  const processStreamRef = useRef<((response: Response) => Promise<void>) | null>(null);

  /**
   * Build RunAgentInput request body
   */
  function buildRunAgentInput(
    threadId: string,
    runId: string,
    msgs: Array<{ id: string; role: string; content: string; tool_call_id?: string }>
  ) {
    return {
      thread_id: threadId,
      run_id: runId,
      messages: msgs,
      tools: [],
      context: [],
    };
  }

  /**
   * Handle a single AG-UI event
   */
  const handleEvent = useCallback(async (event: any) => {
    console.log('🔍 handleEvent:', event);

    // Update current event for live UI indicator
    setCurrentEvent(event.type);

    switch (event.type) {
      // === LIFECYCLE ===
      case EventType.RUN_STARTED:
        console.log('🚀 RUN_STARTED:', event.runId);
        if (event.threadId) {
          currentThreadId.current = event.threadId;
        }
        setIsLoading(true);
        break;

      case EventType.RUN_FINISHED: {
        console.log('🏁 RUN_FINISHED');

        // Finalize any pending message
        if (currentMessage.current) {
          const message = currentMessage.current;
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== message.id);
            return [...filtered, message];
          });
          currentMessage.current = null;
        }

        // Check for pending frontend tool calls
        const pending = Array.from(pendingToolCalls.current.values()).filter(
          (tc) => tc.toolName in FRONTEND_TOOLS
        );

        if (pending.length > 0) {
          // Execute the first pending frontend tool
          const toolCall = pending[0];
          console.log('🔧 Executing pending frontend tool:', toolCall.toolName);

          const handler = FRONTEND_TOOLS[toolCall.toolName];
          if (handler) {
            try {
              const args = JSON.parse(toolCall.args);
              const result = handler(args);
              console.log('✅ Frontend tool executed:', { tool: toolCall.toolName, result });

              // Remove from pending
              pendingToolCalls.current.delete(toolCall.toolCallId);

              // Resume with ToolMessage in RunAgentInput format
              const threadId = currentThreadId.current;
              if (threadId && processStreamRef.current) {
                const resumeRunId = crypto.randomUUID();
                const response = await fetch('http://localhost:8000/chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(
                    buildRunAgentInput(threadId, resumeRunId, [
                      {
                        id: crypto.randomUUID(),
                        role: 'tool',
                        tool_call_id: toolCall.toolCallId,
                        content: result,
                      },
                    ])
                  ),
                });

                await processStreamRef.current(response);
              }
            } catch (error) {
              console.error('Failed to execute frontend tool:', error);
              // Resume with error
              const threadId = currentThreadId.current;
              if (threadId && processStreamRef.current) {
                const resumeRunId = crypto.randomUUID();
                const response = await fetch('http://localhost:8000/chat', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(
                    buildRunAgentInput(threadId, resumeRunId, [
                      {
                        id: crypto.randomUUID(),
                        role: 'tool',
                        tool_call_id: toolCall.toolCallId,
                        content: `Error: ${error}`,
                      },
                    ])
                  ),
                });
                await processStreamRef.current(response);
              }
            }
          }
        } else {
          // No pending frontend tools — run is truly finished
          setIsLoading(false);
          setCurrentEvent(null);
          setThinkingContent(null);
        }
        break;
      }

      case EventType.RUN_ERROR:
        console.log('❌ RUN_ERROR:', event.message);
        setIsLoading(false);
        setCurrentEvent(null);
        setThinkingContent(null);
        break;

      case EventType.STEP_STARTED:
        console.log('▶️ STEP_STARTED:', event.stepName);
        break;

      case EventType.STEP_FINISHED:
        console.log('⏸️ STEP_FINISHED:', event.stepName);
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
        console.log('💬 TEXT_MESSAGE_START:', event.messageId);
        currentMessage.current = {
          id: event.messageId,
          role: 'assistant',
          content: '',
          toolCalls: [],
        };
        break;

      case EventType.TEXT_MESSAGE_CONTENT:
        console.log('💬 TEXT_MESSAGE_CONTENT:', event.delta);
        if (currentMessage.current) {
          currentMessage.current.content = (currentMessage.current.content || '') + event.delta;
          const message = currentMessage.current;
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== message.id);
            return [...filtered, message];
          });
        }
        break;

      case EventType.TEXT_MESSAGE_END:
        console.log('💬 TEXT_MESSAGE_END');
        if (currentMessage.current) {
          const message = currentMessage.current;
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== message.id);
            return [...filtered, message];
          });
        }
        break;

      // === TOOL CALL TRACKING (Tier 1 - tool calls in messages) ===
      case EventType.TOOL_CALL_START:
        console.log('🔧 TOOL_CALL_START:', event.toolCallName);
        // Create an assistant message if one doesn't exist yet
        // (happens when LLM returns tool calls without text content)
        if (!currentMessage.current) {
          currentMessage.current = {
            id: event.parentMessageId || crypto.randomUUID(),
            role: 'assistant',
            content: '',
            toolCalls: [],
          };
        }
        currentToolCall.current = {
          id: event.toolCallId,
          type: 'function',
          function: {
            name: event.toolCallName,
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
        if (currentToolCall.current && currentMessage.current) {
          currentMessage.current.toolCalls = currentMessage.current.toolCalls || [];
          currentMessage.current.toolCalls.push(currentToolCall.current as ToolCall);

          const message = currentMessage.current;
          setMessages((prev) => {
            const filtered = prev.filter((m) => m.id !== message.id);
            return [...filtered, message];
          });

          // Track as pending (will be removed on TOOL_CALL_RESULT)
          pendingToolCalls.current.set(currentToolCall.current.id!, {
            toolCallId: currentToolCall.current.id!,
            toolName: currentToolCall.current.function!.name,
            args: currentToolCall.current.function!.arguments,
          });

          currentToolCall.current = null;
        }
        break;

      case EventType.TOOL_CALL_RESULT:
        console.log('🔧 TOOL_CALL_RESULT:', event.content);
        // Remove from pending (backend handled this tool)
        pendingToolCalls.current.delete(event.toolCallId);

        setMessages((prev) => {
          const toolCallId = event.toolCallId;
          const existingResult = prev.find(
            (m) => m.role === 'tool' && (m as any).toolCallId === toolCallId
          );
          if (existingResult) {
            return prev;
          }
          return [
            ...prev,
            {
              id: event.messageId,
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
        setThinkingContent('');
        break;

      case EventType.THINKING_END:
        console.log('🧠 THINKING_END');
        break;

      case EventType.THINKING_TEXT_MESSAGE_START:
        console.log('🧠 THINKING_TEXT_MESSAGE_START');
        break;

      case EventType.THINKING_TEXT_MESSAGE_CONTENT:
        console.log('🧠 THINKING_TEXT_MESSAGE_CONTENT:', event.delta);
        setThinkingContent((prev) => (prev || '') + event.delta);
        break;

      case EventType.THINKING_TEXT_MESSAGE_END:
        console.log('🧠 THINKING_TEXT_MESSAGE_END');
        break;

      // === SPECIAL ===
      case EventType.CUSTOM:
        console.log('🎯 CUSTOM:', event.name, event.value);
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
      pendingToolCalls.current.clear();

      // Generate IDs for this request
      const threadId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      currentThreadId.current = threadId;

      try {
        const response = await fetch('http://localhost:8000/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildRunAgentInput(threadId, runId, [
              { id: userMessage.id, role: 'user', content },
            ])
          ),
        });

        await processStream(response);
      } catch (error) {
        console.error('Chat error:', error);
        setIsLoading(false);
      }
    },
    [processStream]
  );

  return { messages, isLoading, sendMessage, agentState, activity, currentEvent, thinkingContent };
}
