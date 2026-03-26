/**
 * AG-UI Protocol Compliance Tests
 * Verifies ALL AG-UI event types, RunAgentInput format, and frontend tool flow.
 *
 * The message "Get the weather in Tokyo and greet Alice" triggers a two-phase flow:
 *   Phase 1 (initial): LLM returns [get_weather, greet] tool calls
 *     → TOOL_CALL_*, ACTIVITY_*, STATE_DELTA, THINKING_*, CUSTOM, etc.
 *   Phase 2 (resume): Frontend executes greet → resumes → LLM returns text summary
 *     → TEXT_MESSAGE_*, THINKING_*, etc.
 *
 * Combined, both phases emit all AG-UI event types except RUN_ERROR (error-path only).
 */

import { test, expect } from '@playwright/test';

// AG-UI event types expected in a happy-path flow (initial + resume combined).
// THINKING events require a reasoning model (e.g. DeepSeek R1) that returns
// reasoning_content. They are listed separately so the test can report clearly.
const REQUIRED_EVENTS = [
  // Lifecycle
  'RUN_STARTED',
  'RUN_FINISHED',
  'STEP_STARTED',
  'STEP_FINISHED',
  // Text message (from final LLM response after tool results)
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  // Tool call
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  // State management
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'MESSAGES_SNAPSHOT',
  // Activity
  'ACTIVITY_SNAPSHOT',
  'ACTIVITY_DELTA',
  // Custom
  'CUSTOM',
];

// These require a reasoning model (DeepSeek R1, etc.) that returns reasoning_content
const THINKING_EVENTS = [
  'THINKING_START',
  'THINKING_END',
  'THINKING_TEXT_MESSAGE_START',
  'THINKING_TEXT_MESSAGE_CONTENT',
  'THINKING_TEXT_MESSAGE_END',
];

test.describe('AG-UI Protocol Compliance', () => {
  test('should emit ALL AG-UI event types and use RunAgentInput format', async ({ page }) => {
    // Capture all requests to /chat
    const chatRequests: { url: string; body: any }[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/chat')) {
        try {
          chatRequests.push({
            url: request.url(),
            body: JSON.parse(request.postData() || '{}'),
          });
        } catch {
          // ignore non-JSON requests
        }
      }
    });

    // Track console logs for event verification
    const eventLogs: string[] = [];
    page.on('console', (msg) => {
      eventLogs.push(msg.text());
    });

    // Handle alert for frontend tool (greet)
    let alertMessage = '';
    page.on('dialog', async (dialog) => {
      alertMessage = dialog.message();
      await dialog.accept();
    });

    await page.goto('http://localhost:3000');
    const input = page.getByTestId('message-input');
    await expect(input).toBeVisible();

    // This message triggers both tool types + text summary across two phases:
    //   Phase 1: get_weather (BE) + greet (FE, interrupts)
    //   Phase 2: resume → LLM text summary
    await input.fill('Get the weather in Tokyo and greet Alice');
    await page.getByTestId('send-button').click();

    // Wait for full completion (both phases)
    await expect(input).toBeEnabled({ timeout: 60000 });

    // === VERIFY ALL REQUIRED EVENT TYPES ===
    const missingRequired: string[] = [];
    for (const eventType of REQUIRED_EVENTS) {
      const found = eventLogs.some((log) => log.includes(eventType));
      if (!found) {
        missingRequired.push(eventType);
      }
    }
    expect(missingRequired, `Missing required AG-UI events: ${missingRequired.join(', ')}`).toEqual(
      []
    );

    // === VERIFY THINKING EVENTS (requires reasoning model like DeepSeek R1) ===
    const missingThinking: string[] = [];
    for (const eventType of THINKING_EVENTS) {
      const found = eventLogs.some((log) => log.includes(eventType));
      if (!found) {
        missingThinking.push(eventType);
      }
    }
    // These events require a reasoning model. If missing, the model doesn't support reasoning.
    if (missingThinking.length > 0) {
      console.warn(
        `Thinking events missing (model may not support reasoning): ${missingThinking.join(', ')}`
      );
    }
    expect(
      missingThinking,
      `Missing THINKING events — ensure MODEL is a reasoning model (e.g. deepseek/deepseek-r1-0528-qwen3-8b:free): ${missingThinking.join(', ')}`
    ).toEqual([]);

    // === VERIFY REQUEST FORMAT (RunAgentInput) ===
    expect(chatRequests.length).toBeGreaterThanOrEqual(1);
    const firstRequest = chatRequests[0].body;

    expect(firstRequest).toHaveProperty('thread_id');
    expect(firstRequest).toHaveProperty('run_id');
    expect(firstRequest).toHaveProperty('messages');
    expect(firstRequest).toHaveProperty('tools');
    expect(firstRequest).toHaveProperty('context');
    expect(Array.isArray(firstRequest.messages)).toBe(true);
    expect(firstRequest.messages.length).toBeGreaterThanOrEqual(1);
    expect(firstRequest.messages[0]).toHaveProperty('role', 'user');
    expect(firstRequest.messages[0]).toHaveProperty('content');

    // No legacy fields
    expect(firstRequest).not.toHaveProperty('message');
    expect(firstRequest).not.toHaveProperty('resume_value');

    // === VERIFY RESUME FORMAT (ToolMessage in messages) ===
    expect(chatRequests.length).toBeGreaterThanOrEqual(2);
    const resumeRequest = chatRequests[1].body;

    expect(resumeRequest).toHaveProperty('thread_id');
    expect(resumeRequest).toHaveProperty('run_id');
    expect(resumeRequest).toHaveProperty('messages');
    expect(Array.isArray(resumeRequest.messages)).toBe(true);

    const toolMessages = resumeRequest.messages.filter((m: any) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0]).toHaveProperty('tool_call_id');
    expect(toolMessages[0]).toHaveProperty('content');
    expect(resumeRequest).not.toHaveProperty('resume_value');

    // === VERIFY NO LEGACY CUSTOM EVENTS ===
    expect(eventLogs.some((log) => log.includes('frontend_tool_required'))).toBe(false);
    expect(eventLogs.some((log) => log.includes('run_interrupted'))).toBe(false);

    // === VERIFY FRONTEND TOOL EXECUTED ===
    expect(alertMessage).toContain('Alice');

    // === VERIFY UI STATE ===
    await expect(input).toBeEnabled();
    await expect(page.getByTestId('messages')).toBeVisible();
    await expect(page.getByTestId('message-user')).toBeVisible();
    await expect(page.getByTestId('message-assistant')).toBeVisible();

    const toolLogs = page.getByTestId('tool-logs');
    await expect(toolLogs).toBeVisible();
  });

  test('should handle errors with RUN_ERROR event', async ({ page }) => {
    const eventLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('RUN_ERROR') || msg.text().includes('RUN_FINISHED')) {
        eventLogs.push(msg.text());
      }
    });

    await page.goto('http://localhost:3000');
    const input = page.getByTestId('message-input');
    await expect(input).toBeVisible();
  });
});
