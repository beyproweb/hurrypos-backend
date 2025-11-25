#!/usr/bin/env node
/**
 * Run all migrations on PRODUCTION database
 * ⚠️ USE WITH CAUTION - This modifies the production database!
 * 
 * Usage:
 *   DATABASE_URL=postgresql://... node run-migrations-production.js
 * 
 * Or with the production URL directly:
 *   node run-migrations-production.js
 */

// Set production database URL before loading db.js
process.env.DATABASE_URL = 'postgresql://beypro_user:oIL9KlkjpGYhobN8PBb0ADha1eC6y4nQ@dpg-d22jfm95pdvs7392if0g-a.frankfurt-postgres.render.com/beypro';

const { spawn } = require('child_process');
const path = require('path');

async function runMigrations() {
  console.log('🚀 Running migrations on PRODUCTION database...\n');
  console.log('⚠️  Database:', process.env.DATABASE_URL.split('@')[1]); // Hide credentials
  console.log('');

  const migrations = [
    'migrations/add_coordinates_to_orders.js',
    'migrations/update_restaurant_coords.js',
    'migrations/fix_existing_orders.js'
  ];

  for (const migration of migrations) {
    console.log(`\n📋 Running: ${migration}`);
    
    await new Promise((resolve, reject) => {
      const child = spawn('node', [migration], {
        env: { ...process.env },
        stdio: 'inherit'
      });

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Migration ${migration} failed with code ${code}`));
        } else {
          resolve();
        }
      });
    });
  }

  console.log('\n✅ All migrations completed on production database!');
}

runMigrations().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
