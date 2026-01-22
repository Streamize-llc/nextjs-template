import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

/**
 * Home Page Object
 * Represents the main landing page of the application
 */
export class HomePage extends BasePage {
  // Locators
  readonly heading: Locator;
  readonly mainContent: Locator;

  constructor(page: Page) {
    super(page);

    // Define locators - update these based on your actual page structure
    this.heading = page.locator('h1').first();
    this.mainContent = page.locator('main');
  }

  /**
   * Navigate to home page
   */
  async goto() {
    await super.goto('/');
  }

  /**
   * Get the main heading text
   */
  async getHeadingText(): Promise<string | null> {
    return this.heading.textContent();
  }

  /**
   * Check if the page is loaded correctly
   */
  async isLoaded(): Promise<boolean> {
    await this.waitForPageLoad();
    return this.mainContent.isVisible();
  }
}
