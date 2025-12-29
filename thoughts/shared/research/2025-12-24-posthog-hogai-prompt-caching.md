---
date: 2025-12-24T00:00:00-08:00
researcher: Claude
git_commit: 9904d784866659a54325dda02361a0ee16e832bd
branch: feat/integrate-fe-and-be-tool-coordination
repository: minimal-chat
topic: "PostHog HogAI Prompt Caching with Changing Context"
tags: [research, codebase, prompt-caching, llm, anthropic, openai, posthog]
status: complete
last_updated: 2025-12-24
last_updated_by: Claude
---

# Research: PostHog HogAI Prompt Caching with Changing Context

**Date**: 2025-12-24
**Researcher**: Claude
**Git Commit**: 9904d784866659a54325dda02361a0ee16e832bd
**Branch**: feat/integrate-fe-and-be-tool-coordination
**Repository**: minimal-chat

## Research Question

How does PostHog's HogAI (in `reference_code/posthog-master/ee/hogai/`) implement prompt caching with a changing context?

## Summary

PostHog's HogAI implements prompt caching through a **"static first, dynamic last"** strategy combined with explicit cache control headers for Anthropic models and `prompt_cache_key` for OpenAI models. The core technique:

1. **Static prompts at the beginning**: Role, tone, style, and core instructions are defined as constants and placed first
2. **Dynamic context appended at the end**: User/team context, billing info, core memory, and UI context are injected at the end
3. **Two-tier TTL caching**: System prompts cached for 1 hour, conversation prefixes cached with 5-minute ephemeral TTL
4. **Context message insertion point**: Context messages are inserted BEFORE the user's message to maximize cache prefix reuse

## Detailed Findings

### 1. The Core Caching Pattern: Static First, Dynamic Last

**File**: `reference_code/posthog-master/ee/hogai/PROMPTING_GUIDE.md:199-227`

```python
# GOOD - static content first, dynamic last
SYSTEM_PROMPT = """
You are an expert analyst...

<static_instructions>
These instructions never change...
</static_instructions>

<examples>
Static examples...
</examples>

{{{dynamic_user_context}}}
{{{current_data}}}
""".strip()

# BAD - dynamic content breaks caching
SYSTEM_PROMPT = """
Current user: {{{user_name}}}     # <-- Breaks cache!
Current project: {{{project_name}}}

You are an expert analyst...
"""
```

### 2. Cache Control Implementation (Anthropic)

**File**: `reference_code/posthog-master/ee/hogai/utils/anthropic.py:18-34`

```python
def add_cache_control(message: BaseMessage, ttl: Literal["5m", "1h"] | None = None) -> BaseMessage:
    ttl = ttl or "5m"
    if isinstance(message.content, str):
        message.content = [
            {"type": "text", "text": message.content, "cache_control": {"type": "ephemeral", "ttl": ttl}},
        ]
    if message.content:
        last_content = message.content[-1]
        if isinstance(last_content, str):
            message.content[-1] = {
                "type": "text",
                "text": last_content,
                "cache_control": {"type": "ephemeral", "ttl": ttl},
            }
        else:
            last_content["cache_control"] = {"type": "ephemeral", "ttl": ttl}
    return message
```

**Usage** (in `ee/hogai/core/agent_modes/executables.py:184`):
```python
# Mark the longest default prefix as cacheable (1 hour)
add_cache_control(system_prompts[0], ttl="1h")
```

### 3. Two-Tier Caching Strategy

| Cache Level | TTL | What's Cached |
|-------------|-----|---------------|
| System Prompt | 1 hour | Base agent instructions, role, tone, style |
| Conversation Prefix | 5 minutes (ephemeral) | Previous messages in conversation |

**File**: `reference_code/posthog-master/ee/hogai/core/agent_modes/executables.py:289-301`

```python
def _add_cache_control_to_last_message(self, messages: list[BaseMessage]) -> list[BaseMessage]:
    """Add cache control to the last message."""
    for i in range(len(messages) - 1, -1, -1):
        maybe_content_arr = messages[i].content
        if (
            isinstance(messages[i], LangchainHumanMessage | LangchainAIMessage)
            and isinstance(maybe_content_arr, list)
            and len(maybe_content_arr) > 0
            and isinstance(maybe_content_arr[-1], dict)
        ):
            maybe_content_arr[-1]["cache_control"] = {"type": "ephemeral"}
            break
    return messages
```

