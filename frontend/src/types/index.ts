// AG-UI Event Types (Full Protocol Compliance)
export const EventType = {
  // Lifecycle events
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  // Step events (optional but recommended)
  STEP_STARTED: 'STEP_STARTED',
  STEP_FINISHED: 'STEP_FINISHED',
  // Text message events
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TEXT_MESSAGE_CHUNK: 'TEXT_MESSAGE_CHUNK',
  // Tool call events
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  TOOL_CALL_CHUNK: 'TOOL_CALL_CHUNK',
  // State management events
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  STATE_DELTA: 'STATE_DELTA',
  MESSAGES_SNAPSHOT: 'MESSAGES_SNAPSHOT',
  // Activity events
  ACTIVITY_SNAPSHOT: 'ACTIVITY_SNAPSHOT',
  ACTIVITY_DELTA: 'ACTIVITY_DELTA',
  // Special events
  RAW: 'RAW',
  CUSTOM: 'CUSTOM',
} as const;

export type EventTypeValue = typeof EventType[keyof typeof EventType];

export interface Message {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer' | 'activity';
  content: string;
  isFrontend?: boolean;
  isBackend?: boolean;
  toolCallId?: string;
  // Store tool calls for rendering (e.g., todo_write)
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
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

// RFC 6902 JSON Patch operation for STATE_DELTA events
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

// Full AG-UI protocol event interface
export interface AGUIEvent {
  type: EventTypeValue;
  // BaseEvent fields
  timestamp?: number;
  rawEvent?: unknown;
  // Lifecycle event fields
  messageId?: string;
  runId?: string;
  threadId?: string;
  parentRunId?: string;
  input?: unknown;
  result?: unknown;
  // Text message fields
  delta?: string;
  role?: string;
  // Tool call fields
  toolCallId?: string;
  toolCallName?: string;
  parentMessageId?: string;
  content?: string;
  // Error fields
  message?: string;
  code?: string;
  // Step event fields
  stepName?: string;
  // State management fields
  state?: unknown;
  operations?: JsonPatchOperation[];
  messages?: Message[];
  // Activity event fields
  activityType?: string;
  // Custom event fields
  name?: string;
  value?: unknown;
  // Raw event fields
  source?: string;
}

// CopilotKit-like types for dynamic action registration
export interface CopilotActionParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required?: boolean;
}

export interface CopilotAction {
  name: string;
  description: string;
  parameters: CopilotActionParameter[];
  handler: (args: Record<string, unknown>) => string | Promise<string>;
  disableFollowUp?: boolean;
}

export interface CopilotContextValue {
  messages: Message[];
  isLoading: boolean;
  actions: Map<string, CopilotAction>;
  sendMessage: (content: string) => Promise<void>;
  registerAction: (action: CopilotAction) => void;
  unregisterAction: (name: string) => void;
  // Readable context for exposing app state to the LLM (matches CopilotKit API)
  addContext: (context: string, parentId?: string, categories?: string[]) => string;
  removeContext: (id: string) => void;
  getContextString: (categories?: string[]) => string;
}
