import { test, expect } from '@playwright/test';

test.describe('AG-UI Frontend Tool Calls', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to the frontend
    await page.goto('/');
    // Wait for the page to fully load
    await expect(page.getByTestId('chat-container')).toBeVisible();
  });

  test('should execute greet frontend tool when prompted', async ({ page }) => {
    // Set up dialog handler BEFORE sending the message
    // The greet tool shows an alert with the greeting
    let alertMessage = '';
    page.on('dialog', async (dialog) => {
      alertMessage = dialog.message();
      await dialog.accept();
    });

    // Type a message that triggers the greet tool
    const input = page.getByTestId('message-input');
    await expect(input).toBeVisible();
    await input.fill('Please greet Alice using the greet tool.');

    // Click send button
    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // Wait for the response - the tool execution message should appear
    // Frontend tool executions are shown with a specific data-testid
    const toolMessage = page.getByTestId('message-tool-frontend');
    await expect(toolMessage).toBeVisible({ timeout: 60000 });

    // Verify the tool was executed for the greet tool
    await expect(toolMessage).toContainText('greet');
    await expect(toolMessage).toContainText('executed');

    // Verify the alert was shown (this confirms frontend execution)
    expect(alertMessage).toContain('Hello');
    expect(alertMessage).toContain('Alice');
  });

  test('should execute setTheme frontend tool when prompted', async ({ page }) => {
    // Get the initial background color
    const initialBg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });

    // Type a message that triggers the setTheme tool
    const input = page.getByTestId('message-input');
    await expect(input).toBeVisible();
    await input.fill('Change the theme to lightblue using the setTheme tool.');

    // Click send button
    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // Wait for the tool execution message
    const toolMessage = page.getByTestId('message-tool-frontend');
    await expect(toolMessage).toBeVisible({ timeout: 60000 });

    // Verify the tool was executed for setTheme
    await expect(toolMessage).toContainText('setTheme');
    await expect(toolMessage).toContainText('executed');

    // Verify the background color changed
    const newBg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });

    // The background should have changed from the initial gray (#f5f5f5)
    // to lightblue (rgb(173, 216, 230))
    expect(newBg).not.toBe(initialBg);
    // lightblue in RGB
    expect(newBg).toBe('rgb(173, 216, 230)');
  });

  test('should show loading state while waiting for response', async ({ page }) => {
    // Type a message
    const input = page.getByTestId('message-input');
    await input.fill('Hello');

    // Click send and immediately check for loading state
    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // The button should be disabled during loading
    await expect(sendButton).toBeDisabled();

    // Wait for the response to complete
    await expect(sendButton).toBeEnabled({ timeout: 60000 });
  });

  test('should stream text messages in real-time', async ({ page }) => {
    // Type a simple message that doesn't trigger tools
    const input = page.getByTestId('message-input');
    await input.fill('Say hello in exactly 3 words.');

    // Click send button
    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // Wait for an assistant message to appear
    const assistantMessage = page.getByTestId('message-assistant');
    await expect(assistantMessage.first()).toBeVisible({ timeout: 60000 });

    // The message should have content
    await expect(assistantMessage.first()).not.toBeEmpty();
  });

  test('should handle multiple tool calls in sequence', async ({ page }) => {
    // Set up dialog handler for greet tool
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    // First, trigger greet tool
    const input = page.getByTestId('message-input');
    await input.fill('Greet Bob using the greet tool.');

    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // Wait for first tool execution
    const firstToolMessage = page.getByTestId('message-tool-frontend').first();
    await expect(firstToolMessage).toBeVisible({ timeout: 60000 });
    await expect(firstToolMessage).toContainText('greet');

    // Wait for the send button to be enabled again
    await expect(sendButton).toBeEnabled({ timeout: 60000 });

    // Now trigger setTheme tool
    await input.fill('Change theme to pink using setTheme.');
    await sendButton.click();

    // Wait for second tool execution
    // There should now be multiple tool messages
    const toolMessages = page.getByTestId('message-tool-frontend');
    await expect(toolMessages).toHaveCount(2, { timeout: 60000 });

    // Second message should be about setTheme
    const secondToolMessage = toolMessages.nth(1);
    await expect(secondToolMessage).toContainText('setTheme');
  });

  test('should display user messages correctly', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const testMessage = 'This is a test message';
    await input.fill(testMessage);

    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // Check that the user message appears in the chat
    const userMessage = page.getByTestId('message-user');
    await expect(userMessage).toContainText(testMessage);
  });

  test('should clear input after sending message', async ({ page }) => {
    const input = page.getByTestId('message-input');
    await input.fill('Test message');

    const sendButton = page.getByTestId('send-button');
    await sendButton.click();

    // Input should be cleared after sending
    await expect(input).toHaveValue('');
  });
});
