# Data Model: Multi-Agent Chatbot with Dynamic Mode Selection

**Feature**: 001-multi-agent-chatbot
**Date**: 2025-12-14
**Status**: Complete

## Overview

This document defines the data entities, their relationships, and state management patterns for the multi-agent chatbot system.

---

## Core Entities

### 1. Message

A single unit of conversation content.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string (UUID) | Yes | Unique identifier |
| type | MessageType | Yes | One of: `human`, `assistant`, `tool_call`, `tool_result`, `context` |
| content | string | Yes | Message text content |
| timestamp | datetime | Yes | When message was created |
| metadata | object | No | Additional type-specific data |

**Validation Rules**:
- `id` must be unique across conversation
- `content` cannot be empty for `human` and `assistant` types
- `type` determines which `metadata` fields are valid

**State Transitions**:
- `assistant` messages: `streaming` → `complete` | `error`
- `tool_call` messages: `pending` → `executing` → `complete` | `error`

---

### 2. Tool Call

Information about a tool invocation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string | Yes | Unique call identifier |
| name | string | Yes | Tool name |
| arguments | object | Yes | Structured arguments |
| execution_location | ExecutionLocation | Yes | `backend` or `frontend` |
| status | ToolCallStatus | Yes | `pending`, `executing`, `complete`, `error` |

**Embedded In**: `Message.metadata` when `type = tool_call`

---

### 3. Tool Result

Output from a tool execution.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| tool_call_id | string | Yes | Reference to Tool Call |
| content | string | Yes | Text result for LLM |
| artifact | object | No | Structured data for UI |
| error | string | No | Error message if failed |

**Embedded In**: `Message.metadata` when `type = tool_result`

---

### 4. Tool Definition

Schema for a registered tool.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Unique tool identifier |
| description | string | Yes | LLM-facing description |
| args_schema | JSONSchema | Yes | Arguments schema |
| execution_location | ExecutionLocation | Yes | `backend` or `frontend` |
| mode | string | No | Mode restriction (null = all modes) |

**Validation Rules**:
- `name` must be unique across all tools
- `name` must be lowercase, alphanumeric with underscores
- `description` should explain when to use the tool

---

### 5. Agent Mode

Configuration for a specialized agent mode.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Unique mode identifier |
| description | string | Yes | LLM-facing description |
| tools | string[] | Yes | List of tool names available in this mode |
| system_prompt | string | No | Additional system prompt for this mode |

**Validation Rules**:
- `name` must be unique
- `tools` must reference valid tool names
- Default mode always exists

---

### 6. Conversation State

Full state of an ongoing conversation.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| id | string (UUID) | Yes | Conversation identifier |
| messages | Message[] | Yes | Ordered list of messages |
| current_mode | string | Yes | Active agent mode name |
| context | ContextPayload | No | Injected context from frontend |
| created_at | datetime | Yes | When conversation started |
| updated_at | datetime | Yes | Last activity timestamp |

**State Transitions**:
- Conversation: `active` → `idle` (timeout) → `archived`
- Mode: Any mode → any other mode (via `switch_mode` tool)

---

### 7. Context Payload

External context injected from frontend.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| ui_context | object | No | Current UI state (page, selection) |
| user_preferences | object | No | User settings and preferences |
| session_data | object | No | Session-specific information |

**Validation Rules**:
- Maximum size: 4KB (to fit in context window)
- No sensitive data (passwords, tokens)

---

## Enumerations

### MessageType
```
human       # User message
assistant   # Assistant response
tool_call   # Tool invocation
tool_result # Tool output
context     # System context message
```

### ExecutionLocation
```
backend     # Execute on server
frontend    # Execute in browser
```

### ToolCallStatus
```
pending     # Queued for execution
executing   # Currently running
complete    # Successfully finished
error       # Failed with error
```

---

## Relationships

