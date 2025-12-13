// AG-UI Event Types
export const EventType = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
} as const;

export type EventTypeValue = typeof EventType[keyof typeof EventType];

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  isFrontend?: boolean;
  isBackend?: boolean;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  handler: (args: Record<string, string>) => string;
}

export interface ToolCall {
  name: string;
  arguments: string;
}

export interface AGUIEvent {
  type: EventTypeValue;
  messageId?: string;
  runId?: string;
  threadId?: string;
  delta?: string;
  toolCallId?: string;
  toolCallName?: string;
  content?: string;
  message?: string;
  role?: string;
}
