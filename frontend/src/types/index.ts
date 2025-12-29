/**
 * AG-UI Event Types (Full Protocol Compliance)
 * These constants define all possible event types in the AG-UI protocol.
 */
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

/** Union type of all possible AG-UI event type values */
export type EventTypeValue = typeof EventType[keyof typeof EventType];

/** Valid roles for chat messages */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'developer' | 'activity';

/** Tool call data attached to assistant messages */
export interface ToolCallData {
  /** Unique identifier for the tool call */
  id: string;
  /** Name of the tool being called */
  name: string;
  /** JSON-encoded arguments string */
  arguments: string;
}

/** A chat message in the conversation */
export interface Message {
  /** Unique message identifier */
  id?: string;
  /** Role of the message sender */
  role: MessageRole;
  /** Message content - mutable for streaming updates */
  content: string;
  /** Whether this is from a frontend tool execution */
  isFrontend?: boolean;
  /** Whether this is from a backend tool execution */
  isBackend?: boolean;
  /** ID of the tool call this message responds to (for tool role) */
  toolCallId?: string;
  /** Tool calls made by assistant (for rendering) */
  toolCalls?: ToolCallData[];
  /** Current todo list state to render after tool results */
  currentTodos?: TodoItem[];
}

/** Valid statuses for a todo item */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** A single todo item */
export interface TodoItem {
  /** Unique identifier for the todo */
  id: string;
  /** Description of the task */
  content: string;
  /** Current status of the task */
  status: TodoStatus;
}

// =============================================================================
// Tool Execution State Types (PostHog Pattern)
// =============================================================================

/** Valid statuses for tool execution tracking */
export type ToolExecutionStatus = 'pending' | 'executing' | 'completed' | 'failed';

/** Type of tool - frontend or backend */
export type ToolType = 'frontend' | 'backend';

/** System-level tracking for a single tool call */
export interface ToolExecutionItem {
  /** Unique tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** JSON-encoded arguments */
  arguments: string;
  /** Frontend or backend tool */
  tool_type: ToolType;
  /** Current execution status */
  status: ToolExecutionStatus;
  /** Execution result (if completed) */
  result?: string;
  /** Error message (if failed) */
  error?: string;
  /** Start timestamp in milliseconds */
  started_at?: number;
  /** Completion timestamp in milliseconds */
  completed_at?: number;
}

/** Full execution state for a run */
export interface ToolExecutionState {
  /** Run ID this state belongs to */
  run_id: string;
  /** Tool execution items */
  items: ToolExecutionItem[];
  /** Creation timestamp in milliseconds */
  created_at: number;
}

/** JSON Schema property definition */
export interface ToolParameterProperty {
  /** JSON Schema type */
  readonly type: string;
  /** Property description */
  readonly description: string;
  /** Allowed values (for enum types) */
  readonly enum?: readonly string[];
}

/** Tool definition for frontend tools */
export interface ToolDefinition {
  /** Tool name */
  readonly name: string;
  /** Tool description */
  readonly description: string;
  /** JSON Schema parameters */
  readonly parameters: {
    readonly type: string;
    readonly properties: Readonly<Record<string, ToolParameterProperty>>;
    readonly required: readonly string[];
  };
  /** Handler function that executes the tool */
  readonly handler: (args: Readonly<Record<string, string>>) => string;
}

/** Tool call being processed (mutable for streaming) */
export interface ToolCall {
  /** Tool name */
  name: string;
  /** JSON-encoded arguments (accumulated during streaming) */
  arguments: string;
}

/** RFC 6902 JSON Patch operation types */
export type JsonPatchOperationType = 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';

/** RFC 6902 JSON Patch operation for STATE_DELTA events */
export interface JsonPatchOperation {
  /** The operation type */
  readonly op: JsonPatchOperationType;
  /** JSON Pointer path to the target location */
  readonly path: string;
  /** Value to use for add/replace/test operations */
  readonly value?: unknown;
  /** Source path for move/copy operations */
  readonly from?: string;
}