```
┌─────────────────────┐
│  ConversationState  │
├─────────────────────┤
│  id                 │
│  current_mode ──────┼─────────┐
│  context            │         │
│  created_at         │         │
│  updated_at         │         │
└────────┬────────────┘         │
         │ 1:N                  │
         ▼                      │
┌─────────────────────┐         │
│      Message        │         │
├─────────────────────┤         │
│  id                 │         │
│  type               │         │
│  content            │         │
│  metadata ──────────┼────┐    │
│  timestamp          │    │    │
└─────────────────────┘    │    │
                           │    │
         ┌─────────────────┘    │
         │ (type-dependent)     │
         ▼                      │
┌─────────────────────┐         │
│    ToolCall         │         │
├─────────────────────┤         │
│  id                 │         │
│  name ──────────────┼─────┐   │
│  arguments          │     │   │
│  execution_location │     │   │
│  status             │     │   │
└─────────────────────┘     │   │
                            │   │
         ┌──────────────────┘   │
         │ N:1                  │
         ▼                      │
┌─────────────────────┐         │
│  ToolDefinition     │         │
├─────────────────────┤         │
│  name               │         │
│  description        │         │
│  args_schema        │         │
│  execution_location │         │
│  mode ──────────────┼────┐    │
└─────────────────────┘    │    │
                           │    │
         ┌─────────────────┘    │
         │ N:1                  │
         ▼                      │
┌─────────────────────┐◄────────┘
│    AgentMode        │
├─────────────────────┤
│  name               │
│  description        │
│  tools              │
│  system_prompt      │
└─────────────────────┘
```

---

## Message Merge Strategy

When updating conversation state, messages are merged by ID:

```
merge(existing: Message[], update: Message[]) → Message[]

1. For each message in update:
   a. If message.id exists in existing:
      - Replace existing message with update
   b. If message.id does not exist:
      - Append to result
2. Preserve order: existing order, then new messages
```

**Use Cases**:
- Streaming updates: Replace partial message with more content
- Tool results: Update tool_call message status, add tool_result
- Mode switch: Insert context message

---

## Context Window Management

To prevent context overflow:

```
compact(messages: Message[], max_tokens: int) → Message[]

1. Always preserve:
   - First message (conversation start)
   - Last N messages (recent context)
   - All tool_call and tool_result pairs
   - Context messages with mode information

2. Remove from middle:
   - Older assistant responses
   - Older human messages

3. Token counting:
   - Estimate 4 chars per token
   - Leave 20% buffer for response
```

---

## Sample Data

### Conversation State Example

```json
{
  "id": "conv_abc123",
  "messages": [
    {
      "id": "msg_001",
      "type": "human",
      "content": "What's the weather in San Francisco?",
      "timestamp": "2025-12-14T10:00:00Z",
      "metadata": {}
    },
    {
      "id": "msg_002",
      "type": "tool_call",
      "content": "",
      "timestamp": "2025-12-14T10:00:01Z",
      "metadata": {
        "id": "call_xyz",
        "name": "get_weather",
        "arguments": {"city": "San Francisco"},
        "execution_location": "backend",
        "status": "complete"
      }
    },
    {
      "id": "msg_003",
      "type": "tool_result",
      "content": "Weather in San Francisco: 65°F, Partly Cloudy",
      "timestamp": "2025-12-14T10:00:02Z",
      "metadata": {
        "tool_call_id": "call_xyz",
        "artifact": {
          "type": "weather_card",
          "data": {"temp": 65, "condition": "partly_cloudy"}
        }
      }
    },
    {
      "id": "msg_004",
      "type": "assistant",
      "content": "The current weather in San Francisco is 65°F and partly cloudy.",
      "timestamp": "2025-12-14T10:00:03Z",
      "metadata": {}
    }
  ],
  "current_mode": "default",
  "context": {
    "ui_context": {
      "current_page": "/chat"
    }
  },
  "created_at": "2025-12-14T10:00:00Z",
  "updated_at": "2025-12-14T10:00:03Z"
}
```

### Agent Mode Example

```json
{
  "name": "sql",
  "description": "SQL query mode for database operations",
  "tools": ["execute_sql", "validate_sql", "explain_query"],
  "system_prompt": "You are in SQL mode. Help users write and execute SQL queries."
}
```

### Tool Definition Example

```json
{
  "name": "get_weather",
  "description": "Get current weather for a city. Use when user asks about weather conditions.",
  "args_schema": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string",
        "description": "City name"
      }
    },
    "required": ["city"]
  },
  "execution_location": "backend",
  "mode": null
}
```
