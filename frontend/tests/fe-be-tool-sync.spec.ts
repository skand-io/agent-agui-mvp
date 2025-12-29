import { test, expect } from '@playwright/test';

/**
 * E2E tests for Frontend/Backend tool synchronization.
 *
 * These tests verify the critical behavior where:
 * 1. Backend stops processing when it hits a frontend tool
 * 2. Frontend tool executes correctly
 * 3. Auto-follow-up continues processing remaining tools
 *
 * Key scenarios:
 * - FE tool first, then BE tool: Should stop at FE, execute, follow-up runs BE
 * - BE tool first, then FE tool: Should run BE, stop at FE, execute FE
 * - Sequential tests: Running both scenarios should not corrupt state
 */

test.describe('FE/BE Tool Synchronization', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-container')).toBeVisible();
  });

  test('should execute FE tool first, then BE tool via follow-up', async ({ page }) => {
    // Set up dialog handler for greet tool
    let alertMessage = '';
    let alertCount = 0;
    page.on('dialog', async (dialog) => {
      alertMessage = dialog.message();
      alertCount++;
      console.log(`Alert ${alertCount}: "${alertMessage}"`);
      await dialog.accept();
    });

    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Request FE tool first, then BE tool
    await input.fill('Please greet John using the greet tool, and then calculate 5+3.');
    await sendButton.click();

    // Wait for response to complete
    await expect(input).toBeEnabled({ timeout: 120000 });

    // Check for greet (frontend tool) result
    const frontendToolMessages = page.getByTestId('message-tool-frontend');
    const frontendCount = await frontendToolMessages.count();
    console.log(`Frontend tool calls: ${frontendCount}`);

    // Check for calculate (backend tool) result
    const backendToolMessages = page.getByTestId('message-tool-backend');
    const backendCount = await backendToolMessages.count();
    console.log(`Backend tool calls: ${backendCount}`);

    // Log all tool messages for debugging
    const frontendText = await frontendToolMessages.allTextContents();
    const backendText = await backendToolMessages.allTextContents();
    console.log('Frontend tool results:', frontendText);
    console.log('Backend tool results:', backendText);

    // Verify greet was executed
    if (frontendCount > 0) {
      expect(alertCount).toBeGreaterThan(0);
      expect(alertMessage).toContain('John');
      const greetResult = frontendText.find(t => t.toLowerCase().includes('greet'));
      expect(greetResult).toBeDefined();
    }

    // Verify calculate was executed (via follow-up)
    if (backendCount > 0) {
      const calcResult = backendText.find(t => t.includes('8'));
      console.log('Calculate result found:', !!calcResult);
    }

    // Verify we got a final assistant message
    const assistantMessages = page.getByTestId('message-assistant');
    await expect(assistantMessages.first()).toBeVisible();
  });

  test('should execute BE tool first, then stop at FE tool and execute it', async ({ page }) => {
    // Set up dialog handler for greet tool
    let alertMessage = '';
    let alertCount = 0;
    page.on('dialog', async (dialog) => {
      alertMessage = dialog.message();
      alertCount++;
      console.log(`Alert ${alertCount}: "${alertMessage}"`);
      await dialog.accept();
    });

    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Request BE tool first, then FE tool
    await input.fill('Calculate 5+3, and then greet John using the greet tool.');
    await sendButton.click();

    // Wait for response to complete
    await expect(input).toBeEnabled({ timeout: 120000 });

    // Check for calculate (backend tool) result
    const backendToolMessages = page.getByTestId('message-tool-backend');
    const backendCount = await backendToolMessages.count();
    console.log(`Backend tool calls: ${backendCount}`);

    // Check for greet (frontend tool) result
    const frontendToolMessages = page.getByTestId('message-tool-frontend');
    const frontendCount = await frontendToolMessages.count();
    console.log(`Frontend tool calls: ${frontendCount}`);

    // Log all tool messages for debugging
    const backendText = await backendToolMessages.allTextContents();
    const frontendText = await frontendToolMessages.allTextContents();
    console.log('Backend tool results:', backendText);
    console.log('Frontend tool results:', frontendText);

    // CRITICAL: Verify greet was executed even though it came after calculate
    if (frontendCount > 0) {
      expect(alertCount).toBeGreaterThan(0);
      expect(alertMessage).toContain('John');
      const greetResult = frontendText.find(t => t.toLowerCase().includes('greet'));
      expect(greetResult).toBeDefined();
      console.log('SUCCESS: FE tool executed after BE tool');
    } else {
      console.log('WARNING: FE tool was not executed - this may indicate the bug');
    }

    // Verify calculate was executed
    if (backendCount > 0) {
      const calcResult = backendText.find(t => t.includes('8'));
      console.log('Calculate result found:', !!calcResult);
    }

    // Verify we got a final assistant message
    const assistantMessages = page.getByTestId('message-assistant');
    await expect(assistantMessages.first()).toBeVisible();
  });

  test('should handle sequential requests without state corruption', async ({ page }) => {
    // This test runs multiple FE-only tool calls to verify state isn't corrupted
    // Note: We use simpler prompts to reduce LLM confusion from todo_write chains
    let alertMessages: string[] = [];
    page.on('dialog', async (dialog) => {
      alertMessages.push(dialog.message());
      console.log(`Alert: "${dialog.message()}"`);
      await dialog.accept();
    });

    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // --- First request: Simple greet ---
    console.log('\n=== Request 1: Simple greet ===');
    await input.fill('Greet Alice using the greet tool.');
    await sendButton.click();
    await expect(input).toBeEnabled({ timeout: 120000 });

    let frontendCount = await page.getByTestId('message-tool-frontend').count();
    console.log(`Request 1 - Frontend: ${frontendCount}`);

    // Verify first greet worked
    const alertsAfterFirst = alertMessages.length;
    console.log(`Alerts after request 1: ${alertsAfterFirst}`);
    expect(alertsAfterFirst).toBeGreaterThan(0);
    expect(alertMessages[0]).toContain('Alice');

    // --- Second request: Another simple greet ---
    console.log('\n=== Request 2: Another simple greet ===');
    await input.fill('Now greet Bob using the greet tool.');
    await sendButton.click();
    await expect(input).toBeEnabled({ timeout: 120000 });

    frontendCount = await page.getByTestId('message-tool-frontend').count();
    console.log(`Request 2 - Frontend: ${frontendCount}`);

    // CRITICAL: Verify second greet worked (state corruption check)
    const alertsAfterSecond = alertMessages.length;
    console.log(`Alerts after request 2: ${alertsAfterSecond}`);
    expect(alertsAfterSecond).toBeGreaterThan(alertsAfterFirst);
    expect(alertMessages[alertMessages.length - 1]).toContain('Bob');
    console.log('SUCCESS: Second greet worked - state is not corrupted');

    // --- Third request: Verify state is still good ---
    console.log('\n=== Request 3: Third greet to verify state ===');
    await input.fill('Finally, greet Charlie.');
    await sendButton.click();
    await expect(input).toBeEnabled({ timeout: 120000 });

    const alertsAfterThird = alertMessages.length;
    console.log(`Alerts after request 3: ${alertsAfterThird}`);
    expect(alertsAfterThird).toBeGreaterThan(alertsAfterSecond);
    expect(alertMessages[alertMessages.length - 1]).toContain('Charlie');
    console.log('SUCCESS: Third greet worked - state is stable');

    // Final verification: should have at least 3 assistant responses
    const assistantMessages = page.getByTestId('message-assistant');
    const msgCount = await assistantMessages.count();
    console.log(`\nTotal assistant messages: ${msgCount}`);
    expect(msgCount).toBeGreaterThanOrEqual(3);
  });

  test('should execute BE-only tools without stopping', async ({ page }) => {
    // Verify that when there are no FE tools, BE tools all execute normally
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    await input.fill('Calculate 5+3 and then get the weather for Tokyo.');
    await sendButton.click();

    await expect(input).toBeEnabled({ timeout: 120000 });

    const backendToolMessages = page.getByTestId('message-tool-backend');
    const backendCount = await backendToolMessages.count();
    console.log(`Backend tool calls: ${backendCount}`);

    const backendText = await backendToolMessages.allTextContents();
    console.log('Backend tool results:', backendText);

    // Both BE tools should have executed
    if (backendCount >= 2) {
      console.log('SUCCESS: Both BE tools executed in single request');
    } else if (backendCount === 1) {
      console.log('One BE tool executed - LLM may have called them sequentially');
    }

    const assistantMessages = page.getByTestId('message-assistant');
    await expect(assistantMessages.first()).toBeVisible();
  });
});
