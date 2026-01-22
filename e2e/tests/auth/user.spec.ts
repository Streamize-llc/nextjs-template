import { test, expect } from '../../fixtures';

/**
 * Example: Auth tests demonstrating test data isolation
 *
 * Each test:
 * 1. Creates its own test data via `testData` fixture
 * 2. Runs the test
 * 3. Automatically cleans up after itself
 */
test.describe('User Management', () => {
  test('can create a test user', async ({ testData }) => {
    // Arrange: Create test user (auto-cleaned after test)
    const user = await testData.createUser({
      email: testData.generateEmail('create-test'),
    });

    // Assert
    expect(user).toBeDefined();
    expect(user.email).toContain('create-test');
    expect(user.id).toBeDefined();

    // No manual cleanup needed - testData.cleanup() runs automatically
  });

  test('can create user with custom metadata', async ({ testData }) => {
    // Arrange
    const user = await testData.createUser({
      metadata: {
        name: 'Test User',
        role: 'tester',
      },
    });

    // Assert
    expect(user.user_metadata).toEqual({
      name: 'Test User',
      role: 'tester',
    });
  });

  test('users are isolated between tests', async ({ testData, supabaseAdmin }) => {
    // This test creates a user with a specific email
    const uniqueEmail = `isolated-${Date.now()}@test.local`;
    await testData.createUser({ email: uniqueEmail });

    // Verify user exists
    const { data } = await supabaseAdmin.auth.admin.listUsers();
    const found = data.users.find((u) => u.email === uniqueEmail);
    expect(found).toBeDefined();

    // After this test, the user will be automatically deleted
    // So the next test won't see this user
  });
});

test.describe('User with Page Interaction', () => {
  test('authenticated user can access protected page', async ({
    page,
    testData,
  }) => {
    // Arrange: Create test user
    const password = testData.generatePassword();
    const user = await testData.createUser({ password });

    // This is an example - actual implementation depends on your auth flow
    // You would typically:
    // 1. Navigate to login page
    // 2. Fill in credentials
    // 3. Submit form
    // 4. Verify redirect to protected page

    // Example (pseudo-code):
    // await page.goto('/login');
    // await page.fill('[name="email"]', user.email!);
    // await page.fill('[name="password"]', password);
    // await page.click('button[type="submit"]');
    // await expect(page).toHaveURL('/dashboard');

    // For now, just verify user was created
    expect(user.email).toBeDefined();
  });
});
