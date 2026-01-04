/**
 * Debug test to see console output
 */

import { test, expect } from '@playwright/test';

test('debug console logs', async ({ page }) => {
  const consoleLogs: string[] = [];

  page.on('console', (msg) => {
    const text = msg.text();
    consoleLogs.push(text);
    console.log('BROWSER:', text);
  });

  page.on('pageerror', (error) => {
    console.log('PAGE ERROR:', error.message);
  });

  await page.goto('http://localhost:3000');

  const input = page.getByTestId('message-input');
  await expect(input).toBeVisible();

  console.log('\n=== Sending message ===\n');
  await input.fill('Get the weather in Tokyo and greet Alice');
  await page.getByTestId('send-button').click();

  // Wait a bit to see events
  await page.waitForTimeout(5000);

  console.log('\n=== Console Logs ===');
  console.log('Total logs:', consoleLogs.length);

  // Check if isLoading is still true
  const isDisabled = await input.isDisabled();
  console.log('Input disabled:', isDisabled);

  // Print all event types found
  const eventTypes = new Set<string>();
  for (const log of consoleLogs) {
    const match = log.match(/^[🚀🏁❌▶️⏸️📊💬🔧⚡🧠🎯]\s+(\w+)/);
    if (match) {
      eventTypes.add(match[1]);
    }
  }

  console.log('\nEvent types found:', Array.from(eventTypes).sort());
  console.log('\n=== Last 20 logs ===');
  consoleLogs.slice(-20).forEach(log => console.log(log));
});
