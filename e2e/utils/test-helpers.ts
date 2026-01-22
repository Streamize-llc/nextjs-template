import { Page } from '@playwright/test';

/**
 * Test helper utilities
 *
 * Note: For test data creation (users, records), use the `testData` fixture instead.
 * These helpers are for browser/page utilities only.
 */

/**
 * Wait for a specific amount of time
 */
export async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clear all cookies and local storage
 */
export async function clearBrowserState(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

/**
 * Wait for network to be idle
 */
export async function waitForNetworkIdle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

/**
 * Get all console messages from page
 */
export function captureConsoleLogs(page: Page): string[] {
  const logs: string[] = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  return logs;
}
