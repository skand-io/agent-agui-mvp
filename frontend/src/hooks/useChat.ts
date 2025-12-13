import { useCallback, useRef, useState } from 'react';
import { useCopilotContext } from '../context/CopilotContext';
import { usePayloadContext } from '../context/PayloadContext';
import { FRONTEND_TOOLS, getToolsForBackend } from '../tools';
import { AGUIEvent, CopilotAction, EventType, Message, ToolCall } from '../types';

const API_URL = 'http://localhost:8000';
const MAX_FOLLOW_UP_DEPTH = 5;

// Type for the LLM request payload
export interface LLMPayload {
  messages: Array<{ role: string; content: string }>;
  frontendTools: Array<{ name: string; description: string; parameters: unknown }>;
  threadId: string;
  runId: string;
  context?: string;
}

// New context-aware useChat with auto follow-up
export function useChatWithContext() {
  const { actions, getContextString } = useCopilotContext();
  const { lastPayload, setLastPayload } = usePayloadContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Persistent thread ID for the conversation - enables context change detection on backend
  const threadIdRef = useRef<string>(crypto.randomUUID());

  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const getContextStringRef = useRef(getContextString);
  getContextStringRef.current = getContextString;

  const sendMessageInternal = useCallback(async (
    currentMessages: Message[],
    depth: number = 0
  ): Promise<Message[]> => {
    if (depth > MAX_FOLLOW_UP_DEPTH) {
      return currentMessages;
    }

    // Get readable context to send to LLM
    const contextString = getContextStringRef.current();

    // Build the payload
    const payload: LLMPayload = {
      messages: currentMessages.filter(
        (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool'
      ).map((m) => ({ role: m.role, content: m.content })),
      frontendTools: getToolsForBackendFromActions(actionsRef.current),
      threadId: threadIdRef.current,
      runId: crypto.randomUUID(),
      context: contextString || undefined,
    };

    // Save the payload for debugging
    setLastPayload(payload);

    const response = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentText = '';
    let currentMessageId: string | null = null;
    let lastAssistantMessageId: string | null = null; // Persists after TEXT_MESSAGE_END
    const toolCalls: Record<string, ToolCall> = {};
    let updatedMessages = [...currentMessages];
    let frontendToolExecuted = false;
    let backendToolExecuted = false;
    let toolAction: CopilotAction | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      while (buffer.includes('\n\n')) {
        const eventEnd = buffer.indexOf('\n\n');
        const eventStr = buffer.slice(0, eventEnd);
        buffer = buffer.slice(eventEnd + 2);

        for (const line of eventStr.split('\n')) {
          if (!line.startsWith('data: ')) continue;

          try {
            const event: AGUIEvent = JSON.parse(line.slice(6));

            const result = await handleEventWithContext(
              event,
              currentText,
              currentMessageId,
              lastAssistantMessageId,
              toolCalls,
              actionsRef.current,
              (text) => { currentText = text; },
              (id) => {
                currentMessageId = id;
                if (id) lastAssistantMessageId = id; // Track last assistant message
              },
              (newMsgs) => {
                updatedMessages = newMsgs;
                setMessages(newMsgs);
              },
              updatedMessages
            );

            if (result.frontendToolExecuted) {
              frontendToolExecuted = true;
              toolAction = result.action;
            }
            if (result.backendToolExecuted) {
              backendToolExecuted = true;
            }
          } catch {
            // Ignore JSON parse errors for incomplete chunks
          }
        }
      }
    }

    // Auto follow-up after ANY tool execution (backend or frontend)
    const shouldFollowUp =
      (frontendToolExecuted && toolAction && !toolAction.disableFollowUp) ||
      backendToolExecuted;

    if (shouldFollowUp) {
      return sendMessageInternal(updatedMessages, depth + 1);
    }

    return updatedMessages;
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const finalMessages = await sendMessageInternal(newMessages, 0);
      setMessages(finalMessages);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${errorMessage}. Make sure the server is running on localhost:8000`,
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, isLoading, sendMessageInternal]);

  // Clear messages and reset thread (starts fresh context tracking)
  const clearMessages = useCallback(() => {
    setMessages([]);
    threadIdRef.current = crypto.randomUUID();
  }, []);

  return { messages, isLoading, sendMessage, clearMessages, lastPayload };
}

// Convert context actions to backend format
function getToolsForBackendFromActions(actions: Map<string, CopilotAction>) {
  const tools = [];
  for (const [name, action] of actions) {
    const properties: Record<string, { type: string; description: string }> = {};
    const required: string[] = [];

    for (const param of action.parameters) {
      properties[param.name] = {
        type: param.type,
        description: param.description,
      };
      if (param.required) {
        required.push(param.name);
      }
    }

    tools.push({
      name,
      description: action.description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    });
  }

  // Also include static frontend tools for backward compatibility
  const staticTools = getToolsForBackend();
  return [...tools, ...staticTools];
}

// Handle event with context actions and return tool execution info
async function handleEventWithContext(
  event: AGUIEvent,
  currentText: string,
  currentMessageId: string | null,
  lastAssistantMessageId: string | null,
  toolCalls: Record<string, ToolCall>,
  actions: Map<string, CopilotAction>,
  setCurrentText: (text: string) => void,
  setCurrentMessageId: (id: string | null) => void,
  setMessages: (messages: Message[]) => void,
  currentMessages: Message[]
): Promise<{ frontendToolExecuted: boolean; backendToolExecuted: boolean; action?: CopilotAction; result?: string }> {
  switch (event.type) {
    case EventType.RUN_STARTED:
      console.log('[AG-UI] Run started:', event.runId, 'input:', event.input);
      break;

    case EventType.STEP_STARTED:
      console.log('[AG-UI] Step started:', event.stepName);
      break;

    case EventType.STEP_FINISHED:
      console.log('[AG-UI] Step finished:', event.stepName);
      break;

    case EventType.TEXT_MESSAGE_START:
      setCurrentMessageId(event.messageId || null);
      setCurrentText('');
      break;

    case EventType.TEXT_MESSAGE_CONTENT: {
      const delta = event.delta || '';
      const newText = currentText + delta;
      setCurrentText(newText);

      // Debug: Log each streaming chunk
      console.log('[AG-UI] Streaming chunk:', JSON.stringify(delta), `(total: ${newText.length} chars)`);

      const updated = [...currentMessages];
      const lastMsg = updated[updated.length - 1];
      if (
        lastMsg?.role === 'assistant' &&
        lastMsg?.id === currentMessageId
      ) {
        lastMsg.content = newText;
      } else {
        updated.push({
          role: 'assistant',
          content: newText,
          id: currentMessageId || undefined,
        });
      }
      setMessages(updated);
      break;
    }

    case EventType.TEXT_MESSAGE_END:
      console.log('[AG-UI] Text message complete:', currentMessageId);
      setCurrentMessageId(null);
      break;

    case EventType.TOOL_CALL_START:
      console.log('[AG-UI] Tool call started:', event.toolCallName);
      if (event.toolCallId) {
        toolCalls[event.toolCallId] = {
          name: event.toolCallName || '',
          arguments: '',
        };
      }
      break;

    case EventType.TOOL_CALL_ARGS:
      if (event.toolCallId && toolCalls[event.toolCallId]) {
        toolCalls[event.toolCallId].arguments += event.delta || '';
      }
      break;

    case EventType.TOOL_CALL_END: {
      if (!event.toolCallId) break;
      const toolCall = toolCalls[event.toolCallId];

      // For todo_write, attach to the current assistant message for UI rendering
      if (toolCall.name === 'todo_write') {
        const updated = [...currentMessages];
        // Find the assistant message by lastAssistantMessageId (from this run)
        let targetIdx = -1;
        if (lastAssistantMessageId) {
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'assistant' && updated[i].id === lastAssistantMessageId) {
              targetIdx = i;
              break;
            }
          }
        }
        // If no matching ID, create a new assistant message for the todo
        if (targetIdx < 0) {
          const newMessage: Message = {
            role: 'assistant',
            content: '',
            id: `todo-${event.toolCallId}`,
            toolCalls: [{
              id: event.toolCallId,
              name: toolCall.name,
              arguments: toolCall.arguments,
            }],
          };
          setMessages([...updated, newMessage]);
        } else {
          // Immutably update the message with tool calls
          updated[targetIdx] = {
            ...updated[targetIdx],
            toolCalls: [
              ...(updated[targetIdx].toolCalls || []),
              {
                id: event.toolCallId,
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            ],
          };
          setMessages(updated);
        }
        // Don't return - let the backend handle the TOOL_CALL_RESULT
        break;
      }

      // First check context actions, then static tools
      const contextAction = actions.get(toolCall.name);
      const staticTool = FRONTEND_TOOLS[toolCall.name];

      if (contextAction) {
        try {
          const args = JSON.parse(toolCall.arguments || '{}');
          const result = await Promise.resolve(contextAction.handler(args));
          const toolMessage: Message = {
            role: 'tool',
            content: `Frontend tool "${toolCall.name}" executed: ${result}`,
            isFrontend: true,
            toolCallId: event.toolCallId,
          };
          setMessages([...currentMessages, toolMessage]);
          return { frontendToolExecuted: true, backendToolExecuted: false, action: contextAction, result };
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : 'Unknown error';
          console.error('Frontend tool error:', e);
          const errorMessage: Message = {
            role: 'tool',
            content: `Frontend tool "${toolCall.name}" error: ${errorMsg}`,
            isFrontend: true,
            toolCallId: event.toolCallId,
          };
          setMessages([...currentMessages, errorMessage]);
        }
      } else if (staticTool) {
        try {
          const args = JSON.parse(toolCall.arguments || '{}');
          const result = staticTool.handler(args);
          const toolMessage: Message = {
            role: 'tool',
            content: `Frontend tool "${toolCall.name}" executed: ${result}`,
            isFrontend: true,
            toolCallId: event.toolCallId,
          };
          setMessages([...currentMessages, toolMessage]);
          // Static tools don't trigger follow-up
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : 'Unknown error';
          console.error('Frontend tool error:', e);
          const errorMessage: Message = {
            role: 'tool',
            content: `Frontend tool "${toolCall.name}" error: ${errorMsg}`,
            isFrontend: true,
            toolCallId: event.toolCallId,
          };
          setMessages([...currentMessages, errorMessage]);
        }
      }
      break;
    }

    case EventType.TOOL_CALL_RESULT: {
      console.log('[AG-UI] Backend tool result:', event.content);

      // Look up the tool name from the toolCallId
      const toolName = event.toolCallId ? toolCalls[event.toolCallId]?.name : null;

      // todo_write is UI-only, don't trigger follow-up
      const isTodoWrite = toolName === 'todo_write';

      if (!isTodoWrite) {
        const toolResultMessage: Message = {
          role: 'tool',
          content: event.content || '',
          isFrontend: false,
          isBackend: true,
          toolCallId: event.toolCallId,
        };
        setMessages([...currentMessages, toolResultMessage]);
      }

      return { frontendToolExecuted: false, backendToolExecuted: !isTodoWrite };
    }

    case EventType.RUN_FINISHED:
      console.log('[AG-UI] Run finished:', event.runId, 'result:', event.result);
      break;

    case EventType.RUN_ERROR:
      console.error('[AG-UI] Run error:', event.message, 'code:', event.code);
      setMessages([
        ...currentMessages,
        {
          role: 'assistant',
          content: `Error: ${event.message}`,
        },
      ]);
      break;

    // State management events (AG-UI protocol compliance)
    case EventType.STATE_SNAPSHOT:
      console.log('[AG-UI] State snapshot received:', event.state);
      // Could emit to context or state management system
      break;

    case EventType.STATE_DELTA:
      console.log('[AG-UI] State delta received:', event.operations);
      // Apply JSON Patch operations to state
      break;

    case EventType.MESSAGES_SNAPSHOT:
      console.log('[AG-UI] Messages snapshot received:', event.messages);
      // Could sync conversation history from server
      break;

    // Activity events
    case EventType.ACTIVITY_SNAPSHOT:
      console.log('[AG-UI] Activity snapshot:', event.activityType, event.content);
      break;

    case EventType.ACTIVITY_DELTA:
      console.log('[AG-UI] Activity delta:', event.operations);
      break;

    // Special events
    case EventType.RAW:
      console.log('[AG-UI] Raw event:', event.source, event.rawEvent);
      break;

    case EventType.CUSTOM:
      console.log('[AG-UI] Custom event:', event.name, event.value);
      break;

    // Convenience chunk events (auto-expanded by some implementations)
    case EventType.TEXT_MESSAGE_CHUNK:
      console.log('[AG-UI] Text message chunk (convenience event)');
      break;

    case EventType.TOOL_CALL_CHUNK:
      console.log('[AG-UI] Tool call chunk (convenience event)');
      break;
  }

  return { frontendToolExecuted: false, backendToolExecuted: false };
}