### 4. Prompt Assembly with Mustache Templating

**File**: `reference_code/posthog-master/ee/hogai/chat_agent/mode_manager.py:138-161`

```python
async def get_prompts(self, state: AssistantState, config: RunnableConfig) -> list[BaseMessage]:
    # Gather dynamic context in parallel
    billing_context_prompt, core_memory, groups = await asyncio.gather(
        self._get_billing_prompt(),
        self._aget_core_memory_text(),
        self._context_manager.get_group_names(),
    )

    # Build static system prompt first
    system_prompt = format_prompt_string(
        AGENT_PROMPT,
        role=ROLE_PROMPT,                    # Static
        tone_and_style=TONE_AND_STYLE_PROMPT, # Static
        writing_style=WRITING_STYLE_PROMPT,   # Static
        proactiveness=PROACTIVENESS_PROMPT,   # Static
        basic_functionality=BASIC_FUNCTIONALITY_PROMPT,  # Static
        switching_modes=SWITCHING_MODES_PROMPT,          # Static
        task_management=TASK_MANAGEMENT_PROMPT,          # Static
        doing_tasks=DOING_TASKS_PROMPT,                  # Static
        tool_usage_policy=TOOL_USAGE_POLICY_PROMPT,      # Static
    )

    # Inject dynamic context at the end
    return ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            ("system", AGENT_CORE_MEMORY_PROMPT),  # Contains {{{core_memory}}} placeholder
        ],
        template_format="mustache",
    ).format_messages(
        groups_prompt=...,          # Dynamic - appended
        billing_context=...,        # Dynamic - appended
        core_memory=...,            # Dynamic - appended
    )
```

### 5. Context Injection Before User Message

**File**: `reference_code/posthog-master/ee/hogai/context/context.py:72-82`

```python
async def get_state_messages_with_context(
    self, state: BaseStateWithMessages
) -> Sequence[AssistantMessageUnion] | None:
    if context_prompts := await self._get_context_messages(state):
        # Insert context messages BEFORE the start human message
        # so they're properly cached and the context is retained
        updated_messages = self._inject_context_messages(state, context_prompts)
        return updated_messages
    return None
```

**Why before user message?** This maximizes the cache prefix. The ordering becomes:

```
[System Message 1 - CACHED 1h]   ← Static base prompt
[System Message 2 - CACHED 1h]   ← Core memory prompt
[Context Messages - NOT CACHED]  ← UI context, tools
[Conversation History - CACHED 5m ephemeral]
[Current User Message - NOT CACHED]
```

### 6. OpenAI Prompt Caching (prompt_cache_key)

**File**: `reference_code/posthog-master/ee/hogai/chat_agent/schema_generator/nodes.py:74-76`

```python
model_kwargs={
    "prompt_cache_key": f"team_{self._team.id}",  # Team-specific cache
},
```

This uses OpenAI's newer prompt caching feature with team-scoped keys.

### 7. MaxChatOpenAI Context Injection

**File**: `reference_code/posthog-master/ee/hogai/llm.py:19-25`

```python
PROJECT_ORG_USER_CONTEXT_PROMPT = """
You are currently in project {{{project_name}}}, which is part of the {{{organization_name}}} organization.
The user's name appears to be {{{user_full_name}}} ({{{user_email}}}). Feel free to use their first name when greeting.
All PostHog app URLs must use absolute paths without a domain, omitting the `/project/:id/` prefix.
Current time in the project's timezone, {{{project_timezone}}}: {{{project_datetime}}}.
"""
```

**File**: `reference_code/posthog-master/ee/hogai/llm.py:95-110` (Regular mode)

Context is appended as an additional SystemMessage AFTER existing system messages:
```python
# Find position after last system message
insert_index = 0
for i, msg in enumerate(prompts):
    if isinstance(msg, LangchainSystemMessage):
        insert_index = i + 1
    else:
        break

# Insert context at that position
prompts = [*prompts[:insert_index], self._get_context_message(), *prompts[insert_index:]]
```

