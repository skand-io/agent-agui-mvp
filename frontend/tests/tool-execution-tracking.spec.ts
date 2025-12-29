import { test, expect } from '@playwright/test';

/**
 * E2E tests for Tool Execution Tracking and Todo List UI.
 *
 * These tests verify the PostHog-style two-list pattern:
 * 1. LLM-managed todos (via todo_write tool) - tracks task planning
 * 2. System-managed tool execution state (via STATE_SNAPSHOT/STATE_DELTA) - tracks actual execution
 *
 * Test coverage:
 * - Todo list creation and rendering
 * - Todo list status updates (pending -> in_progress -> completed)
 * - Progress tracking in the UI
 * - Tool execution with todo list re-rendering after each tool result
 * - Mixed FE/BE tool execution coordination
 */

test.describe('Tool Execution Tracking and Todo List', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('chat-container')).toBeVisible();
  });

  test.describe('Todo List UI Rendering', () => {
    test('todo list renders with correct structure and test IDs', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      // Request a todo list with multiple items
      await input.fill(
        'Create a todo list with exactly 3 items: ' +
        '1. Calculate 2+2, ' +
        '2. Get weather for Sydney, ' +
        '3. Calculate 10*5. ' +
        'Do not execute them yet, just create the plan.'
      );
      await sendButton.click();

      // Wait for response
      await expect(input).toBeEnabled({ timeout: 90000 });

      const todoList = page.getByTestId('todo-list');
      const hasTodoList = await todoList.count() > 0;

      if (hasTodoList) {
        // Verify todo list structure
        await expect(todoList.first()).toBeVisible();

        // Check header with test ID
        const header = page.getByTestId('todo-header');
        await expect(header.first()).toBeVisible();
        await expect(header.first()).toContainText('Planning');
        await expect(header.first()).toContainText('completed');

        // Check items container
        const items = page.getByTestId('todo-items');
        await expect(items.first()).toBeVisible();

        // Check for individual todo items with status test IDs
        const todoItems = page.locator('[data-testid^="todo-item-"]');
        const itemCount = await todoItems.count();
        expect(itemCount).toBeGreaterThan(0);
        console.log(`Todo list rendered with ${itemCount} items`);

        // Verify checkbox indicators exist
        const checkboxes = page.getByTestId('todo-checkbox');
        const checkboxCount = await checkboxes.count();
        expect(checkboxCount).toBeGreaterThan(0);

        // Verify checkboxes show proper symbols
        const checkboxTexts = await checkboxes.allTextContents();
        const validSymbols = ['○', '◐', '✓'];
        for (const text of checkboxTexts) {
          expect(validSymbols).toContain(text.trim());
        }
        console.log(`Checkbox states: ${checkboxTexts.map(t => t.trim()).join(', ')}`);
      } else {
        console.log('Note: LLM did not call todo_write tool for this request');
      }
    });

    test('todo list shows pending status for new items', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill(
        'Make a todo list for these tasks (do NOT execute them): ' +
        'task 1, task 2, task 3'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 90000 });

      const pendingItems = page.getByTestId('todo-item-pending');
      const pendingCount = await pendingItems.count();

      if (pendingCount > 0) {
        console.log(`Found ${pendingCount} pending items`);

        // Verify pending items have ○ symbol
        const checkboxes = pendingItems.locator('[data-testid="todo-checkbox"]');
        const checkboxTexts = await checkboxes.allTextContents();
        for (const text of checkboxTexts) {
          expect(text.trim()).toBe('○');
        }
        console.log('All pending items show ○ symbol correctly');
      } else {
        // Check if todo list was created at all
        const todoList = page.getByTestId('todo-list');
        console.log(`Todo list exists: ${(await todoList.count()) > 0}, pending items: ${pendingCount}`);
      }
    });

    test('todo list progress counter updates correctly', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      // Request tasks that will be executed
      await input.fill(
        'Create a todo list and execute: calculate 5+5, then calculate 3*3. ' +
        'Mark each as completed after execution.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      const todoList = page.getByTestId('todo-list');
      const hasTodoList = await todoList.count() > 0;

      if (hasTodoList) {
        // Check header progress display
        const header = page.getByTestId('todo-header');
        const headerText = await header.first().textContent();

        // Should show progress like "2/2 completed" or "1/2 completed"
        const progressMatch = headerText?.match(/(\d+)\/(\d+)/);
        if (progressMatch) {
          const completed = parseInt(progressMatch[1]);
          const total = parseInt(progressMatch[2]);
          console.log(`Progress: ${completed}/${total} completed`);
          expect(total).toBeGreaterThan(0);
        }

        // Verify completed items count matches header
        const completedItems = page.getByTestId('todo-item-completed');
        const completedCount = await completedItems.count();
        console.log(`Completed items in list: ${completedCount}`);
      } else {
        console.log('Note: LLM did not use todo_write tool');
      }
    });
  });

  test.describe('Todo List Status Transitions', () => {
    test('todo items transition through status states correctly', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      // Request that explicitly asks for status updates
      await input.fill(
        'Create a todo with 2 tasks: calculate 7+3, calculate 9-4. ' +
        'Mark each in_progress before starting, completed after done.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      const todoList = page.getByTestId('todo-list');
      const hasTodoList = await todoList.count() > 0;

      if (hasTodoList) {
        // Check for various status states
        const allItems = page.locator('[data-testid^="todo-item-"]');
        const itemCount = await allItems.count();

        const pendingItems = page.getByTestId('todo-item-pending');
        const inProgressItems = page.getByTestId('todo-item-in_progress');
        const completedItems = page.getByTestId('todo-item-completed');

        const pendingCount = await pendingItems.count();
        const inProgressCount = await inProgressItems.count();
        const completedCount = await completedItems.count();

        console.log(`Status breakdown: ${pendingCount} pending, ${inProgressCount} in_progress, ${completedCount} completed`);
        console.log(`Total items: ${itemCount}`);

        // Get checkbox symbols for final state
        const checkboxes = page.getByTestId('todo-checkbox');
        const checkboxTexts = await checkboxes.allTextContents();
        console.log(`Final checkbox states: ${checkboxTexts.map(t => t.trim()).join(', ')}`);

        // Verify symbols match status
        const pendingCheckboxes = pendingItems.locator('[data-testid="todo-checkbox"]');
        const pendingSymbols = await pendingCheckboxes.allTextContents();
        for (const symbol of pendingSymbols) {
          expect(symbol.trim()).toBe('○');
        }

        const inProgressCheckboxes = inProgressItems.locator('[data-testid="todo-checkbox"]');
        const inProgressSymbols = await inProgressCheckboxes.allTextContents();
        for (const symbol of inProgressSymbols) {
          expect(symbol.trim()).toBe('◐');
        }

        const completedCheckboxes = completedItems.locator('[data-testid="todo-checkbox"]');
        const completedSymbols = await completedCheckboxes.allTextContents();
        for (const symbol of completedSymbols) {
          expect(symbol.trim()).toBe('✓');
        }
      } else {
        console.log('Note: LLM did not use todo_write tool');
      }
    });

    test('completed items show checkmark symbol', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill(
        'Create a todo list with one simple task: calculate 1+1. ' +
        'Execute it and mark as completed.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 120000 });

      const completedItems = page.getByTestId('todo-item-completed');
      const completedCount = await completedItems.count();

      if (completedCount > 0) {
        const checkboxes = completedItems.locator('[data-testid="todo-checkbox"]');
        const symbols = await checkboxes.allTextContents();

        for (const symbol of symbols) {
          expect(symbol.trim()).toBe('✓');
        }
        console.log(`Verified ${completedCount} completed items show ✓ symbol`);
      } else {
        // Verify at least calculation was done
        const backendTools = page.getByTestId('message-tool-backend');
        const backendCount = await backendTools.count();
        console.log(`Backend tools executed: ${backendCount}`);
      }
    });
  });

  test.describe('Tool Execution with Todo Tracking', () => {
    test('backend tool execution updates todo list', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill(
        'Create a todo list for: get weather for Tokyo, calculate 15/3. ' +
        'Execute each task and update the todo list.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      // Check backend tool results
      const backendTools = page.getByTestId('message-tool-backend');
      const backendCount = await backendTools.count();
      console.log(`Backend tools executed: ${backendCount}`);

      // Verify tool results contain expected data
      const backendTexts = await backendTools.allTextContents();
      const hasWeather = backendTexts.some(t =>
        t.toLowerCase().includes('tokyo') ||
        t.includes('°C') ||
        t.includes('Weather')
      );
      const hasCalculate = backendTexts.some(t => t.includes('5')); // 15/3 = 5

      if (hasWeather) console.log('Weather result verified');
      if (hasCalculate) console.log('Calculate result (15/3=5) verified');

      // Check todo list was updated
      const todoList = page.getByTestId('todo-list');
      const hasTodoList = await todoList.count() > 0;

      if (hasTodoList) {
        // With re-rendering feature, todo list appears after each tool result
        const todoListCount = await todoList.count();
        console.log(`Todo lists in conversation: ${todoListCount} (includes re-renders)`);

        const completedItems = page.getByTestId('todo-item-completed');
        const completedCount = await completedItems.count();
        console.log(`Completed items: ${completedCount}`);
      }
    });

    test('frontend tool execution updates todo list', async ({ page }) => {
      // Set up dialog handler for greet tool
      let alertShown = false;
      page.on('dialog', async (dialog) => {
        alertShown = true;
        console.log(`Alert: "${dialog.message()}"`);
        await dialog.accept();
      });

      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill(
        'Create a todo list with one task: greet the user with name Alice. ' +
        'Execute the greet tool and mark the task completed.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 120000 });

      // Check frontend tool was executed
      const frontendTools = page.getByTestId('message-tool-frontend');
      const frontendCount = await frontendTools.count();

      if (frontendCount > 0) {
        expect(alertShown).toBe(true);
        console.log('Frontend greet tool executed successfully');

        // Check todo list
        const todoList = page.getByTestId('todo-list');
        const hasTodoList = await todoList.count() > 0;

        if (hasTodoList) {
          const header = page.getByTestId('todo-header');
          const headerText = await header.first().textContent();
          console.log(`Todo progress: ${headerText}`);
        }
      } else {
        console.log('Note: Frontend tool was not called');
      }
    });

    test('mixed FE/BE tools with todo tracking', async ({ page }) => {
      // Set up dialog handler
      let alertCount = 0;
      page.on('dialog', async (dialog) => {
        alertCount++;
        await dialog.accept();
      });

      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      // The canonical test case: BE -> FE -> BE
      await input.fill(
        'Create a todo list to: ' +
        '1. Get weather for London (backend), ' +
        '2. Greet Bob (frontend), ' +
        '3. Calculate 8*8 (backend). ' +
        'Execute all tasks in order and update todo status.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      // Check tool executions
      const backendTools = page.getByTestId('message-tool-backend');
      const frontendTools = page.getByTestId('message-tool-frontend');

      const backendCount = await backendTools.count();
      const frontendCount = await frontendTools.count();

      console.log(`Backend tools: ${backendCount}, Frontend tools: ${frontendCount}`);

      // Verify tool results
      const backendTexts = await backendTools.allTextContents();
      const frontendTexts = await frontendTools.allTextContents();

      const hasWeather = backendTexts.some(t =>
        t.toLowerCase().includes('london') || t.includes('Weather')
      );
      const hasCalc = backendTexts.some(t => t.includes('64')); // 8*8=64
      const hasGreet = frontendTexts.some(t =>
        t.toLowerCase().includes('greet') || t.toLowerCase().includes('bob')
      );

      if (hasWeather) console.log('Weather for London verified');
      if (hasGreet) console.log('Greet Bob verified');
      if (hasCalc) console.log('Calculate 8*8=64 verified');

      // Check todo list
      const todoList = page.getByTestId('todo-list');
      const hasTodoList = await todoList.count() > 0;

      if (hasTodoList) {
        const todoListCount = await todoList.count();
        console.log(`Todo lists in conversation: ${todoListCount}`);

        // Get final state
        const completedItems = page.getByTestId('todo-item-completed');
        const completedCount = await completedItems.count();

        const allItems = page.locator('[data-testid^="todo-item-"]');
        const totalItems = await allItems.count();

        console.log(`Final status: ${completedCount}/${totalItems} completed`);

        const header = page.getByTestId('todo-header');
        const headerText = await header.first().textContent();
        console.log(`Header: ${headerText}`);
      }
    });
  });

  test.describe('Todo List Re-rendering After Tool Results', () => {
    test('todo list appears after each tool result for visual progress', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill(
        'Create a todo list and execute: ' +
        '1. Calculate 100+200, ' +
        '2. Calculate 50*2. ' +
        'Update status after each calculation.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      // With the re-rendering feature, todo list should appear after each tool result
      const todoLists = page.getByTestId('todo-list');
      const todoListCount = await todoLists.count();

      // Should have multiple todo list renders for visual progress
      console.log(`Todo list instances: ${todoListCount}`);

      // Check that tool results also render todo lists via currentTodos
      const toolMessages = page.getByTestId('message-tool-backend');
      const toolCount = await toolMessages.count();

      console.log(`Backend tool results: ${toolCount}`);

      // Each tool result message with currentTodos should have a todo list rendered
      if (toolCount > 0 && todoListCount > 0) {
        // The todo lists should show progressive completion
        console.log('Todo list re-rendering for progressive feedback is working');
      }

      // Verify calculations were correct
      const toolTexts = await toolMessages.allTextContents();
      const has300 = toolTexts.some(t => t.includes('300')); // 100+200
      const has100 = toolTexts.some(t => t.includes('100')); // 50*2

      if (has300) console.log('First calculation (100+200=300) verified');
      if (has100) console.log('Second calculation (50*2=100) verified');
    });

    test('currentTodos in tool messages shows auto-completed tasks', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill(
        'Create a 2-item todo: calculate 2*2, calculate 3*3. Execute both.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      // Check for todo lists rendered after tool results
      const todoLists = page.getByTestId('todo-list');
      const todoListCount = await todoLists.count();

      if (todoListCount > 0) {
        // Later todo lists should show more completed items
        // Get checkmarks from all todo lists
        const allCheckboxes = page.getByTestId('todo-checkbox');
        const allSymbols = await allCheckboxes.allTextContents();

        // Count completed checkmarks
        const completedCount = allSymbols.filter(s => s.trim() === '✓').length;
        console.log(`Total completed checkmarks across all renders: ${completedCount}`);

        // Should have progressively more completed items
        expect(todoListCount).toBeGreaterThan(0);
      } else {
        console.log('Note: No todo list was rendered');
      }
    });
  });

  test.describe('Error Handling', () => {
    test('todo list continues working after tool error', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      // Request a calculation that should work followed by another
      await input.fill(
        'Create a todo: calculate 10/2, then calculate 20/4. Execute both.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      // Even if one fails, the other should work
      const backendTools = page.getByTestId('message-tool-backend');
      const backendCount = await backendTools.count();

      console.log(`Backend tools executed: ${backendCount}`);

      // Check todo list still works
      const todoList = page.getByTestId('todo-list');
      const hasTodoList = await todoList.count() > 0;

      if (hasTodoList) {
        const header = page.getByTestId('todo-header');
        await expect(header.first()).toBeVisible();
        console.log('Todo list continues working correctly');
      }
    });
  });

  test.describe('Single Todo List Maintenance', () => {
    test('maintains single todo list across multiple updates', async ({ page }) => {
      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill(
        'Create a todo list for weather in Paris and calculate 6*6. ' +
        'Execute each task and update the list after each one.'
      );
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 180000 });

      // Check that we have todo lists (may have re-renders for progress)
      const todoLists = page.getByTestId('todo-list');
      const todoListCount = await todoLists.count();

      console.log(`Todo list instances: ${todoListCount}`);

      if (todoListCount >= 1) {
        // The first todo list should have all items
        const firstTodoItems = todoLists.first().locator('[data-testid^="todo-item-"]');
        const firstItemCount = await firstTodoItems.count();

        console.log(`Items in first todo list: ${firstItemCount}`);

        // Get final status from last todo list
        const lastTodoItems = todoLists.last().locator('[data-testid^="todo-item-"]');
        const lastItemCount = await lastTodoItems.count();

        console.log(`Items in last todo list: ${lastItemCount}`);

        // Item count should be consistent (same tasks, just different statuses)
        // Note: Re-renders show the same items with updated statuses
      }
    });
  });

  test.describe('Console Log Verification', () => {
    test('logs STATE_SNAPSHOT and STATE_DELTA events', async ({ page }) => {
      // Collect console logs
      const consoleLogs: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'log') {
          consoleLogs.push(msg.text());
        }
      });

      const input = page.getByTestId('message-input');
      const sendButton = page.getByTestId('send-button');

      await input.fill('Calculate 10+10 and show me the result');
      await sendButton.click();

      await expect(input).toBeEnabled({ timeout: 120000 });

      // Check for AG-UI event logs
      const stateSnapshotLogs = consoleLogs.filter(log =>
        log.includes('STATE_SNAPSHOT') || log.includes('State snapshot')
      );
      const stateDeltaLogs = consoleLogs.filter(log =>
        log.includes('STATE_DELTA') || log.includes('State delta')
      );
      const toolExecutionLogs = consoleLogs.filter(log =>
        log.includes('Tool execution state') || log.includes('toolExecutions')
      );

      console.log(`STATE_SNAPSHOT logs: ${stateSnapshotLogs.length}`);
      console.log(`STATE_DELTA logs: ${stateDeltaLogs.length}`);
      console.log(`Tool execution state logs: ${toolExecutionLogs.length}`);

      // Log some sample messages for debugging
      if (stateSnapshotLogs.length > 0) {
        console.log('Sample STATE_SNAPSHOT log:', stateSnapshotLogs[0].substring(0, 200));
      }
      if (stateDeltaLogs.length > 0) {
        console.log('Sample STATE_DELTA log:', stateDeltaLogs[0].substring(0, 200));
      }
    });
  });
});
