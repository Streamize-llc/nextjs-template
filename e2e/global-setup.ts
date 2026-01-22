import { execSync, spawnSync } from 'child_process';

/**
 * Global setup for E2E tests
 *
 * Strategy: Each test manages its own data (create/cleanup)
 * - No db reset here (tests are responsible for their own data)
 * - Only ensures Supabase is running with migrations applied
 */
async function globalSetup() {
  console.log('\n🚀 E2E Test Setup Starting...\n');

  // Check if Docker is running
  const dockerCheck = spawnSync('docker', ['info'], { stdio: 'pipe' });
  if (dockerCheck.status !== 0) {
    throw new Error(
      '❌ Docker is not running. Please start Docker and try again.\n' +
        '   E2E tests require Docker for local Supabase.'
    );
  }

  try {
    // Check if Supabase is already running
    const statusResult = spawnSync('npx', ['supabase', 'status'], {
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    const isRunning =
      statusResult.status === 0 && statusResult.stdout?.includes('API URL');

    if (isRunning) {
      console.log('✅ Supabase is already running');

      // Apply any pending migrations (non-destructive)
      console.log('📦 Applying pending migrations...');
      execSync('npx supabase migration up', {
        stdio: 'inherit',
        timeout: 60000,
      });
    } else {
      // Start Supabase (this also applies migrations)
      console.log('📦 Starting local Supabase...');
      execSync('npx supabase start', {
        stdio: 'inherit',
        timeout: 120000,
      });
    }

    console.log('\n✅ E2E Test Setup Complete\n');
    console.log('💡 Each test will create and cleanup its own data\n');
  } catch (error) {
    console.error('\n❌ E2E Setup Failed\n');
    throw error;
  }
}

export default globalSetup;
