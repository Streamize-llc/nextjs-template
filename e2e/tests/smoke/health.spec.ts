import { test, expect } from '../../fixtures';

test.describe('Smoke Tests', () => {
  test('homepage loads successfully', async ({ homePage }) => {
    await homePage.goto();

    const isLoaded = await homePage.isLoaded();
    expect(isLoaded).toBe(true);
  });

  test('page has correct title', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/.+/);
  });

  test('no console errors on page load', async ({ page }) => {
    const consoleErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Filter out known acceptable errors
    const criticalErrors = consoleErrors.filter(
      (error) => !error.includes('favicon')
    );

    expect(criticalErrors).toHaveLength(0);
  });
});
