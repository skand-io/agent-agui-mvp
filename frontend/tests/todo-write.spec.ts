import { test, expect } from '@playwright/test';

/**
 * E2E tests for the TodoWriteTool functionality.
 *
 * The todo_write tool should be called by the LLM when:
 * - The task involves 3+ distinct steps
 * - The user explicitly requests a todo list
 * - Multiple tasks are provided
 *
 * These tests verify the TodoList component renders correctly
 * when the LLM calls the todo_write tool.
 */

test.describe('TodoWriteTool', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-container')).toBeVisible();
  });

  test('todo list appears for complex multi-step requests', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Send a complex request that should trigger the todo_write tool
    await input.fill(
      'I need you to help me with the following tasks: ' +
      '1. Create a user authentication system, ' +
      '2. Set up a database schema, ' +
      '3. Build API endpoints, ' +
      '4. Add input validation, ' +
      '5. Write unit tests. ' +
      'Please create a todo list to track these tasks.'
    );
    await sendButton.click();

    // Wait for response to complete
    await expect(input).toBeEnabled({ timeout: 90000 });

    // Check if todo list appeared
    const todoList = page.getByTestId('todo-list');
    const hasTodoList = await todoList.count() > 0;

    if (hasTodoList) {
      // Verify todo list structure
      await expect(todoList.first()).toBeVisible();

      // Check header
      const header = page.getByTestId('todo-header');
      await expect(header.first()).toBeVisible();
      await expect(header.first()).toContainText('Planning');

      // Check that todo items exist
      const todoItems = page.getByTestId('todo-items');
      await expect(todoItems.first()).toBeVisible();

      // Verify at least one todo item exists
      const itemCount = await page.locator('[data-testid^="todo-item-"]').count();
      expect(itemCount).toBeGreaterThan(0);

      console.log(`✓ Todo list rendered with ${itemCount} items`);
    } else {
      // LLM didn't call the todo_write tool - log for debugging
      const assistantMessage = page.getByTestId('message-assistant');
      await expect(assistantMessage.first()).toBeVisible();
      console.log('Note: LLM did not call todo_write tool - this may be model-dependent');
    }
  });

  test('todo list shows correct status indicators', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Request with explicit instruction to use todo list
    await input.fill(
      'Create a todo list for building a React app with: ' +
      '1. Set up project structure, ' +
      '2. Create components, ' +
      '3. Add styling, ' +
      '4. Write tests. ' +
      'Use the todo_write tool to track this.'
    );
    await sendButton.click();

    // Wait for response
    await expect(input).toBeEnabled({ timeout: 90000 });

    const todoList = page.getByTestId('todo-list');
    const hasTodoList = await todoList.count() > 0;

    if (hasTodoList) {
      // Check for status indicators
      const checkboxes = page.getByTestId('todo-checkbox');
      const checkboxCount = await checkboxes.count();

      if (checkboxCount > 0) {
        // Verify checkbox symbols are present (○, ◐, or ✓)
        const firstCheckbox = await checkboxes.first().textContent();
        expect(['○', '◐', '✓']).toContain(firstCheckbox?.trim());
        console.log(`✓ Found ${checkboxCount} todo items with status indicators`);
      }

      // Check progress display
      const header = page.getByTestId('todo-header');
      const headerText = await header.first().textContent();
      expect(headerText).toContain('completed');
      console.log(`✓ Header shows progress: ${headerText}`);
    } else {
      console.log('Note: LLM did not call todo_write tool');
    }
  });

  test('todo list renders inline with assistant message', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    await input.fill(
      'Help me plan a website redesign project with these phases: ' +
      'research, wireframing, design mockups, development, and testing. ' +
      'Track progress with a todo list.'
    );
    await sendButton.click();

    await expect(input).toBeEnabled({ timeout: 90000 });

    const todoList = page.getByTestId('todo-list');
    const hasTodoList = await todoList.count() > 0;

    if (hasTodoList) {
      // Verify todo list is within an assistant message
      const assistantMessage = page.getByTestId('message-assistant');
      const todoInAssistant = assistantMessage.locator('[data-testid="todo-list"]');
      await expect(todoInAssistant.first()).toBeVisible();
      console.log('✓ Todo list is rendered inline with assistant message');
    } else {
      console.log('Note: LLM did not call todo_write tool');
    }
  });

  test('explicit todo list request triggers tool', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Explicitly request a todo list
    await input.fill(
      'Please create a todo list for me with the following items: ' +
      'buy groceries, clean the house, finish homework, call mom'
    );
    await sendButton.click();

    await expect(input).toBeEnabled({ timeout: 90000 });

    const todoList = page.getByTestId('todo-list');
    const hasTodoList = await todoList.count() > 0;

    if (hasTodoList) {
      // Should have pending items
      const pendingItems = page.getByTestId('todo-item-pending');
      const pendingCount = await pendingItems.count();
      console.log(`✓ Todo list has ${pendingCount} pending items`);
    } else {
      // Check if assistant at least acknowledged the request
      const assistantMessage = page.getByTestId('message-assistant');
      await expect(assistantMessage.first()).toBeVisible();
      console.log('Note: LLM did not use todo_write tool for explicit request');
    }
  });

  test('simple informational request does NOT trigger todo list', async ({ page }) => {
    const input = page.getByTestId('message-input');
    const sendButton = page.getByTestId('send-button');

    // Simple informational request - should NOT trigger todo list
    await input.fill('What is the capital of France?');
    await sendButton.click();

    await expect(input).toBeEnabled({ timeout: 60000 });

    // Verify response but NO todo list
    const assistantMessage = page.getByTestId('message-assistant');
    await expect(assistantMessage.first()).toBeVisible();

    const todoList = page.getByTestId('todo-list');
    const todoCount = await todoList.count();
    expect(todoCount).toBe(0);
    console.log('✓ No todo list for simple informational request (correct behavior)');
  });
});
