import { useState, useCallback } from 'react';
import { Message, EventType, AGUIEvent, ToolCall } from '../types';
import { FRONTEND_TOOLS, getToolsForBackend } from '../tools';

const API_URL = 'http://localhost:8000';

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
