import { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Factory for creating and managing test data
 * Each test should create its own data and clean up after itself
 */
export class TestDataFactory {
  private createdUsers: string[] = [];
  private cleanupCallbacks: (() => Promise<void>)[] = [];

  constructor(private supabase: SupabaseClient) {}

  /**
   * Generate a unique test email
   */
  generateEmail(prefix = 'test'): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `${prefix}-${timestamp}-${random}@test.local`;
  }

  /**
   * Generate a secure test password
   */
  generatePassword(): string {
    return `TestPass_${Math.random().toString(36).substring(2, 10)}!`;
  }

  /**
   * Create a test user
   */
  async createUser(options?: {
    email?: string;
    password?: string;
    metadata?: Record<string, unknown>;
  }): Promise<User> {
    const email = options?.email ?? this.generateEmail();
    const password = options?.password ?? this.generatePassword();

    const { data, error } = await this.supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: options?.metadata,
    });

    if (error) {
      throw new Error(`Failed to create test user: ${error.message}`);
    }

    if (!data.user) {
      throw new Error('User creation returned no user');
    }

    // Track for cleanup
    this.createdUsers.push(data.user.id);

    return data.user;
  }

  /**
   * Create test data in a table
   */
  async createRecord<T extends Record<string, unknown>>(
    table: string,
    data: T
  ): Promise<T & { id: string }> {
    const { data: record, error } = await this.supabase
      .from(table)
      .insert(data)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create record in ${table}: ${error.message}`);
    }

    // Register cleanup callback
    this.cleanupCallbacks.push(async () => {
      await this.supabase.from(table).delete().eq('id', record.id);
    });

    return record as T & { id: string };
  }

  /**
   * Register a custom cleanup callback
   */
  onCleanup(callback: () => Promise<void>): void {
    this.cleanupCallbacks.push(callback);
  }

  /**
   * Clean up all created test data
   * Called automatically after each test via fixture
   */
  async cleanup(): Promise<void> {
    // Run custom cleanup callbacks in reverse order (LIFO)
    for (const callback of this.cleanupCallbacks.reverse()) {
      try {
        await callback();
      } catch (error) {
        console.warn('Cleanup callback failed:', error);
      }
    }
    this.cleanupCallbacks = [];

    // Delete created users
    for (const userId of this.createdUsers.reverse()) {
      try {
        await this.supabase.auth.admin.deleteUser(userId);
      } catch (error) {
        console.warn(`Failed to delete test user ${userId}:`, error);
      }
    }
    this.createdUsers = [];
  }
}