/**
 * Full AG-UI protocol event interface.
 * All fields are optional since different event types use different fields.
 */
export interface AGUIEvent {
  /** Event type discriminator */
  readonly type: EventTypeValue;

  // BaseEvent fields
  /** Event timestamp in milliseconds */
  readonly timestamp?: number;
  /** Raw underlying event data */
  readonly rawEvent?: unknown;

  // Lifecycle event fields
  /** Message ID for message-related events */
  readonly messageId?: string;
  /** Run ID for the current execution */
  readonly runId?: string;
  /** Thread ID for the conversation */
  readonly threadId?: string;
  /** Parent run ID for nested runs */
  readonly parentRunId?: string;
  /** Input data for run start events */
  readonly input?: unknown;
  /** Result data for run finish events */
  readonly result?: unknown;

  // Text message fields
  /** Text content delta for streaming */
  readonly delta?: string;
  /** Message role */
  readonly role?: string;

  // Tool call fields
  /** Tool call ID */
  readonly toolCallId?: string;
  /** Tool name being called */
  readonly toolCallName?: string;
  /** Parent message ID for the tool call */
  readonly parentMessageId?: string;
  /** Content/result of tool execution */
  readonly content?: string;

  // Error fields
  /** Error message */
  readonly message?: string;
  /** Error code */
  readonly code?: string;

  // Step event fields
  /** Name of the step being executed */
  readonly stepName?: string;

  // State management fields
  /** State snapshot data */
  readonly state?: unknown;
  /** JSON Patch operations for state delta */
  readonly operations?: readonly JsonPatchOperation[];
  /** Messages snapshot */
  readonly messages?: readonly Message[];

  // Activity event fields
  /** Type of activity */
  readonly activityType?: string;

  // Custom event fields
  /** Custom event name */
  readonly name?: string;
  /** Custom event value */
  readonly value?: unknown;

  // Raw event fields
  /** Source identifier for raw events */
  readonly source?: string;
}

// =============================================================================
// CopilotKit-like types for dynamic action registration
// =============================================================================

/** Allowed parameter types for CopilotAction parameters */
export type CopilotParameterType = 'string' | 'number' | 'boolean' | 'object';

/** Parameter definition for a CopilotAction */
export interface CopilotActionParameter {
  /** Parameter name */
  readonly name: string;
  /** Parameter type */
  readonly type: CopilotParameterType;
  /** Parameter description for the LLM */
  readonly description: string;
  /** Whether this parameter is required */
  readonly required?: boolean;
}

/** Action handler function type */
export type CopilotActionHandler = (
  args: Readonly<Record<string, unknown>>
) => string | Promise<string>;

/** A dynamically registered action that can be invoked by the LLM */
export interface CopilotAction {
  /** Unique action name */
  readonly name: string;
  /** Description of what the action does (for the LLM) */
  readonly description: string;
  /** Parameter definitions */
  readonly parameters: readonly CopilotActionParameter[];
  /** Handler function to execute the action */
  readonly handler: CopilotActionHandler;
  /** If true, don't trigger follow-up LLM call after execution */
  readonly disableFollowUp?: boolean;
}

/** Context value provided by CopilotProvider */
export interface CopilotContextValue {
  /** Current conversation messages */
  messages: Message[];
  /** Whether a request is in progress */
  isLoading: boolean;
  /** Registered actions available to the LLM */
  actions: Map<string, CopilotAction>;
  /** Send a message to the LLM */
  sendMessage: (content: string) => Promise<void>;
  /** Register a new action */
  registerAction: (action: CopilotAction) => void;
  /** Unregister an action by name */
  unregisterAction: (name: string) => void;
  /** Add readable context for exposing app state to the LLM */
  addContext: (context: string, parentId?: string, categories?: string[]) => string;
  /** Remove a context by ID */
  removeContext: (id: string) => void;
  /** Get the current context string for specified categories */
  getContextString: (categories?: string[]) => string;
}
