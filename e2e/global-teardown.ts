async function globalTeardown() {
  console.log('\n🧹 E2E Test Teardown Starting...\n');

  // Note: We don't stop Supabase here by default
  // because you might want to inspect the database after tests
  // Uncomment the following if you want to stop Supabase after tests:
  //
  // execSync('npx supabase stop', { stdio: 'inherit' });
  // console.log('🛑 Local Supabase stopped');

  console.log('✅ E2E Test Teardown Complete\n');
  console.log('💡 Tip: Run `npm run supabase:stop` to stop local Supabase\n');
}

export default globalTeardown;
