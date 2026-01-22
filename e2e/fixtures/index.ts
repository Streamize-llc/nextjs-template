import { test as base } from '@playwright/test';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { HomePage } from '../pages/home.page';
import { TestDataFactory } from '../utils/test-data';

/**
 * Custom fixtures for E2E tests
 *
 * Key principle: Each test creates its own data and cleans up after itself
 * - Use `testData` fixture to create test data
 * - Cleanup is automatic after each test
 */
type Fixtures = {
  // Page Objects
  homePage: HomePage;

  // Supabase admin client (service role)
  supabaseAdmin: SupabaseClient;

  // Test data factory with automatic cleanup
  testData: TestDataFactory;
};

export const test = base.extend<Fixtures>({
  // Page Object fixtures
  homePage: async ({ page }, use) => {
    const homePage = new HomePage(page);
    await use(homePage);
  },

  // Supabase admin client for test data management
  supabaseAdmin: async ({}, use) => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error(
        'Missing Supabase environment variables.\n' +
          'Ensure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env.test'
      );
    }

    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    await use(client);
  },

  // Test data factory with automatic cleanup
  testData: async ({ supabaseAdmin }, use) => {
    const factory = new TestDataFactory(supabaseAdmin);

    // Provide factory to test
    await use(factory);

    // Automatic cleanup after test completes
    await factory.cleanup();
  },
});

export { expect } from '@playwright/test';