### 8. Cache Control Removal for Summarization

**File**: `reference_code/posthog-master/ee/hogai/utils/conversation_summarizer/summarizer.py:77-88`

When summarizing conversations, cache headers must be stripped:

```python
def _construct_messages(self, messages: Sequence[BaseMessage]):
    """Removes cache_control headers."""
    messages_without_cache: list[BaseMessage] = []
    for message in messages:
        if isinstance(message.content, list):
            message = message.model_copy(deep=True)  # Don't modify originals
            for content in message.content:
                if isinstance(content, dict) and "cache_control" in content:
                    content.pop("cache_control")
        messages_without_cache.append(message)
    return super()._construct_messages(messages_without_cache)
```

## Code References

- `reference_code/posthog-master/ee/hogai/PROMPTING_GUIDE.md:199-227` - Caching best practices documentation
- `reference_code/posthog-master/ee/hogai/utils/anthropic.py:18-34` - `add_cache_control()` implementation
- `reference_code/posthog-master/ee/hogai/core/agent_modes/executables.py:184` - System prompt 1h cache
- `reference_code/posthog-master/ee/hogai/core/agent_modes/executables.py:289-301` - Ephemeral conversation cache
- `reference_code/posthog-master/ee/hogai/chat_agent/mode_manager.py:138-161` - Prompt assembly
- `reference_code/posthog-master/ee/hogai/context/context.py:72-82` - Context injection
- `reference_code/posthog-master/ee/hogai/llm.py:19-25` - MaxChatOpenAI context template
- `reference_code/posthog-master/ee/hogai/chat_agent/schema_generator/nodes.py:74-76` - OpenAI prompt_cache_key

## Architecture Insights

### The Cache-Efficient Message Structure

```
┌─────────────────────────────────────────┐
│ SYSTEM MESSAGE 1 (1h cache)             │
│ ├─ ROLE_PROMPT                          │  ← Static, unchanging
│ ├─ TONE_AND_STYLE_PROMPT                │
│ ├─ WRITING_STYLE_PROMPT                 │
│ ├─ PROACTIVENESS_PROMPT                 │
│ ├─ BASIC_FUNCTIONALITY_PROMPT           │
│ ├─ SWITCHING_MODES_PROMPT               │
│ ├─ TASK_MANAGEMENT_PROMPT               │
│ ├─ DOING_TASKS_PROMPT                   │
│ └─ TOOL_USAGE_POLICY_PROMPT             │
├─────────────────────────────────────────┤
│ SYSTEM MESSAGE 2                        │
│ └─ CORE_MEMORY_PROMPT + {{{core_memory}}}│  ← Dynamic per conversation
├─────────────────────────────────────────┤
│ CONTEXT MESSAGES                        │
│ ├─ UI Context (dashboards, insights)    │  ← Dynamic per request
│ ├─ Tool Context                         │
│ └─ Groups Context                       │
├─────────────────────────────────────────┤
│ CONVERSATION HISTORY (5m ephemeral)     │
│ ├─ Previous user messages               │  ← Cached within conversation
│ └─ Previous assistant messages          │
├─────────────────────────────────────────┤
│ CURRENT USER MESSAGE                    │  ← Not cached
└─────────────────────────────────────────┘
```

### Key Design Decisions

1. **Mustache templating with triple braces `{{{var}}}`**: Allows dynamic injection without HTML escaping
2. **Parallel context gathering with `asyncio.gather()`**: Fetches billing, memory, and groups concurrently
3. **Two cache tiers**: 1h for immutable system prompts, 5m ephemeral for conversation flow
4. **Context injection point**: Before user message, not after system prompt - maximizes cacheable prefix
5. **Deep copy for cache removal**: Prevents mutation of original messages when stripping cache headers

## Open Questions

1. **Cache hit monitoring**: How does PostHog measure cache hit rates? (Likely through PostHog's own LLM analytics at `/llm-analytics/traces`)
2. **Multi-model support**: Does the same strategy work for Claude vs GPT vs other models?
3. **Cache invalidation**: When static prompts change (new features), how are caches invalidated?
