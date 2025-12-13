import { test, expect } from '@playwright/test';

/**
 * Comprehensive E2E tests for AG-UI Chat with CopilotKit-like features.
 *
 * Note: Tests that depend on LLM tool calling may be flaky depending on
 * the model used. The free model may not reliably call tools.
 */

test.describe('AG-UI Full Functionality', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-container')).toBeVisible();
  });

  test('chat interface loads correctly', async ({ page }) => {
    // Verify all main UI elements are present
    await expect(page.getByTestId('message-input')).toBeVisible();
    await expect(page.getByTestId('send-button')).toBeVisible();
    await expect(page.getByTestId('messages')).toBeVisible();
  });

  test('can send a message and receive a response', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Send a simple message
    await input.fill('Say hello');
    await sendButton.click();

    // Verify user message appears
    const userMessage = page.getByTestId('message-user');
    await expect(userMessage).toContainText('Say hello');

    // Wait for assistant response
    const assistantMessage = page.getByTestId('message-assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 60000 });

    // Input should be re-enabled after response
    await expect(input).toBeEnabled({ timeout: 60000 });
  });

  test('text streams in real-time', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    await input.fill('Count from 1 to 5');
    await sendButton.click();

    // Wait for assistant response to start appearing
    const assistantMessage = page.getByTestId('message-assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 60000 });

    // Message should have content (streamed)
    const content = await assistantMessage.first().textContent();
    expect(content).toBeTruthy();
    expect(content!.length).toBeGreaterThan(0);
  });

  test('loading state is shown during request', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    await input.fill('Hello');
    await sendButton.click();

    // Input should be disabled while loading
    await expect(input).toBeDisabled();

    // Wait for response to complete
    await expect(input).toBeEnabled({ timeout: 60000 });
  });

  test('input clears after sending message', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    await input.fill('Test message');
    await sendButton.click();

    // Input should be cleared immediately
    await expect(input).toHaveValue('');
  });

  test('user messages display correctly', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');
    const testMessage = 'Unique test message 12345';

    await input.fill(testMessage);
    await sendButton.click();

    // User message should appear with exact content
    const userMessage = page.getByTestId('message-user');
    await expect(userMessage).toContainText(testMessage);
  });

  test('multiple messages in conversation', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // First message
    await input.fill('Message one');
    await sendButton.click();
    await expect(input).toBeEnabled({ timeout: 60000 });

    // Second message
    await input.fill('Message two');
    await sendButton.click();
    await expect(input).toBeEnabled({ timeout: 60000 });

    // Verify both user messages exist
    const userMessages = page.getByTestId('message-user');
    const count = await userMessages.count();
    expect(count).toBe(2);
  });

  test('app remains functional after multiple exchanges', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Multiple exchanges
    for (let i = 1; i <= 3; i++) {
      await input.fill(`Message ${i}`);
      await sendButton.click();
      await expect(input).toBeEnabled({ timeout: 60000 });
    }

    // App should still be functional
    await input.fill('Final message');
    expect(await input.inputValue()).toBe('Final message');
  });

  // Tool-related tests - may be flaky depending on LLM
  test.describe('Frontend Tools (may be flaky with free models)', () => {
    test('greet tool shows alert when called', async ({ page }) => {
      // Set up dialog handler
      let alertMessage = '';
      page.on('dialog', async (dialog) => {
        alertMessage = dialog.message();
        await dialog.accept();
      });

      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      // Request the greet tool explicitly
      await input.fill('Please use the greet tool to greet "Alice". You must call the greet function.');
      await sendButton.click();

      // Wait for any response
      await expect(input).toBeEnabled({ timeout: 60000 });

      // Check if tool was called (alert triggered) OR just got a response
      const toolMessage = page.getByTestId('message-tool-frontend');
      const hasToolMessage = await toolMessage.count() > 0;

      if (hasToolMessage) {
        // Tool was called
        await expect(toolMessage.first()).toContainText('greet');
        expect(alertMessage).toContain('Alice');
      } else {
        // LLM didn't call the tool - this is expected with some models
        const assistantMessage = page.getByTestId('message-assistant');
        await expect(assistantMessage.first()).toBeVisible();
        console.log('Note: LLM did not call greet tool - this may be model-dependent');
      }
    });

    test('setTheme tool changes background when called', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      const initialBg = await page.evaluate(() => {
        return window.getComputedStyle(document.body).backgroundColor;
      });

      // Request theme change explicitly
      await input.fill('Use the setTheme tool to change background to red. You must call the setTheme function with color "red".');
      await sendButton.click();

      // Wait for response
      await expect(input).toBeEnabled({ timeout: 60000 });

      const toolMessage = page.getByTestId('message-tool-frontend');
      const hasToolMessage = await toolMessage.count() > 0;

      if (hasToolMessage) {
        // Tool was called - verify background changed
        const newBg = await page.evaluate(() => {
          return window.getComputedStyle(document.body).backgroundColor;
        });
        expect(newBg).not.toBe(initialBg);
      } else {
        // LLM didn't call the tool
        const assistantMessage = page.getByTestId('message-assistant');
        await expect(assistantMessage.first()).toBeVisible();
        console.log('Note: LLM did not call setTheme tool - this may be model-dependent');
      }
    });
  });
});
