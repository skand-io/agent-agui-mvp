import { useState, useCallback, useRef } from 'react';
import { Message, EventType, AGUIEvent, ToolCall, CopilotAction } from '../types';
import { FRONTEND_TOOLS, getToolsForBackend } from '../tools';
import { useCopilotContext } from '../context/CopilotContext';

const API_URL = 'http://localhost:8000';
const MAX_FOLLOW_UP_DEPTH = 5;

// Original useChat for backward compatibility
export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMessage: Message = { role: 'user', content };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.filter(
            (m) => m.role === 'user' || m.role === 'assistant'
          ),
          frontendTools: getToolsForBackend(),
          threadId: crypto.randomUUID(),
          runId: crypto.randomUUID(),
        }),
      });

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentText = '';
      let currentMessageId: string | null = null;
      const toolCalls: Record<string, ToolCall> = {};

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
              handleEvent(
                event,
                currentText,
                currentMessageId,
                toolCalls,
                (text) => { currentText = text; },
                (id) => { currentMessageId = id; },
                setMessages
              );
            } catch {
              // Ignore JSON parse errors for incomplete chunks
            }
          }
        }
      }
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
  }, [messages, isLoading]);

  return { messages, isLoading, sendMessage };
}

// New context-aware useChat with auto follow-up
export function useChatWithContext() {
  const { actions, getContextString } = useCopilotContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
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

    const response = await fetch(`${API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: currentMessages.filter(
          (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool'
        ),
        frontendTools: getToolsForBackendFromActions(actionsRef.current),
        threadId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        // Include app context for LLM decision making
        context: contextString || undefined,
      }),
    });

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let currentText = '';
    let currentMessageId: string | null = null;
    const toolCalls: Record<string, ToolCall> = {};
    let updatedMessages = [...currentMessages];
    let frontendToolExecuted = false;
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
              toolCalls,
              actionsRef.current,
              (text) => { currentText = text; },
              (id) => { currentMessageId = id; },
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
          } catch {
            // Ignore JSON parse errors for incomplete chunks
          }
        }
      }
    }

    // Auto follow-up after frontend tool execution
    if (frontendToolExecuted && toolAction && !toolAction.disableFollowUp) {
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

  return { messages, isLoading, sendMessage };
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
  toolCalls: Record<string, ToolCall>,
  actions: Map<string, CopilotAction>,
  setCurrentText: (text: string) => void,
  setCurrentMessageId: (id: string | null) => void,
  setMessages: (messages: Message[]) => void,
  currentMessages: Message[]
): Promise<{ frontendToolExecuted: boolean; action?: CopilotAction; result?: string }> {
  switch (event.type) {
    case EventType.RUN_STARTED:
      console.log('[AG-UI] Run started:', event.runId);
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

      // For todo_write, attach to the last assistant message for UI rendering
      if (toolCall.name === 'todo_write') {
        const updated = [...currentMessages];
        // Find last assistant message index
        let lastAssistantIdx = -1;
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === 'assistant') {
            lastAssistantIdx = i;
            break;
          }
        }
        if (lastAssistantIdx >= 0) {
          const msg = updated[lastAssistantIdx];
          msg.toolCalls = msg.toolCalls || [];
          msg.toolCalls.push({
            id: event.toolCallId,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });
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
          return { frontendToolExecuted: true, action: contextAction, result };
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

    case EventType.TOOL_CALL_RESULT:
      console.log('[AG-UI] Backend tool result:', event.content);
      setMessages([
        ...currentMessages,
        {
          role: 'tool',
          content: `Backend tool result: ${event.content}`,
          isFrontend: false,
          isBackend: true,
          toolCallId: event.toolCallId,
        },
      ]);
      break;

    case EventType.RUN_FINISHED:
      console.log('[AG-UI] Run finished:', event.runId);
      break;

    case EventType.RUN_ERROR:
      console.error('[AG-UI] Run error:', event.message);
      setMessages([
        ...currentMessages,
        {
          role: 'assistant',
          content: `Error: ${event.message}`,
        },
      ]);
      break;
  }

  return { frontendToolExecuted: false };
}

function handleEvent(
  event: AGUIEvent,
  currentText: string,
  currentMessageId: string | null,
  toolCalls: Record<string, ToolCall>,
  setCurrentText: (text: string) => void,
  setCurrentMessageId: (id: string | null) => void,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
) {
  switch (event.type) {
    case EventType.RUN_STARTED:
      console.log('[AG-UI] Run started:', event.runId);
      break;

    case EventType.TEXT_MESSAGE_START:
      setCurrentMessageId(event.messageId || null);
      setCurrentText('');
      break;

    case EventType.TEXT_MESSAGE_CONTENT: {
      const newText = currentText + (event.delta || '');
      setCurrentText(newText);
      setMessages((prev) => {
        const updated = [...prev];
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
        return updated;
      });
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

      // For todo_write, attach to the last assistant message for UI rendering
      if (toolCall && toolCall.name === 'todo_write') {
        setMessages((prev) => {
          const updated = [...prev];
          // Find last assistant message index
          let lastAssistantIdx = -1;
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'assistant') {
              lastAssistantIdx = i;
              break;
            }
          }
          if (lastAssistantIdx >= 0) {
            const msg = updated[lastAssistantIdx];
            msg.toolCalls = msg.toolCalls || [];
            msg.toolCalls.push({
              id: event.toolCallId!,
              name: toolCall.name,
              arguments: toolCall.arguments,
            });
          }
          return updated;
        });
        break;
      }

      if (toolCall && FRONTEND_TOOLS[toolCall.name]) {
        try {
          const args = JSON.parse(toolCall.arguments || '{}');
          const result = FRONTEND_TOOLS[toolCall.name].handler(args);
          setMessages((prev) => [
            ...prev,
            {
              role: 'tool',
              content: `Frontend tool "${toolCall.name}" executed: ${result}`,
              isFrontend: true,
              toolCallId: event.toolCallId,
            },
          ]);
        } catch (e) {
          const errorMsg = e instanceof Error ? e.message : 'Unknown error';
          console.error('Frontend tool error:', e);
          setMessages((prev) => [
            ...prev,
            {
              role: 'tool',
              content: `Frontend tool "${toolCall.name}" error: ${errorMsg}`,
              isFrontend: true,
              toolCallId: event.toolCallId,
            },
          ]);
        }
      }
      break;
    }

    case EventType.TOOL_CALL_RESULT:
      console.log('[AG-UI] Backend tool result:', event.content);
      setMessages((prev) => [
        ...prev,
        {
          role: 'tool',
          content: `Backend tool result: ${event.content}`,
          isFrontend: false,
          isBackend: true,
          toolCallId: event.toolCallId,
        },
      ]);
      break;

    case EventType.RUN_FINISHED:
      console.log('[AG-UI] Run finished:', event.runId);
      break;

    case EventType.RUN_ERROR:
      console.error('[AG-UI] Run error:', event.message);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Error: ${event.message}`,
        },
      ]);
      break;
  }
}
