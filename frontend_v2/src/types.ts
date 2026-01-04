/**
 * Type definitions for AG-UI Minimal Example
 * Re-exports AG-UI core types and defines app-specific types
 */

// Re-export AG-UI types for convenience
export { EventType } from '@ag-ui/core';
export type {
  BaseEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  MessagesSnapshotEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  ThinkingStartEvent,
  ThinkingEndEvent,
  ThinkingTextMessageStartEvent,
  ThinkingTextMessageContentEvent,
  ThinkingTextMessageEndEvent,
  CustomEvent,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
  Message,
  AssistantMessage,
  ToolCall,
} from '@ag-ui/core';

// App-specific types for tool execution tracking (PostHog-style)
export interface ToolLog {
  id: string;
  message: string;
  status: 'processing' | 'completed' | 'error';
}

export interface AgentState {
  tool_logs: ToolLog[];
  // Add other state fields as needed
}

// JSON Patch operation (RFC 6902)
export interface JsonPatchOperation {
  op: 'add' | 'replace' | 'remove' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}
