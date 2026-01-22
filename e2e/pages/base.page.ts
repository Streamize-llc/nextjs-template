import { Page, Locator } from '@playwright/test';

/**
 * Base Page Object class that all page objects should extend.
 * Contains common methods and utilities for interacting with pages.
 */
export abstract class BasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Navigate to a specific path
   */
  async goto(path: string = '/') {
    await this.page.goto(path);
  }

  /**
   * Wait for page to be fully loaded
   */
  async waitForPageLoad() {
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Get the current page URL
   */
  getUrl(): string {
    return this.page.url();
  }

  /**
   * Get the current page title
   */
  async getTitle(): Promise<string> {
    return this.page.title();
  }

  /**
   * Wait for an element to be visible
   */
  async waitForElement(locator: Locator, timeout: number = 5000) {
    await locator.waitFor({ state: 'visible', timeout });
  }

  /**
   * Check if an element is visible
   */
  async isVisible(locator: Locator): Promise<boolean> {
    return locator.isVisible();
  }

  /**
   * Take a screenshot of the current page
   */
  async screenshot(name: string) {
    await this.page.screenshot({ path: `e2e/screenshots/${name}.png` });
  }
}
