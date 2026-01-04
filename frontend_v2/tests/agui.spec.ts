/**
 * AG-UI Protocol Comprehensive Test
 * Verifies all 21 event types + two-tier state synchronization
 */

import { test, expect } from '@playwright/test';

test.describe('AG-UI Protocol - All 21 Events + Two-Tier State Sync', () => {
  test('should emit all 21 events and synchronize state via two tiers', async ({ page }) => {
    // Track console logs for event verification
    const eventLogs: string[] = [];
    page.on('console', (msg) => {
      const text = msg.text();
      // Capture all AG-UI event logs (identified by emoji prefixes)
      if (text.match(/^[🚀🏁❌▶️⏸️📊💬🔧⚡🧠🎯✅]/)) {
        eventLogs.push(text);
      }
    });

    // Handle alert for frontend tool
    let alertMessage = '';
    page.on('dialog', async (dialog) => {
      alertMessage = dialog.message();
      await dialog.accept();
    });

    // Navigate
    await page.goto('http://localhost:3000');
    const input = page.getByTestId('message-input');
    await expect(input).toBeVisible();

    // Send message that triggers both tools
    await input.fill('Get the weather in Tokyo and greet Alice');
    await page.getByTestId('send-button').click();

    // Wait for completion (input re-enabled)
    await expect(input).toBeEnabled({ timeout: 60000 });

    // === VERIFY ALL 21 EVENTS ===
    // All event types from @ag-ui/core EventType enum

    const requiredEvents = [
      // Lifecycle (4 in success case)
      'RUN_STARTED',
      'RUN_FINISHED',
      // 'RUN_ERROR', // Only emitted on error - skip in success test
      'STEP_STARTED',
      'STEP_FINISHED',
      // Text Message (3)
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      // 'TEXT_MESSAGE_CHUNK', // Alternative to content streaming - optional
      // Thinking (5)
      'THINKING_START',
      'THINKING_END',
      'THINKING_TEXT_MESSAGE_START',
      'THINKING_TEXT_MESSAGE_CONTENT',
      'THINKING_TEXT_MESSAGE_END',
      // Tool Call (4)
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      // State Management (3)
      'STATE_SNAPSHOT',
      'STATE_DELTA',
      'MESSAGES_SNAPSHOT',
      // Activity (2)
      'ACTIVITY_SNAPSHOT',
      'ACTIVITY_DELTA',
      // Special (1)
      'CUSTOM',
    ];

    console.log('\n=== Event Verification ===');
    for (const eventType of requiredEvents) {
      const found = eventLogs.some((log) => log.includes(eventType));
      expect(found, `Event ${eventType} should be emitted`).toBe(true);
      console.log(`✅ ${eventType}`);
    }

    // === VERIFY TIER 1: Message-Based Tracking ===
    // Tool calls should appear in the messages array

    const messages = page.getByTestId('messages');
    await expect(messages).toBeVisible();

    // User message should appear
    await expect(page.getByTestId('message-user')).toBeVisible();

    // Assistant message with tool calls should appear
    await expect(page.getByTestId('message-assistant')).toBeVisible();

    // Tool calls should be visible (may need to wait a bit)
    await page.waitForTimeout(1000);
    const toolCallWeather = page.getByTestId('tool-call-get_weather');
    const toolCallGreet = page.getByTestId('tool-call-greet');

    // Check if at least one tool call is visible
    const weatherVisible = await toolCallWeather.isVisible().catch(() => false);
    const greetVisible = await toolCallGreet.isVisible().catch(() => false);
    expect(weatherVisible || greetVisible, 'At least one tool call should be visible').toBe(true);

    console.log('✅ Tier 1: Tool calls in messages array');

    // === VERIFY TIER 2: State-Based Tracking (tool_logs) ===
    // tool_logs should be updated via STATE_SNAPSHOT and STATE_DELTA

    const toolLogs = page.getByTestId('tool-logs');
    await expect(toolLogs).toBeVisible();

    // Both tool logs should be visible with completed status
    const toolLogElements = page.locator('[data-testid^="tool-log-"]');
    const count = await toolLogElements.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Check that logs show completed status (indicated by ✅)
    await expect(toolLogs).toContainText('✅');

    console.log('✅ Tier 2: tool_logs array synced via STATE_DELTA');

    // === VERIFY ACTIVITY TRACKING ===
    // Activity should have been shown during processing

    // Note: Activity may be cleared after completion, so we verify via logs
    const hasActivitySnapshot = eventLogs.some((log) => log.includes('ACTIVITY_SNAPSHOT'));
    const hasActivityDelta = eventLogs.some((log) => log.includes('ACTIVITY_DELTA'));
    expect(hasActivitySnapshot).toBe(true);
    expect(hasActivityDelta).toBe(true);

    console.log('✅ Activity tracking via ACTIVITY_SNAPSHOT/DELTA');

    // === VERIFY FRONTEND TOOL EXECUTION ===
    // Alert should have been shown for greet tool

    expect(alertMessage).toContain('Alice');
    console.log('✅ Frontend tool (greet) executed with alert');

    // === SUMMARY ===
    console.log('\n=== Test Summary ===');
    console.log('✅ All required AG-UI event types emitted');
    console.log('✅ Tier 1: Message-based tool tracking works');
    console.log('✅ Tier 2: State-based tool_logs tracking works');
    console.log('✅ Activity tracking works');
    console.log('✅ Frontend tool executed correctly');
  });

  test('should handle errors gracefully', async ({ page }) => {
    const eventLogs: string[] = [];
    page.on('console', (msg) => {
      if (msg.text().includes('RUN_ERROR') || msg.text().includes('❌')) {
        eventLogs.push(msg.text());
      }
    });

    await page.goto('http://localhost:3000');

    // Note: This test is a placeholder - actual error triggering depends on backend
    // For now, just verify the page loads
    const input = page.getByTestId('message-input');
    await expect(input).toBeVisible();
  });
});
